from functools import lru_cache

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError


def validate_postgresql_database_url(value: str) -> str:
    try:
        url = make_url(value)
    except ArgumentError as error:
        raise ValueError("Database URL must be a valid PostgreSQL psycopg URL") from error
    if url.drivername != "postgresql+psycopg" or not url.database:
        raise ValueError("Database URL must use postgresql+psycopg and name a database")
    return value


class Settings(BaseSettings):
    app_name: str = "NEM Machine Monitoring API"
    database_url: str
    test_database_url: str | None = None
    backup_directory: str = "backups"
    settings_encryption_key: SecretStr = SecretStr("")
    cors_origins: str = ""
    monitoring_evaluation_interval_seconds: int = Field(default=15, ge=1, le=3600)
    monitoring_scheduler_enabled: bool = True
    monitoring_default_stale_after_seconds: int = Field(default=300, ge=1, le=31_536_000)
    opcua_endpoint: str = ""
    opcua_client_cert: str = ""
    opcua_client_key: str = ""
    opcua_server_cert: str = ""
    opcua_username: str = ""
    opcua_password: SecretStr = SecretStr("")
    opcua_timeout_seconds: int = Field(default=10, ge=1, le=120)
    opcua_machine_mappings: str = ""
    opcua_reconnect_delay_seconds: int = Field(default=5, ge=1, le=300)
    opcua_runtime_checkpoint_seconds: int = Field(default=10, ge=1, le=300)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @field_validator("database_url", "test_database_url")
    @classmethod
    def validate_database_urls(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_postgresql_database_url(value)

    @model_validator(mode="after")
    def validate_test_database_isolation(self) -> "Settings":
        if self.test_database_url is None:
            return self

        production_database = make_url(self.database_url).database
        test_database = make_url(self.test_database_url).database
        if test_database.casefold() in {"postgres", "template0", "template1"}:
            raise ValueError("TEST_DATABASE_URL must use a dedicated, non-system database")
        if test_database.casefold() == production_database.casefold():
            raise ValueError("TEST_DATABASE_URL must not point to DATABASE_URL's database")
        return self

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
