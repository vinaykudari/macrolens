"""FastAPI application and API routes for the Macro Tracker PWA backend."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import date as date_type
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import ValidationError

from app.auth import create_access_token, get_current_user, hash_pin, verify_pin
from app.calibration import calibrate_targets, evaluate_daily_status
from app.config import settings
from app.database import SessionLocal, get_db, init_db
from app.gemini_service import (
    analyze_meal_photo,
    analyze_meal_text,
    detect_audio_mime_type,
    detect_image_mime_type,
    refine_meal_from_text,
    transcribe_meal_audio,
)
from app.models import MealEntry, PhotoSaveRequest, PushSubscription, User
from app.photo_processing import compress_photo
from app.notification_service import dispatch_due_reminders, get_or_create_vapid_keys, send_push_to_user
from app.schemas import (
    AudioTranscribeResponse,
    AuthResponse,
    ConfigResponse,
    ConfigUpdateRequest,
    DailyDashboardResponse,
    DailyStatus,
    DashboardHistoryDay,
    DashboardHistoryResponse,
    DashboardHistorySummary,
    DeleteMealResponse,
    LoginRequest,
    LogoutResponse,
    MacroTargets,
    MacroTotals,
    MealAnalysisResponse,
    MealCreateRequest,
    MealItem,
    MealRefineRequest,
    MealResponse,
    MealTextAnalyzeRequest,
    MealUpdateRequest,
    NotificationSettings,
    PaginatedMealsResponse,
    PushSubscribeRequest,
    PushTestResponse,
    PushUnsubscribeRequest,
    SignupRequest,
    UserProfile,
    UserResponse,
    VapidPublicKeyResponse,
)

MAX_IMAGE_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MiB for Gemini analysis
MAX_STORED_PHOTO_BYTES = 8 * 1024 * 1024  # 8 MiB for stored meal photos
MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MiB for voice dictation audio
REMINDER_TICK_SECONDS = 30.0

logger = logging.getLogger(__name__)


def _run_reminder_tick() -> None:
    """Execute one synchronous reminder dispatch cycle against a dedicated DB session."""
    db = SessionLocal()
    try:
        dispatch_due_reminders(db)
    finally:
        db.close()


async def _reminder_scheduler_loop(stop_event: asyncio.Event) -> None:
    """Background loop ticking every 30s to dispatch due meal reminders."""
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=REMINDER_TICK_SECONDS)
            break
        except asyncio.TimeoutError:
            pass
        try:
            await asyncio.to_thread(_run_reminder_tick)
        except Exception:
            logger.exception("Error during meal reminder scheduler tick")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Initialize database tables on startup and manage background reminder scheduler."""
    init_db()
    stop_event = asyncio.Event()
    scheduler_task = asyncio.create_task(_reminder_scheduler_loop(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        scheduler_task.cancel()
        await asyncio.gather(scheduler_task, return_exceptions=True)


app = FastAPI(
    title="Macro Tracker API",
    version="1.0.0",
    description="Calorie & macro tracking backend with Gemini scale-calibrated photo analysis.",
    lifespan=lifespan,
)

_cors_origins = settings.cors_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials="*" not in _cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _local_day_to_utc_range(target_date: date_type, tz_offset_minutes: int, tz_name: str | None = None) -> tuple[datetime, datetime]:
    """Convert a local calendar day [00:00, 24:00) using JS getTimezoneOffset() minutes to UTC."""
    if tz_name:
        try:
            zone = ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(status_code=422, detail="Invalid timezone")
        start = datetime(target_date.year, target_date.month, target_date.day, tzinfo=zone)
        next_day = target_date + timedelta(days=1)
        end = datetime(next_day.year, next_day.month, next_day.day, tzinfo=zone)
        return start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    local_midnight = datetime(target_date.year, target_date.month, target_date.day, 0, 0, 0, tzinfo=timezone.utc)
    utc_start = local_midnight + timedelta(minutes=tz_offset_minutes)
    utc_end = utc_start + timedelta(days=1)
    return utc_start, utc_end


def _resolve_local_date(target_date: date_type | None, tz_offset_minutes: int) -> date_type:
    if target_date is not None:
        return target_date
    local_now = datetime.now(timezone.utc) - timedelta(minutes=tz_offset_minutes)
    return local_now.date()


def _user_profile_schema(user: User) -> UserProfile:
    return UserProfile(
        height_cm=user.height_cm,
        weight_kg=user.weight_kg,
        age=user.age,
        sex=user.sex,  # type: ignore[arg-type]
        activity_level=user.activity_level,  # type: ignore[arg-type]
        goal=user.goal,  # type: ignore[arg-type]
    )


def _user_targets_schema(user: User) -> MacroTargets:
    return MacroTargets(
        calories=user.target_calories,
        protein_g=user.target_protein_g,
        carbs_g=user.target_carbs_g,
        fat_g=user.target_fat_g,
    )


def _build_user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        profile=_user_profile_schema(user),
        targets=_user_targets_schema(user),
    )


def _build_notification_settings(user: User, db: Session) -> NotificationSettings:
    active_count = int(
        db.scalar(
            select(func.count(PushSubscription.id)).where(PushSubscription.user_id == user.id)
        )
        or 0
    )
    return NotificationSettings(
        enabled=bool(user.notifications_enabled),
        breakfast_time=user.breakfast_time,
        lunch_time=user.lunch_time,
        dinner_time=user.dinner_time,
        timezone=user.reminder_timezone,
        active_subscriptions=active_count,
    )


def _build_config_response(user: User, db: Session) -> ConfigResponse:
    profile = _user_profile_schema(user)
    calibrated = calibrate_targets(
        height_cm=profile.height_cm,
        weight_kg=profile.weight_kg,
        age=profile.age,
        sex=profile.sex,
        activity_level=profile.activity_level,
        goal=profile.goal,
    )
    return ConfigResponse(
        profile=profile,
        targets=_user_targets_schema(user),
        auto_calibrated_targets=MacroTargets(**calibrated.to_dict()),
        notifications=_build_notification_settings(user, db),
    )


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=token,
        max_age=settings.access_token_ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.SESSION_COOKIE_NAME,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def _issue_auth_response(user: User, response: Response) -> AuthResponse:
    token = create_access_token(user_id=user.id, email=user.email)
    _set_session_cookie(response, token)
    return AuthResponse(
        access_token=token,
        token_type="bearer",
        user=_build_user_response(user),
    )


def _meal_to_response(meal: MealEntry) -> MealResponse:
    has_photo = bool(meal.photo_data)
    return MealResponse(
        id=meal.id,
        user_id=meal.user_id,
        meal_name=meal.meal_name,
        logged_at=meal.logged_at,
        source=meal.source,  # type: ignore[arg-type]
        detected_reference=meal.detected_reference,
        confidence=meal.confidence,  # type: ignore[arg-type]
        notes=meal.notes,
        portion_multiplier=meal.portion_multiplier,
        items=[MealItem(**item) for item in (meal.items or [])],
        calories=meal.calories,
        protein_g=meal.protein_g,
        carbs_g=meal.carbs_g,
        fat_g=meal.fat_g,
        has_photo=has_photo,
        photo_url=f"/api/meals/{meal.id}/photo" if has_photo else None,
        created_at=meal.created_at,
    )


async def _read_and_validate_upload(
    upload: UploadFile,
    *,
    max_bytes: int,
    detector: Callable[[bytes, str | None], str | None],
    empty_detail: str,
    unsupported_detail: str,
) -> tuple[bytes, str]:
    data = await upload.read(max_bytes + 1)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=empty_detail,
        )
    if len(data) > max_bytes:
        max_mib = max_bytes // (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"Uploaded file exceeds maximum allowed size of {max_mib} MiB",
        )
    mime_type = detector(data, upload.content_type)
    if mime_type is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=unsupported_detail,
        )
    return data, mime_type


async def _read_and_validate_image(image: UploadFile, max_bytes: int) -> tuple[bytes, str]:
    return await _read_and_validate_upload(
        image,
        max_bytes=max_bytes,
        detector=detect_image_mime_type,
        empty_detail="Uploaded image file is empty",
        unsupported_detail="Uploaded file must be a valid image (JPEG, PNG, WebP, GIF, or HEIC)",
    )


def _parse_optional_date(raw_date: str | None) -> date_type | None:
    if raw_date is None:
        return None
    cleaned = raw_date.strip()
    if not cleaned:
        return None
    try:
        return date_type.fromisoformat(cleaned)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail="date must be formatted as YYYY-MM-DD",
        ) from exc


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _scale_items_list(items: list[dict[str, object]], factor: float) -> list[dict[str, object]]:
    """Scale numeric weight and macro fields across meal items by factor."""
    if factor == 1.0:
        return [dict(item) for item in items]
    scaled: list[dict[str, object]] = []
    for item in items:
        copy = dict(item)
        for field in ("estimated_grams", "calories", "protein_g", "carbs_g", "fat_g"):
            copy[field] = round(float(copy.get(field, 0.0)) * factor, 1)  # type: ignore[arg-type]
        scaled.append(copy)
    return scaled


def _align_items_with_multiplier(
    raw_items: list[dict[str, object]],
    *,
    multiplier: float,
    explicit_calories: float | None,
) -> list[dict[str, object]]:
    """Ensure stored items match the consumed/scaled totals without double-scaling pre-scaled items."""
    if not raw_items or multiplier == 1.0:
        return [dict(item) for item in raw_items]
    if explicit_calories is None:
        return _scale_items_list(raw_items, multiplier)

    raw_cal_sum = sum(float(item.get("calories", 0.0)) for item in raw_items)  # type: ignore[arg-type]
    tol = max(5.0, explicit_calories * 0.05)
    if abs(raw_cal_sum - explicit_calories) <= tol:
        return [dict(item) for item in raw_items]
    if abs((raw_cal_sum * multiplier) - explicit_calories) <= tol:
        return _scale_items_list(raw_items, multiplier)
    return [dict(item) for item in raw_items]


def _get_user_meal_or_404(db: Session, user_id: int, meal_id: int) -> MealEntry:
    stmt = select(MealEntry).where(MealEntry.id == meal_id, MealEntry.user_id == user_id)
    meal = db.scalar(stmt)
    if meal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal entry not found")
    return meal


@app.get("/api/health")
def health_check() -> dict[str, str]:
    """Liveness check endpoint."""
    return {"status": "ok"}


@app.post("/api/auth/signup", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def signup(
    payload: SignupRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> AuthResponse:
    """Register a user with email + numeric PIN, calibrate initial targets, and start session."""
    existing = db.scalar(select(User).where(User.email == payload.email))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        )

    calibrated = calibrate_targets(
        height_cm=payload.profile.height_cm,
        weight_kg=payload.profile.weight_kg,
        age=payload.profile.age,
        sex=payload.profile.sex,
        activity_level=payload.profile.activity_level,
        goal=payload.profile.goal,
    )

    user = User(
        email=payload.email,
        name=payload.name,
        pin_hash=hash_pin(payload.pin),
        height_cm=payload.profile.height_cm,
        weight_kg=payload.profile.weight_kg,
        age=payload.profile.age,
        sex=payload.profile.sex,
        activity_level=payload.profile.activity_level,
        goal=payload.profile.goal,
        target_calories=calibrated.calories,
        target_protein_g=calibrated.protein_g,
        target_carbs_g=calibrated.carbs_g,
        target_fat_g=calibrated.fat_g,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        ) from exc
    db.refresh(user)
    return _issue_auth_response(user, response)


@app.post("/api/auth/login", response_model=AuthResponse)
def login(
    payload: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> AuthResponse:
    """Authenticate an existing user with email + numeric PIN and set persistent session cookie."""
    user = db.scalar(select(User).where(User.email == payload.email))
    if user is None or not verify_pin(payload.pin, user.pin_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or PIN",
        )
    return _issue_auth_response(user, response)


@app.post("/api/auth/logout", response_model=LogoutResponse)
def logout(response: Response) -> LogoutResponse:
    """Clear the persistent session cookie."""
    _clear_session_cookie(response)
    return LogoutResponse()


@app.get("/api/auth/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)) -> UserResponse:
    """Return the currently authenticated user's profile and targets."""
    return _build_user_response(current_user)


@app.get("/api/config", response_model=ConfigResponse)
def get_config(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ConfigResponse:
    """Return user profile, active targets, calibrated baseline, and reminder preferences."""
    return _build_config_response(current_user, db)


@app.put("/api/config", response_model=ConfigResponse)
def update_config(
    payload: ConfigUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ConfigResponse:
    """Update profile, targets, or meal reminder schedule preferences."""
    if payload.profile is not None:
        for field, value in payload.profile.model_dump(exclude_none=True).items():
            setattr(current_user, field, value)

    if payload.recalibrate_from_profile:
        calibrated = calibrate_targets(
            height_cm=current_user.height_cm,
            weight_kg=current_user.weight_kg,
            age=current_user.age,
            sex=current_user.sex,
            activity_level=current_user.activity_level,
            goal=current_user.goal,
        )
        current_user.target_calories = calibrated.calories
        current_user.target_protein_g = calibrated.protein_g
        current_user.target_carbs_g = calibrated.carbs_g
        current_user.target_fat_g = calibrated.fat_g
    elif payload.targets is not None:
        target_field_map = {
            "calories": "target_calories",
            "protein_g": "target_protein_g",
            "carbs_g": "target_carbs_g",
            "fat_g": "target_fat_g",
        }
        for schema_field, model_field in target_field_map.items():
            val = getattr(payload.targets, schema_field)
            if val is not None:
                rounded = float(round(val)) if schema_field == "calories" else round(float(val), 1)
                setattr(current_user, model_field, rounded)

    if payload.notifications is not None:
        notif = payload.notifications
        if notif.enabled is not None:
            current_user.notifications_enabled = notif.enabled
        if notif.breakfast_time is not None:
            current_user.breakfast_time = notif.breakfast_time
        if notif.lunch_time is not None:
            current_user.lunch_time = notif.lunch_time
        if notif.dinner_time is not None:
            current_user.dinner_time = notif.dinner_time
        if notif.timezone is not None:
            current_user.reminder_timezone = notif.timezone

    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return _build_config_response(current_user, db)


@app.post("/api/meals/analyze", response_model=MealAnalysisResponse)
async def analyze_meal(
    image: UploadFile = File(...),
    note: str = Form(default=""),
    description: str = Form(default=""),
    reference_hint: str = Form(default=""),
    _: User = Depends(get_current_user),
) -> MealAnalysisResponse:
    """Analyze an uploaded meal photograph using Gemini vision + reference-object scaling."""
    image_bytes, mime_type = await _read_and_validate_image(image, MAX_IMAGE_UPLOAD_BYTES)
    combined_note = "; ".join(
        dict.fromkeys(part.strip() for part in (description, note) if part and part.strip())
    )

    analyzed = analyze_meal_photo(
        image_bytes=image_bytes,
        mime_type=mime_type,
        note=combined_note,
        reference_hint=reference_hint,
    )
    return MealAnalysisResponse(**analyzed)


@app.post("/api/meals/analyze-text", response_model=MealAnalysisResponse)
def analyze_meal_from_text(
    payload: MealTextAnalyzeRequest,
    _: User = Depends(get_current_user),
) -> MealAnalysisResponse:
    """Estimate meal calories and macros from a free-text description without a photo."""
    analyzed = analyze_meal_text(description=payload.description)
    return MealAnalysisResponse(**analyzed)


@app.post("/api/meals/transcribe", response_model=AudioTranscribeResponse)
async def transcribe_meal_voice(
    audio: UploadFile = File(...),
    _: User = Depends(get_current_user),
) -> AudioTranscribeResponse:
    """Transcribe spoken meal descriptions, photo notes, or edits via Gemini audio."""
    audio_bytes, mime_type = await _read_and_validate_upload(
        audio,
        max_bytes=MAX_AUDIO_UPLOAD_BYTES,
        detector=detect_audio_mime_type,
        empty_detail="Uploaded audio file is empty",
        unsupported_detail="Uploaded file must be a valid audio recording (MP4, WebM, OGG, WAV, MP3, AAC, or FLAC)",
    )
    result = transcribe_meal_audio(audio_bytes=audio_bytes, mime_type=mime_type)
    return AudioTranscribeResponse(**result)


def _build_meal(payload: MealCreateRequest, user_id: int) -> MealEntry:
    """Build a meal without committing, so callers can add related data atomically."""
    raw_items = [item.model_dump() for item in payload.items]
    multiplier = payload.portion_multiplier
    items_dicts = _align_items_with_multiplier(
        raw_items,
        multiplier=multiplier,
        explicit_calories=payload.calories,
    )

    def _resolve_macro(explicit: float | None, field: str) -> float:
        if explicit is not None:
            return round(float(explicit), 1)
        if items_dicts:
            return round(sum(float(item[field]) for item in items_dicts), 1)  # type: ignore[arg-type]
        return 0.0

    meal = MealEntry(
        user_id=user_id,
        meal_name=payload.meal_name,
        logged_at=payload.logged_at or datetime.now(timezone.utc),
        source=payload.source,
        detected_reference=payload.detected_reference,
        confidence=payload.confidence,
        notes=payload.notes,
        portion_multiplier=multiplier,
        items=items_dicts,
        calories=_resolve_macro(payload.calories, "calories"),
        protein_g=_resolve_macro(payload.protein_g, "protein_g"),
        carbs_g=_resolve_macro(payload.carbs_g, "carbs_g"),
        fat_g=_resolve_macro(payload.fat_g, "fat_g"),
    )
    return meal


@app.post("/api/meals", response_model=MealResponse, status_code=status.HTTP_201_CREATED)
def create_meal(payload: MealCreateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MealResponse:
    meal = _build_meal(payload, current_user.id)
    db.add(meal)
    db.commit()
    db.refresh(meal)
    return _meal_to_response(meal)


@app.post("/api/meals/with-photo", response_model=MealResponse, status_code=status.HTTP_201_CREATED)
async def create_meal_with_photo(
    payload: str = Form(...), request_id: str = Form(...), image: UploadFile = File(...),
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
) -> MealResponse:
    """Validate the photo before atomically committing a retry-safe meal."""
    try:
        canonical_id = str(uuid.UUID(request_id))
        parsed = MealCreateRequest.model_validate_json(payload)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail="Invalid meal or request identifier") from exc
    raw, _ = await _read_and_validate_image(image, MAX_IMAGE_UPLOAD_BYTES)
    fingerprint = hashlib.sha256(parsed.model_dump_json().encode() + b'\0' + raw).hexdigest()

    def existing_result() -> MealResponse | None:
        existing = db.get(PhotoSaveRequest, (current_user.id, canonical_id))
        if existing is None:
            return None
        if existing.fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="This save may have completed with different details. Refresh your logs before trying again.")
        saved = db.get(MealEntry, existing.meal_id)
        if saved is None:
            raise HTTPException(status_code=409, detail="The previous meal is no longer available.")
        return _meal_to_response(saved)

    existing = existing_result()
    if existing is not None:
        return existing
    try:
        photo = compress_photo(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    meal = _build_meal(parsed, current_user.id)
    meal.photo_data = photo
    meal.photo_mime_type = "image/jpeg"
    try:
        db.add(meal)
        db.flush()
        db.add(PhotoSaveRequest(user_id=current_user.id, request_id=canonical_id, meal_id=meal.id, fingerprint=fingerprint))
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = existing_result()
        if existing is not None:
            return existing
        raise
    db.refresh(meal)
    return _meal_to_response(meal)


@app.get("/api/meals", response_model=list[MealResponse])
def list_meals(
    date: date_type | None = Query(default=None),
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    tz_name: str | None = Query(default=None, max_length=64),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MealResponse]:
    """List user meals filtered by local calendar day (tz_offset_minutes) or UTC ISO range."""
    stmt = select(MealEntry).where(MealEntry.user_id == current_user.id)

    if start is not None or end is not None:
        start_utc = _ensure_utc(start) if start is not None else None
        end_utc = _ensure_utc(end) if end is not None else None
        if start_utc is not None and end_utc is not None and start_utc > end_utc:
            raise HTTPException(
                status_code=422,
                detail="start must be before or equal to end",
            )
        if start_utc is not None:
            stmt = stmt.where(MealEntry.logged_at >= start_utc)
        if end_utc is not None:
            stmt = stmt.where(MealEntry.logged_at < end_utc)
    elif date is not None:
        utc_start, utc_end = _local_day_to_utc_range(date, tz_offset_minutes, tz_name)
        stmt = stmt.where(MealEntry.logged_at >= utc_start, MealEntry.logged_at < utc_end)

    stmt = stmt.order_by(MealEntry.logged_at.desc(), MealEntry.id.desc())
    meals = db.scalars(stmt).all()
    return [_meal_to_response(meal) for meal in meals]


@app.get("/api/meals/logs", response_model=PaginatedMealsResponse)
def list_meal_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    date: str | None = Query(default=None),
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    tz_name: str | None = Query(default=None, max_length=64),
    q: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaginatedMealsResponse:
    """Return paginated meal logs with optional local-date filtering and case-insensitive search."""
    conditions = [MealEntry.user_id == current_user.id]

    parsed_date = _parse_optional_date(date)
    if parsed_date is not None:
        utc_start, utc_end = _local_day_to_utc_range(parsed_date, tz_offset_minutes, tz_name)
        conditions.extend([MealEntry.logged_at >= utc_start, MealEntry.logged_at < utc_end])

    if q is not None and q.strip():
        pattern = f"%{_escape_like(q.strip())}%"
        conditions.append(
            or_(
                MealEntry.meal_name.ilike(pattern, escape="\\"),
                MealEntry.notes.ilike(pattern, escape="\\"),
            )
        )

    total = int(db.scalar(select(func.count(MealEntry.id)).where(*conditions)) or 0)
    total_pages = (total + page_size - 1) // page_size if total > 0 else 0
    offset = (page - 1) * page_size

    meals = db.scalars(
        select(MealEntry)
        .where(*conditions)
        .order_by(MealEntry.logged_at.desc(), MealEntry.id.desc())
        .offset(offset)
        .limit(page_size)
    ).all()

    return PaginatedMealsResponse(
        items=[_meal_to_response(meal) for meal in meals],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        has_next=page < total_pages,
        has_prev=page > 1,
    )


@app.post("/api/meals/{meal_id}/photo", response_model=MealResponse)
async def upload_meal_photo(
    meal_id: int,
    image: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MealResponse:
    """Attach or replace a binary photo stored on an existing meal entry."""
    meal = _get_user_meal_or_404(db, current_user.id, meal_id)
    image_bytes, _ = await _read_and_validate_image(image, MAX_STORED_PHOTO_BYTES)
    try:
        meal.photo_data = compress_photo(image_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    meal.photo_mime_type = "image/jpeg"
    db.add(meal)
    db.commit()
    db.refresh(meal)
    return _meal_to_response(meal)


@app.get("/api/meals/{meal_id}/photo")
def get_meal_photo(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Serve a meal's stored photo via Bearer token or persistent macro_session cookie."""
    meal = _get_user_meal_or_404(db, current_user.id, meal_id)
    if not meal.photo_data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Meal photo not found",
        )
    return Response(
        content=meal.photo_data,
        media_type=meal.photo_mime_type or "image/jpeg",
        headers={"Cache-Control": "private, no-store"},
    )


@app.post("/api/meals/{meal_id}/refine", response_model=MealAnalysisResponse)
def refine_meal(
    meal_id: int,
    payload: MealRefineRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MealAnalysisResponse:
    """Refine an existing meal's items and macros from a plain-text change description."""
    meal = _get_user_meal_or_404(db, current_user.id, meal_id)
    refined = refine_meal_from_text(
        meal_name=meal.meal_name,
        current_items=list(meal.items or []),
        current_notes=meal.notes,
        current_totals={
            "calories": meal.calories,
            "protein_g": meal.protein_g,
            "carbs_g": meal.carbs_g,
            "fat_g": meal.fat_g,
        },
        instruction=payload.instruction,
    )
    if refined.get("detected_reference") is None and meal.detected_reference:
        refined["detected_reference"] = meal.detected_reference
    return MealAnalysisResponse(**refined)


@app.patch("/api/meals/{meal_id}", response_model=MealResponse)
def update_meal(
    meal_id: int,
    payload: MealUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MealResponse:
    """Partially update a logged meal entry, recalculating macros when items/multiplier change."""
    meal = _get_user_meal_or_404(db, current_user.id, meal_id)
    fields_set = payload.model_fields_set

    for simple_field in ("meal_name", "logged_at", "source", "detected_reference", "confidence", "notes"):
        if simple_field in fields_set:
            val = getattr(payload, simple_field)
            if simple_field == "notes" and val is None:
                val = ""
            if simple_field in ("meal_name", "logged_at", "source") and val is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"{simple_field} cannot be null",
                )
            setattr(meal, simple_field, val)

    old_multiplier = meal.portion_multiplier
    new_multiplier = payload.portion_multiplier if payload.portion_multiplier is not None else old_multiplier
    scale_ratio = (
        new_multiplier / old_multiplier
        if payload.portion_multiplier is not None and old_multiplier > 0
        else 1.0
    )

    if payload.items is not None:
        raw_items = [item.model_dump() for item in payload.items]
        if payload.portion_multiplier is not None:
            new_items = _align_items_with_multiplier(
                raw_items,
                multiplier=new_multiplier,
                explicit_calories=payload.calories,
            )
        else:
            new_items = raw_items
    elif payload.portion_multiplier is not None and scale_ratio != 1.0:
        existing_items = list(meal.items or [])
        if payload.calories is not None:
            new_items = _align_items_with_multiplier(
                existing_items,
                multiplier=scale_ratio,
                explicit_calories=payload.calories,
            )
        else:
            new_items = _scale_items_list(existing_items, scale_ratio)
    else:
        new_items = list(meal.items or [])

    recompute_from_items_or_multiplier = (
        payload.items is not None or payload.portion_multiplier is not None
    )

    for macro_field in ("calories", "protein_g", "carbs_g", "fat_g"):
        explicit_val = getattr(payload, macro_field)
        if macro_field in fields_set and explicit_val is not None:
            setattr(meal, macro_field, round(float(explicit_val), 1))
        elif recompute_from_items_or_multiplier:
            if new_items:
                setattr(
                    meal,
                    macro_field,
                    round(sum(float(item[macro_field]) for item in new_items), 1),  # type: ignore[arg-type]
                )
            elif payload.portion_multiplier is not None and old_multiplier > 0:
                scaled = float(getattr(meal, macro_field)) * scale_ratio
                setattr(meal, macro_field, round(scaled, 1))

    meal.items = new_items
    meal.portion_multiplier = new_multiplier

    db.add(meal)
    db.commit()
    db.refresh(meal)
    return _meal_to_response(meal)


@app.delete("/api/meals/{meal_id}", response_model=DeleteMealResponse)
def delete_meal(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeleteMealResponse:
    """Delete a logged meal entry owned by the authenticated user."""
    meal = _get_user_meal_or_404(db, current_user.id, meal_id)
    db.delete(meal)
    db.commit()
    return DeleteMealResponse(id=meal_id)


@app.get("/api/dashboard/daily", response_model=DailyDashboardResponse)
def get_daily_dashboard(
    date: date_type | None = Query(default=None),
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    tz_name: str | None = Query(default=None, max_length=64),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyDashboardResponse:
    """Aggregate consumed macros, remaining targets, and daily goal status for a local day."""
    resolved_date = _resolve_local_date(date, tz_offset_minutes)
    utc_start, utc_end = _local_day_to_utc_range(resolved_date, tz_offset_minutes, tz_name)

    stmt = (
        select(MealEntry)
        .where(
            MealEntry.user_id == current_user.id,
            MealEntry.logged_at >= utc_start,
            MealEntry.logged_at < utc_end,
        )
        .order_by(MealEntry.logged_at.desc(), MealEntry.id.desc())
    )
    meals = db.scalars(stmt).all()

    consumed_cal = round(sum(m.calories for m in meals), 1)
    consumed_pro = round(sum(m.protein_g for m in meals), 1)
    consumed_carbs = round(sum(m.carbs_g for m in meals), 1)
    consumed_fat = round(sum(m.fat_g for m in meals), 1)

    targets = _user_targets_schema(current_user)
    consumed = MacroTotals(
        calories=consumed_cal,
        protein_g=consumed_pro,
        carbs_g=consumed_carbs,
        fat_g=consumed_fat,
    )
    remaining = MacroTotals(
        calories=round(targets.calories - consumed_cal, 1),
        protein_g=round(targets.protein_g - consumed_pro, 1),
        carbs_g=round(targets.carbs_g - consumed_carbs, 1),
        fat_g=round(targets.fat_g - consumed_fat, 1),
    )

    daily_status = evaluate_daily_status(
        target_calories=targets.calories,
        target_protein_g=targets.protein_g,
        consumed_calories=consumed_cal,
        consumed_protein_g=consumed_pro,
        meal_count=len(meals),
    )

    return DailyDashboardResponse(
        date=resolved_date.isoformat(),
        targets=targets,
        consumed=consumed,
        remaining=remaining,
        status=DailyStatus(**daily_status),
        meal_count=len(meals),
        meals=[_meal_to_response(meal) for meal in meals],
    )


@app.get("/api/dashboard/history", response_model=DashboardHistoryResponse)
def get_dashboard_history(
    days: int = Query(14, ge=1, le=90),
    end_date: str | None = Query(default=None),
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    tz_name: str | None = Query(default=None, max_length=64),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardHistoryResponse:
    """Aggregate multi-day calorie/macro series and goal attainment streaks."""
    parsed_end = _parse_optional_date(end_date)
    resolved_end_date = parsed_end if parsed_end is not None else _resolve_local_date(None, tz_offset_minutes)
    start_date = resolved_end_date - timedelta(days=days - 1)

    window_utc_start, _ = _local_day_to_utc_range(start_date, tz_offset_minutes, tz_name)
    _, window_utc_end = _local_day_to_utc_range(resolved_end_date, tz_offset_minutes, tz_name)

    rows = db.execute(
        select(
            MealEntry.logged_at,
            MealEntry.calories,
            MealEntry.protein_g,
            MealEntry.carbs_g,
            MealEntry.fat_g,
        ).where(
            MealEntry.user_id == current_user.id,
            MealEntry.logged_at >= window_utc_start,
            MealEntry.logged_at < window_utc_end,
        )
    ).all()

    buckets: dict[date_type, dict[str, float]] = {}
    for offset_days in range(days):
        day_key = start_date + timedelta(days=offset_days)
        buckets[day_key] = {
            "calories": 0.0,
            "protein_g": 0.0,
            "carbs_g": 0.0,
            "fat_g": 0.0,
            "meal_count": 0.0,
        }

    for logged_at, cal, pro, carb, fat in rows:
        local_day = (_ensure_utc(logged_at).astimezone(ZoneInfo(tz_name)).date() if tz_name
                     else (_ensure_utc(logged_at) - timedelta(minutes=tz_offset_minutes)).date())
        if local_day in buckets:
            bucket = buckets[local_day]
            bucket["calories"] += float(cal)
            bucket["protein_g"] += float(pro)
            bucket["carbs_g"] += float(carb)
            bucket["fat_g"] += float(fat)
            bucket["meal_count"] += 1.0

    targets = _user_targets_schema(current_user)
    series: list[DashboardHistoryDay] = []

    for offset_days in range(days):
        day_key = start_date + timedelta(days=offset_days)
        bucket = buckets[day_key]
        cal = round(bucket["calories"], 1)
        pro = round(bucket["protein_g"], 1)
        carb = round(bucket["carbs_g"], 1)
        fat = round(bucket["fat_g"], 1)
        meal_count = int(bucket["meal_count"])

        day_status = evaluate_daily_status(
            target_calories=targets.calories,
            target_protein_g=targets.protein_g,
            consumed_calories=cal,
            consumed_protein_g=pro,
            meal_count=meal_count,
        )
        cal_status = str(day_status["calories"])
        pro_status = str(day_status["protein"])
        calories_met = meal_count > 0 and cal_status == "on_track"
        protein_met = meal_count > 0 and pro_status in ("met", "exceeded")
        meeting_goals = meal_count > 0 and bool(day_status["meeting_goals"])

        series.append(
            DashboardHistoryDay(
                date=day_key.isoformat(),
                calories=cal,
                protein_g=pro,
                carbs_g=carb,
                fat_g=fat,
                meal_count=meal_count,
                calories_status=cal_status,  # type: ignore[arg-type]
                protein_status=pro_status,  # type: ignore[arg-type]
                calories_met=calories_met,
                protein_met=protein_met,
                meeting_goals=meeting_goals,
            )
        )

    logged_days = [day for day in series if day.meal_count > 0]
    days_logged = len(logged_days)

    streak_idx = len(series) - 1
    if streak_idx >= 0 and series[streak_idx].meal_count == 0:
        streak_idx -= 1
    current_streak = 0
    while streak_idx >= 0 and series[streak_idx].meeting_goals:
        current_streak += 1
        streak_idx -= 1

    summary = DashboardHistorySummary(
        days_logged=days_logged,
        days_calories_met=sum(1 for day in series if day.calories_met),
        days_protein_met=sum(1 for day in series if day.protein_met),
        days_both_met=sum(1 for day in series if day.meeting_goals),
        current_streak=current_streak,
        avg_calories=round(sum(day.calories for day in logged_days) / days_logged, 1) if days_logged else 0.0,
        avg_protein_g=round(sum(day.protein_g for day in logged_days) / days_logged, 1) if days_logged else 0.0,
    )

    return DashboardHistoryResponse(
        days=days,
        targets=targets,
        summary=summary,
        series=series,
    )


@app.get("/api/notifications/vapid-public-key", response_model=VapidPublicKeyResponse)
def get_vapid_public_key() -> VapidPublicKeyResponse:
    """Return the VAPID public key for browser PushManager subscriptions."""
    try:
        public_key, _ = get_or_create_vapid_keys()
        return VapidPublicKeyResponse(public_key=public_key, configured=bool(public_key))
    except RuntimeError:
        return VapidPublicKeyResponse(public_key="", configured=False)


@app.post("/api/notifications/subscribe", response_model=NotificationSettings)
def subscribe_push_notifications(
    payload: PushSubscribeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettings:
    """Register or update a browser Web Push subscription for the authenticated user."""
    existing = db.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if existing is not None:
        existing.user_id = current_user.id
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
        existing.user_agent = payload.user_agent
        db.add(existing)
    else:
        db.add(
            PushSubscription(
                user_id=current_user.id,
                endpoint=payload.endpoint,
                p256dh=payload.keys.p256dh,
                auth=payload.keys.auth,
                user_agent=payload.user_agent,
            )
        )

    current_user.notifications_enabled = True
    if payload.timezone is not None:
        current_user.reminder_timezone = payload.timezone
    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return _build_notification_settings(current_user, db)


@app.delete("/api/notifications/subscribe", response_model=NotificationSettings)
def unsubscribe_push_notifications(
    endpoint: str | None = Query(default=None),
    payload: PushUnsubscribeRequest | None = Body(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettings:
    """Remove a specific endpoint subscription or all subscriptions for the authenticated user."""
    target_endpoint = (endpoint or (payload.endpoint if payload else None) or "").strip()
    stmt = delete(PushSubscription).where(PushSubscription.user_id == current_user.id)
    if target_endpoint:
        stmt = stmt.where(PushSubscription.endpoint == target_endpoint)
    db.execute(stmt)
    db.flush()

    remaining = int(
        db.scalar(
            select(func.count(PushSubscription.id)).where(PushSubscription.user_id == current_user.id)
        )
        or 0
    )
    if remaining == 0:
        current_user.notifications_enabled = False
        db.add(current_user)

    db.commit()
    db.refresh(current_user)
    return _build_notification_settings(current_user, db)


@app.post("/api/notifications/test", response_model=PushTestResponse)
def send_test_push_notification(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PushTestResponse:
    """Send an immediate test Web Push notification to all subscribed devices for this user."""
    try:
        sent, failed = send_push_to_user(
            db,
            current_user,
            title="MacroLens Reminder Test",
            body="Push reminders are active for Breakfast, Lunch & Dinner!",
            url="/?action=snap",
            tag="meal-reminder-test",
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc

    if sent == 0 and failed == 0:
        return PushTestResponse(
            sent=0,
            failed=0,
            detail="No active push subscriptions found for this account",
        )
    return PushTestResponse(
        sent=sent,
        failed=failed,
        detail=f"Sent test notification to {sent} device(s)"
        if failed == 0
        else f"Sent to {sent} device(s), {failed} failed",
    )
