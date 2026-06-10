from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Shuku Starship Python API"
    app_version: str = "0.1.0"
    database_url: str = "mysql+pymysql://shuku:shuku@127.0.0.1:3306/shuku_starship"
    session_secret: str | None = None
    monitor_root: str | None = None
    storage_root: str = "./storage"
    demo_mode: bool = False
    next_public_demo_mode: bool = False
    admin_email: str = "admin@example.com"
    admin_password: str = "starshipnas"
    admin_name: str = "管理员"
    file_streams_per_user: int = Field(default=4, ge=1)
    slow_file_request_ms: int = Field(default=1500, ge=1)
    secure_cookies: bool = False

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def resolved_storage_root(self) -> Path:
        return Path(self.storage_root).expanduser().resolve()

    @property
    def resolved_monitor_root(self) -> Path | None:
        if not self.monitor_root:
            return None
        return Path(self.monitor_root).expanduser().resolve()

    @property
    def is_demo_mode(self) -> bool:
        return self.demo_mode or self.next_public_demo_mode


@lru_cache
def get_settings() -> Settings:
    return Settings()
