"""SQLAlchemy 2.0 ORM models for users and meal entries."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, UTCDateTime


def utc_now() -> datetime:
    """Return current timezone-aware UTC timestamp."""
    return datetime.now(timezone.utc)


class User(Base):
    """Registered user with biometric profile and daily calorie/macro targets."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    pin_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    height_cm: Mapped[float] = mapped_column(Float, nullable=False)
    weight_kg: Mapped[float] = mapped_column(Float, nullable=False)
    age: Mapped[int] = mapped_column(Integer, nullable=False)
    sex: Mapped[str] = mapped_column(String(20), nullable=False)
    activity_level: Mapped[str] = mapped_column(String(32), nullable=False)
    goal: Mapped[str] = mapped_column(String(32), nullable=False)

    target_calories: Mapped[float] = mapped_column(Float, nullable=False)
    target_protein_g: Mapped[float] = mapped_column(Float, nullable=False)
    target_carbs_g: Mapped[float] = mapped_column(Float, nullable=False)
    target_fat_g: Mapped[float] = mapped_column(Float, nullable=False)

    notifications_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    breakfast_time: Mapped[str] = mapped_column(String(5), nullable=False, default="08:30")
    lunch_time: Mapped[str] = mapped_column(String(5), nullable=False, default="13:00")
    dinner_time: Mapped[str] = mapped_column(String(5), nullable=False, default="19:30")
    reminder_timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="UTC")
    last_breakfast_sent_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    last_lunch_sent_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    last_dinner_sent_date: Mapped[str | None] = mapped_column(String(10), nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utc_now, nullable=False)

    meals: Mapped[list["MealEntry"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )
    push_subscriptions: Mapped[list["PushSubscription"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class MealEntry(Base):
    """Timestamped meal entry logged via photo analysis or manual input."""

    __tablename__ = "meal_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    meal_name: Mapped[str] = mapped_column(String(255), nullable=False)
    logged_at: Mapped[datetime] = mapped_column(
        UTCDateTime,
        default=utc_now,
        index=True,
        nullable=False,
    )
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")
    detected_reference: Mapped[str | None] = mapped_column(String(255), nullable=True)
    confidence: Mapped[str | None] = mapped_column(String(20), nullable=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    portion_multiplier: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)

    calories: Mapped[float] = mapped_column(Float, nullable=False)
    protein_g: Mapped[float] = mapped_column(Float, nullable=False)
    carbs_g: Mapped[float] = mapped_column(Float, nullable=False)
    fat_g: Mapped[float] = mapped_column(Float, nullable=False)
    photo_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    photo_mime_type: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utc_now, nullable=False)

    user: Mapped["User"] = relationship(back_populates="meals")


class PushSubscription(Base):
    """Web Push API device subscription belonging to a user."""

    __tablename__ = "push_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    endpoint: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    p256dh: Mapped[str] = mapped_column(String(255), nullable=False)
    auth: Mapped[str] = mapped_column(String(255), nullable=False)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utc_now, nullable=False)

    user: Mapped["User"] = relationship(back_populates="push_subscriptions")


class PhotoSaveRequest(Base):
    """Deduplicate retries of a photo meal save without exposing request data."""
    __tablename__ = "photo_save_requests"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    meal_id: Mapped[int] = mapped_column(ForeignKey("meal_entries.id", ondelete="CASCADE"), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
