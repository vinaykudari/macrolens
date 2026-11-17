"""Web Push VAPID key management, delivery, and 3/day meal reminder scheduler."""

from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import MealEntry, PushSubscription, User

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
except ImportError:  # pragma: no cover - optional when VAPID keys are preconfigured
    serialization = None  # type: ignore[assignment]
    ec = None  # type: ignore[assignment]

try:
    from pywebpush import WebPushException, webpush
except ImportError:  # pragma: no cover - allows importing/testing with mocked webpush
    webpush = None  # type: ignore[assignment]

    class WebPushException(Exception):  # type: ignore[no-redef]
        """Fallback WebPushException when pywebpush is not installed."""

        def __init__(self, message: str = "", response: Any = None) -> None:
            super().__init__(message)
            self.response = response


logger = logging.getLogger(__name__)

REMINDER_WINDOW_MINUTES = 15
REMINDER_SLOTS: tuple[tuple[str, str, str, str], ...] = (
    ("breakfast", "breakfast_time", "last_breakfast_sent_date", "Breakfast"),
    ("lunch", "lunch_time", "last_lunch_sent_date", "Lunch"),
    ("dinner", "dinner_time", "last_dinner_sent_date", "Dinner"),
)


def _generate_vapid_keypair() -> tuple[str, str]:
    """Generate a P-256 ECDSA VAPID keypair (uncompressed 65B pubkey, PKCS8 DER privkey)."""
    if ec is None or serialization is None:
        raise RuntimeError("cryptography package is required to generate VAPID keys")

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    private_der = private_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_b64 = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode("ascii")
    private_b64 = base64.urlsafe_b64encode(private_der).rstrip(b"=").decode("ascii")
    return public_b64, private_b64


def get_or_create_vapid_keys(keys_file: Path | None = None) -> tuple[str, str]:
    """Return configured VAPID keys or load/persist an auto-generated P-256 keypair."""
    configured_pub = os.getenv("VAPID_PUBLIC_KEY", "").strip() or settings.VAPID_PUBLIC_KEY.strip()
    configured_priv = os.getenv("VAPID_PRIVATE_KEY", "").strip() or settings.VAPID_PRIVATE_KEY.strip()
    if configured_pub and configured_priv:
        return configured_pub, configured_priv

    target_path = keys_file or settings.effective_vapid_keys_path
    if target_path.exists():
        try:
            saved = json.loads(target_path.read_text(encoding="utf-8"))
            saved_pub = str(saved.get("public_key") or "").strip()
            saved_priv = str(saved.get("private_key") or "").strip()
            if saved_pub and saved_priv:
                return saved_pub, saved_priv
        except (OSError, ValueError, TypeError):
            logger.warning("Failed to read persisted VAPID keys at %s; regenerating", target_path)

    public_b64, private_b64 = _generate_vapid_keypair()
    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(
            json.dumps({"public_key": public_b64, "private_key": private_b64}, indent=2),
            encoding="utf-8",
        )
        try:
            os.chmod(target_path, 0o600)
        except OSError:
            pass
    except OSError:
        logger.warning("Could not persist generated VAPID keys to %s", target_path)

    return public_b64, private_b64


def send_push_to_user(
    db: Session,
    user: User,
    title: str,
    body: str,
    url: str = "/?action=snap",
    tag: str = "meal-reminder",
) -> tuple[int, int]:
    """Send a Web Push notification to all active subscriptions for user, pruning 404/410s."""
    subscriptions = db.scalars(
        select(PushSubscription).where(PushSubscription.user_id == user.id)
    ).all()
    if not subscriptions:
        return 0, 0

    if webpush is None:
        raise RuntimeError("pywebpush package is not installed on the server")

    _, vapid_private_key = get_or_create_vapid_keys()
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})

    sent = 0
    failed = 0
    pruned = False

    for sub in subscriptions:
        subscription_info = {
            "endpoint": sub.endpoint,
            "keys": {
                "p256dh": sub.p256dh,
                "auth": sub.auth,
            },
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": settings.VAPID_SUBJECT},
            )
            sent += 1
        except WebPushException as exc:
            failed += 1
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code in (404, 410):
                db.delete(sub)
                pruned = True
            else:
                logger.warning("Web Push failed for subscription %s: %s", sub.id, exc)
        except Exception as exc:
            failed += 1
            logger.warning("Unexpected Web Push error for subscription %s: %s", sub.id, exc)

    if pruned:
        db.flush()
        remaining = int(
            db.scalar(
                select(func.count(PushSubscription.id)).where(PushSubscription.user_id == user.id)
            )
            or 0
        )
        if remaining == 0:
            user.notifications_enabled = False
            db.add(user)
        db.commit()

    return sent, failed


def _parse_hhmm_to_minutes(hhmm: str) -> int | None:
    parts = (hhmm or "").strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute


def _safe_zoneinfo(tz_name: str | None) -> ZoneInfo | timezone:
    cleaned = (tz_name or "").strip() or "UTC"
    try:
        return ZoneInfo(cleaned)
    except (ZoneInfoNotFoundError, KeyError, ValueError):
        return timezone.utc


def _user_consumed_for_local_day(
    db: Session,
    user_id: int,
    local_day: Any,
    tz: ZoneInfo | timezone,
) -> tuple[float, float]:
    day_start = datetime(local_day.year, local_day.month, local_day.day, 0, 0, 0, tzinfo=tz)
    day_end = day_start + timedelta(days=1)
    row = db.execute(
        select(
            func.coalesce(func.sum(MealEntry.calories), 0.0),
            func.coalesce(func.sum(MealEntry.protein_g), 0.0),
        ).where(
            MealEntry.user_id == user_id,
            MealEntry.logged_at >= day_start.astimezone(timezone.utc),
            MealEntry.logged_at < day_end.astimezone(timezone.utc),
        )
    ).one()
    return float(row[0] or 0.0), float(row[1] or 0.0)


def dispatch_due_reminders(db: Session, now_utc: datetime | None = None) -> int:
    """Check enabled users and send up to 3 daily reminders (Breakfast, Lunch, Dinner)."""
    current_utc = now_utc or datetime.now(timezone.utc)
    if current_utc.tzinfo is None:
        current_utc = current_utc.replace(tzinfo=timezone.utc)
    else:
        current_utc = current_utc.astimezone(timezone.utc)

    users = db.scalars(
        select(User).where(
            User.notifications_enabled.is_(True),
            User.push_subscriptions.any(),
        )
    ).all()

    total_sent = 0

    for user in users:
        tz = _safe_zoneinfo(user.reminder_timezone)
        local_now = current_utc.astimezone(tz)
        local_today = local_now.date()
        local_today_str = local_today.isoformat()
        current_minutes = local_now.hour * 60 + local_now.minute

        consumed_cache: tuple[float, float] | None = None

        for slot_key, time_attr, sent_date_attr, label in REMINDER_SLOTS:
            scheduled_minutes = _parse_hhmm_to_minutes(getattr(user, time_attr, ""))
            if scheduled_minutes is None:
                continue
            if not (scheduled_minutes <= current_minutes < scheduled_minutes + REMINDER_WINDOW_MINUTES):
                continue
            if getattr(user, sent_date_attr) == local_today_str:
                continue

            if consumed_cache is None:
                consumed_cache = _user_consumed_for_local_day(db, user.id, local_today, tz)
            consumed_cal, consumed_pro = consumed_cache
            rem_cal = round(user.target_calories - consumed_cal)
            rem_pro = round(user.target_protein_g - consumed_pro)

            if rem_cal > 0 or rem_pro > 0:
                body = (
                    f"Snap a quick photo or describe your meal. "
                    f"Remaining today: {max(0, rem_cal)} kcal, {max(0, rem_pro)}g protein."
                )
            else:
                body = (
                    f"Snap a quick photo or describe your meal to keep today's log complete "
                    f"({round(consumed_cal)} / {round(user.target_calories)} kcal)."
                )

            try:
                sent, _ = send_push_to_user(
                    db,
                    user,
                    title=f"Time to log {label}!",
                    body=body,
                    url="/?action=snap",
                    tag=f"meal-reminder-{slot_key}",
                )
            except Exception:
                logger.exception("Failed sending %s reminder to user %s", slot_key, user.id)
                continue

            if sent > 0:
                setattr(user, sent_date_attr, local_today_str)
                db.add(user)
                db.commit()
                total_sent += sent

    return total_sent
