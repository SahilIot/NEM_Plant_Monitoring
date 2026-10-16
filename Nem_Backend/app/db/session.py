from datetime import datetime, timezone
from typing import Generator

from fastapi import Request
from sqlalchemy import DateTime, Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from app.core.config import get_settings, validate_postgresql_database_url


class UTCDateTime(TypeDecorator[datetime]):
    """Expose aware UTC datetimes while storing UTC-naive timestamps."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
        return value.replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


def create_database_engine(database_url: str | None = None) -> Engine:
    url = get_settings().database_url if database_url is None else database_url
    validate_postgresql_database_url(url)
    return create_engine(url, pool_pre_ping=True)


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db(request: Request) -> Generator[Session, None, None]:
    with request.app.state.session_factory() as session:
        yield session
