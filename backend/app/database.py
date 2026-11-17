"""SQLAlchemy 2.0 database engine, session management, and UTC datetime type."""

from __future__ import annotations

from collections.abc import Generator
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import DateTime, Engine, create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.types import TypeDecorator

from app.config import normalize_database_url, settings


class UTCDateTime(TypeDecorator[datetime]):
    """Store and return timezone-aware UTC datetimes consistently on SQLite and Postgres."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class Base(DeclarativeBase):
    """Declarative base for ORM models."""


def create_db_engine(database_url: str | None = None) -> Engine:
    """Create a configured SQLAlchemy engine for SQLite or PostgreSQL."""
    resolved_url = normalize_database_url(database_url or settings.effective_database_url)
    is_sqlite = resolved_url.startswith("sqlite")

    engine_kwargs: dict[str, Any] = {}
    if is_sqlite:
        engine_kwargs["connect_args"] = {"check_same_thread": False}
        if resolved_url in ("sqlite://", "sqlite:///:memory:"):
            engine_kwargs["poolclass"] = StaticPool
    else:
        engine_kwargs["pool_pre_ping"] = True

    db_engine = create_engine(resolved_url, **engine_kwargs)

    if is_sqlite:
        @event.listens_for(db_engine, "connect")
        def _enable_sqlite_foreign_keys(dbapi_connection: Any, _: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return db_engine


engine = create_db_engine()
SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
    class_=Session,
)


def _add_missing_columns(
    inspector: Any,
    resolved_engine: Engine,
    table_name: str,
    columns_sql: dict[str, str],
) -> None:
    """Safely append missing columns via ALTER TABLE for existing SQLite/Postgres databases."""
    if table_name not in inspector.get_table_names():
        return
    existing_cols = {col["name"] for col in inspector.get_columns(table_name)}
    missing = [(name, col_def) for name, col_def in columns_sql.items() if name not in existing_cols]
    if not missing:
        return
    with resolved_engine.begin() as conn:
        for col_name, col_def in missing:
            conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_def}"))


def init_db(target_engine: Engine | None = None) -> None:
    """Create all database tables and apply safe additive column migrations if missing."""
    import app.models  # noqa: F401

    resolved_engine = target_engine or engine
    Base.metadata.create_all(bind=resolved_engine)

    inspector = inspect(resolved_engine)
    is_pg = resolved_engine.dialect.name == "postgresql"
    binary_type = "BYTEA" if is_pg else "BLOB"
    bool_default_false = "BOOLEAN NOT NULL DEFAULT FALSE" if is_pg else "BOOLEAN NOT NULL DEFAULT 0"

    _add_missing_columns(
        inspector,
        resolved_engine,
        "meal_entries",
        {
            "photo_data": binary_type,
            "photo_mime_type": "VARCHAR(64)",
        },
    )
    _add_missing_columns(
        inspector,
        resolved_engine,
        "users",
        {
            "notifications_enabled": bool_default_false,
            "breakfast_time": "VARCHAR(5) NOT NULL DEFAULT '08:30'",
            "lunch_time": "VARCHAR(5) NOT NULL DEFAULT '13:00'",
            "dinner_time": "VARCHAR(5) NOT NULL DEFAULT '19:30'",
            "reminder_timezone": "VARCHAR(64) NOT NULL DEFAULT 'UTC'",
            "last_breakfast_sent_date": "VARCHAR(10)",
            "last_lunch_sent_date": "VARCHAR(10)",
            "last_dinner_sent_date": "VARCHAR(10)",
        },
    )


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding a scoped SQLAlchemy session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
