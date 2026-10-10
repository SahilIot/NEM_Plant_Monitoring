from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    app_name: str = "NEM Machine Monitoring API"
    database_url: str = "sqlite:///./machine_monitor.db"
    cors_origins: str = ""
    monitoring_evaluation_interval_seconds: int = Field(default=15, ge=1, le=3600)
    monitoring_scheduler_enabled: bool = True
    monitoring_default_stale_after_seconds: int = Field(default=300, ge=1, le=31_536_000)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
