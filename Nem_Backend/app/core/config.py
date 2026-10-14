from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "NEM Machine Monitoring API"
    database_url: str = "sqlite:///./machine_monitor.db"
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

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
