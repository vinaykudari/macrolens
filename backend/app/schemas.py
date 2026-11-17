"""Pydantic v2 request and response schemas for Macro Tracker API."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SexType = Literal["male", "female", "other"]
ActivityLevelType = Literal["sedentary", "light", "moderate", "active", "very_active"]
GoalType = Literal["lose", "maintain", "gain"]
MealSourceType = Literal["photo", "text", "manual", "recent"]
ConfidenceType = Literal["high", "medium", "low"]

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PIN_RE = re.compile(r"^\d{4,6}$")
_HHMM_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def _normalize_email(value: str) -> str:
    cleaned = value.strip().lower()
    if not _EMAIL_RE.match(cleaned):
        raise ValueError("Invalid email address")
    return cleaned


def _validate_pin(value: str) -> str:
    cleaned = value.strip()
    if not _PIN_RE.match(cleaned):
        raise ValueError("PIN must be 4 to 6 numeric digits")
    return cleaned


def _validate_hhmm(value: str) -> str:
    cleaned = value.strip()
    if not _HHMM_RE.match(cleaned):
        raise ValueError("Time must use 24-hour HH:MM format (00:00 to 23:59)")
    return cleaned


def _validate_timezone(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("Timezone must not be empty")
    try:
        ZoneInfo(cleaned)
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise ValueError(f"Invalid IANA timezone: {cleaned!r}") from exc
    return cleaned


def _ensure_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class UserProfile(BaseModel):
    """Biometric profile and fitness goal used for target calibration."""

    height_cm: float = Field(..., gt=50, le=300)
    weight_kg: float = Field(..., gt=20, le=500)
    age: int = Field(..., ge=13, le=120)
    sex: SexType
    activity_level: ActivityLevelType
    goal: GoalType


class UserProfileUpdate(BaseModel):
    """Partial update payload for user biometric profile."""

    height_cm: float | None = Field(default=None, gt=50, le=300)
    weight_kg: float | None = Field(default=None, gt=20, le=500)
    age: int | None = Field(default=None, ge=13, le=120)
    sex: SexType | None = None
    activity_level: ActivityLevelType | None = None
    goal: GoalType | None = None


class MacroTargets(BaseModel):
    """Daily calorie and macronutrient targets."""

    calories: float = Field(..., gt=0, le=20000)
    protein_g: float = Field(..., ge=0, le=2000)
    carbs_g: float = Field(..., ge=0, le=3000)
    fat_g: float = Field(..., ge=0, le=1000)


class MacroTargetsUpdate(BaseModel):
    """Partial manual overrides for daily calorie and macro targets."""

    calories: float | None = Field(default=None, gt=0, le=20000)
    protein_g: float | None = Field(default=None, ge=0, le=2000)
    carbs_g: float | None = Field(default=None, ge=0, le=3000)
    fat_g: float | None = Field(default=None, ge=0, le=1000)


class MacroTotals(BaseModel):
    """Calorie and macronutrient totals."""

    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float


class SignupRequest(BaseModel):
    """Account creation payload with email, 4-6 digit PIN, name, and profile."""

    email: str
    pin: str
    name: str = Field(..., min_length=1, max_length=120)
    profile: UserProfile

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        return _normalize_email(v)

    @field_validator("pin")
    @classmethod
    def check_pin(cls, v: str) -> str:
        return _validate_pin(v)

    @field_validator("name")
    @classmethod
    def check_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Name must not be empty")
        return cleaned


class LoginRequest(BaseModel):
    """Sign-in payload with email and 4-6 digit PIN."""

    email: str
    pin: str

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        return _normalize_email(v)

    @field_validator("pin")
    @classmethod
    def check_pin(cls, v: str) -> str:
        return _validate_pin(v)


class UserResponse(BaseModel):
    """Authenticated user details with profile and active targets."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    profile: UserProfile
    targets: MacroTargets


class AuthResponse(BaseModel):
    """Authentication payload returned by signup and login."""

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    user: UserResponse


class LogoutResponse(BaseModel):
    """Logout acknowledgement."""

    status: Literal["ok"] = "ok"


class NotificationSettings(BaseModel):
    """Web Push meal reminder schedule and device status."""

    enabled: bool = False
    breakfast_time: str = "08:30"
    lunch_time: str = "13:00"
    dinner_time: str = "19:30"
    timezone: str = "UTC"
    active_subscriptions: int = 0


class NotificationSettingsUpdate(BaseModel):
    """Partial update payload for user meal reminder preferences."""

    enabled: bool | None = None
    breakfast_time: str | None = None
    lunch_time: str | None = None
    dinner_time: str | None = None
    timezone: str | None = None

    @field_validator("breakfast_time", "lunch_time", "dinner_time")
    @classmethod
    def check_time_format(cls, v: str | None) -> str | None:
        return _validate_hhmm(v) if v is not None else None

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, v: str | None) -> str | None:
        return _validate_timezone(v) if v is not None else None


class VapidPublicKeyResponse(BaseModel):
    """Public VAPID application server key for browser PushManager subscription."""

    public_key: str
    configured: bool


class PushSubscriptionKeys(BaseModel):
    """Browser PushSubscription encryption keys."""

    p256dh: str = Field(..., min_length=1, max_length=255)
    auth: str = Field(..., min_length=1, max_length=255)


class PushSubscribeRequest(BaseModel):
    """Browser PushSubscription registration payload."""

    endpoint: str = Field(..., min_length=1, max_length=2000)
    keys: PushSubscriptionKeys
    timezone: str | None = None
    user_agent: str | None = Field(default=None, max_length=255)

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, v: str | None) -> str | None:
        return _validate_timezone(v) if v is not None else None


class PushUnsubscribeRequest(BaseModel):
    """Optional endpoint specification when removing push subscriptions."""

    endpoint: str | None = Field(default=None, max_length=2000)


class PushTestResponse(BaseModel):
    """Result summary for sending a test Web Push notification."""

    sent: int
    failed: int
    detail: str


class ConfigResponse(BaseModel):
    """User configuration including active targets, baseline, and reminder schedule."""

    profile: UserProfile
    targets: MacroTargets
    auto_calibrated_targets: MacroTargets
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)


class ConfigUpdateRequest(BaseModel):
    """Configuration update payload supporting profile edits, recalibration, overrides, or reminders."""

    profile: UserProfileUpdate | None = None
    targets: MacroTargetsUpdate | None = None
    recalibrate_from_profile: bool = False
    notifications: NotificationSettingsUpdate | None = None


class MealItem(BaseModel):
    """Individual food item detected in or logged for a meal."""

    name: str = Field(..., min_length=1, max_length=255)
    portion_description: str = Field(default="", max_length=255)
    estimated_grams: float = Field(default=0.0, ge=0)
    calories: float = Field(..., ge=0)
    protein_g: float = Field(..., ge=0)
    carbs_g: float = Field(..., ge=0)
    fat_g: float = Field(..., ge=0)


class MealAnalysisResponse(BaseModel):
    """Structured meal macro extraction returned by Gemini photo or text analysis."""

    meal_name: str
    detected_reference: str | None = None
    confidence: ConfidenceType = "medium"
    notes: str = ""
    total: MacroTotals
    items: list[MealItem]


class AudioTranscribeResponse(BaseModel):
    """Spoken meal description or edit transcript returned by Gemini audio transcription."""

    transcript: str


def _validate_trimmed_text(value: str, *, field_name: str, min_length: int) -> str:
    cleaned = value.strip()
    if len(cleaned) < min_length:
        raise ValueError(f"{field_name} must be at least {min_length} characters")
    return cleaned


class MealTextAnalyzeRequest(BaseModel):
    """Text-only meal description payload for calorie and macro estimation."""

    description: str = Field(..., min_length=2, max_length=2000)

    @field_validator("description")
    @classmethod
    def check_description(cls, v: str) -> str:
        return _validate_trimmed_text(v, field_name="description", min_length=2)


class MealRefineContext(BaseModel):
    meal_name: str = Field(..., min_length=1, max_length=255)
    notes: str = Field(default="", max_length=2000)
    items: list[MealItem] = Field(default_factory=list, max_length=100)
    total: MacroTotals


class MealRefineRequest(BaseModel):
    """Natural-language instruction to refine an existing meal's items and macros."""

    instruction: str = Field(..., min_length=2, max_length=1000)
    current: MealRefineContext | None = None

    @field_validator("instruction")
    @classmethod
    def check_instruction(cls, v: str) -> str:
        return _validate_trimmed_text(v, field_name="instruction", min_length=2)


class MealCreateRequest(BaseModel):
    """Payload to log a timestamped meal entry."""

    meal_name: str = Field(..., min_length=1, max_length=255)
    logged_at: datetime | None = None
    source: MealSourceType = "manual"
    detected_reference: str | None = Field(default=None, max_length=255)
    confidence: ConfidenceType | None = None
    notes: str = Field(default="", max_length=2000)
    portion_multiplier: float = Field(default=1.0, gt=0, le=20)
    items: list[MealItem] = Field(default_factory=list)
    calories: float | None = Field(default=None, ge=0)
    protein_g: float | None = Field(default=None, ge=0)
    carbs_g: float | None = Field(default=None, ge=0)
    fat_g: float | None = Field(default=None, ge=0)

    @field_validator("notes", mode="before")
    @classmethod
    def coerce_notes(cls, v: object) -> str:
        if v is None:
            return ""
        return str(v)

    @field_validator("meal_name")
    @classmethod
    def check_meal_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("meal_name must not be empty")
        return cleaned

    @field_validator("logged_at")
    @classmethod
    def normalize_logged_at(cls, v: datetime | None) -> datetime | None:
        return _ensure_utc(v)

    @model_validator(mode="after")
    def require_macros_or_items(self) -> "MealCreateRequest":
        if self.calories is None and not self.items:
            raise ValueError("Provide either macro values (calories) or meal items")
        return self


class MealUpdateRequest(BaseModel):
    """Partial update payload for an existing meal entry."""

    meal_name: str | None = Field(default=None, min_length=1, max_length=255)
    logged_at: datetime | None = None
    source: MealSourceType | None = None
    detected_reference: str | None = Field(default=None, max_length=255)
    confidence: ConfidenceType | None = None
    notes: str | None = Field(default=None, max_length=2000)
    portion_multiplier: float | None = Field(default=None, gt=0, le=20)
    items: list[MealItem] | None = None
    calories: float | None = Field(default=None, ge=0)
    protein_g: float | None = Field(default=None, ge=0)
    carbs_g: float | None = Field(default=None, ge=0)
    fat_g: float | None = Field(default=None, ge=0)

    @field_validator("meal_name")
    @classmethod
    def check_meal_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("meal_name must not be empty")
        return cleaned

    @field_validator("logged_at")
    @classmethod
    def normalize_logged_at(cls, v: datetime | None) -> datetime | None:
        return _ensure_utc(v)


class MealResponse(BaseModel):
    """Serialized meal entry returned by meal endpoints."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    meal_name: str
    logged_at: datetime
    source: MealSourceType
    detected_reference: str | None
    confidence: ConfidenceType | None
    notes: str
    portion_multiplier: float
    items: list[MealItem]
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    has_photo: bool = False
    photo_url: str | None = None
    created_at: datetime


class PaginatedMealsResponse(BaseModel):
    """Paginated meal logs response."""

    items: list[MealResponse]
    total: int
    page: int
    page_size: int
    total_pages: int
    has_next: bool
    has_prev: bool


class DeleteMealResponse(BaseModel):
    """Response returned after deleting a meal entry."""

    status: Literal["deleted"] = "deleted"
    id: int


class DailyStatus(BaseModel):
    """Goal attainment classification for a calendar day."""

    calories: Literal["under", "on_track", "over"]
    protein: Literal["under", "met", "exceeded"]
    meeting_goals: bool
    summary: str


class DailyDashboardResponse(BaseModel):
    """Daily calorie and macro dashboard summary."""

    date: str
    targets: MacroTargets
    consumed: MacroTotals
    remaining: MacroTotals
    status: DailyStatus
    meal_count: int
    meals: list[MealResponse]


class DashboardHistoryDay(BaseModel):
    """Single day entry in the multi-day dashboard history series."""

    date: str
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    meal_count: int
    calories_status: Literal["under", "on_track", "over"]
    protein_status: Literal["under", "met", "exceeded"]
    calories_met: bool
    protein_met: bool
    meeting_goals: bool


class DashboardHistorySummary(BaseModel):
    """Aggregate summary across the requested multi-day history window."""

    days_logged: int
    days_calories_met: int
    days_protein_met: int
    days_both_met: int
    current_streak: int
    avg_calories: float
    avg_protein_g: float


class DashboardHistoryResponse(BaseModel):
    """Multi-day dashboard charts and goal attainment history."""

    days: int
    targets: MacroTargets
    summary: DashboardHistorySummary
    series: list[DashboardHistoryDay]


class ShortcutTokenStatusResponse(BaseModel):
    """Status of the user's personal Apple Shortcuts sync token."""

    configured: bool
    token: str | None = None


class ShortcutTokenCreateResponse(BaseModel):
    """Newly generated personal Apple Shortcuts sync token (shown once)."""

    token: str
    configured: bool = True


class ShortcutHealthMealItem(BaseModel):
    """Flat, Shortcuts-friendly meal payload for Apple Health logging."""

    id: int
    meal_name: str
    logged_at: datetime
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    synced_to_health: bool


class ShortcutHealthSyncResponse(BaseModel):
    """Daily or incremental nutrition payload for Apple Shortcuts -> Apple Health."""

    date: str
    total_calories: float
    total_protein_g: float
    total_carbs_g: float
    total_fat_g: float
    meal_count: int
    unsynced_count: int
    meals: list[ShortcutHealthMealItem]


class ShortcutPrepareRequest(BaseModel):
    """Request to build and sign a pre-configured Apple Health .shortcut installer."""

    token: str = Field(..., min_length=8, max_length=256)
    base_url: str | None = Field(default=None, max_length=512)


class ShortcutPrepareResponse(BaseModel):
    """Download URL and embedded sync URL for the prepared .shortcut installer."""

    download_url: str
    sync_url: str
    mode: Literal["baked", "template"]
