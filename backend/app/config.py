"""Application configuration loaded from environment variables and .env."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_DIR / ".env"

# Load project-local backend/.env when present so local dev overrides stale shell keys,
# while production (no .env file) reads directly from environment variables.
load_dotenv(ENV_FILE, override=True)


def normalize_database_url(url: str) -> str:
    """Normalize PostgreSQL URLs to use the SQLAlchemy psycopg (v3) driver."""
    stripped = url.strip()
    if stripped.startswith("postgres://"):
        return "postgresql+psycopg://" + stripped[len("postgres://") :]
    if stripped.startswith("postgresql://"):
        return "postgresql+psycopg://" + stripped[len("postgresql://") :]
    return stripped


class Settings(BaseSettings):
    """Runtime settings for the Macro Tracker API."""

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    DATABASE_URL: str = "sqlite:///./macro_tracker.db"
    GEMINI_API_KEY: str = ""
    GOOGLE_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-4-carbon"
    SECRET_KEY: str = "change-me-in-prod"
    ACCESS_TOKEN_EXPIRE_DAYS: int = 30
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"
    COOKIE_SECURE: bool = False
    SESSION_COOKIE_NAME: str = "macro_session"
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    VAPID_SUBJECT: str = "mailto:admin@macrolens.local"
    VAPID_KEYS_FILE: str = ".vapid_keys.json"

    @property
    def effective_vapid_keys_path(self) -> Path:
        """Resolved path for auto-generated VAPID keypair storage."""
        candidate = Path(self.VAPID_KEYS_FILE)
        return candidate if candidate.is_absolute() else BACKEND_DIR / candidate

    @property
    def cookie_secure(self) -> bool:
        """Whether auth session cookies require HTTPS."""
        return bool(self.COOKIE_SECURE)

    @property
    def access_token_ttl_seconds(self) -> int:
        """Session token and cookie lifetime in seconds."""
        return max(60, int(self.ACCESS_TOKEN_EXPIRE_DAYS) * 24 * 3600)

    @property
    def cors_origins_list(self) -> list[str]:
        """Parsed list of allowed CORS origins."""
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    @property
    def effective_gemini_api_key(self) -> str:
        """Resolve Gemini API key with process env taking precedence over .env/defaults."""
        env_key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()
        if env_key:
            return env_key
        return self.GEMINI_API_KEY.strip() or self.GOOGLE_API_KEY.strip()

    @property
    def effective_gemini_model(self) -> str:
        """Resolve Gemini model with process env taking precedence over defaults."""
        env_model = os.getenv("GEMINI_MODEL", "").strip()
        return env_model or self.GEMINI_MODEL.strip() or "gemini-4-carbon"

    @property
    def effective_database_url(self) -> str:
        """Database URL normalized for SQLAlchemy 2.0 + psycopg/sqlite."""
        return normalize_database_url(self.DATABASE_URL)


settings = Settings()
