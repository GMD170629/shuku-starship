from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Shuku Starship Python API"
    app_version: str = "0.1.0"
    database_url: str = "mysql+pymysql://shuku:shuku@127.0.0.1:3306/shuku_starship"
    session_secret: str | None = None
    monitor_root: str | None = "/monitor"
    storage_root: str = "/app/storage"
    download_inbox_path: str = "/app/storage/downloads/inbox"
    demo_mode: bool = False
    next_public_demo_mode: bool = False
    admin_email: str = "admin@example.com"
    admin_password: str = "starshipnas"
    admin_name: str = "管理员"
    secure_cookies: bool = False
    download_queue_enabled: bool = True
    download_queue_interval_seconds: int = Field(default=5, ge=1)
    qbittorrent_url: str | None = None
    qbittorrent_username: str | None = None
    qbittorrent_password: str | None = None
    qbittorrent_category: str | None = None
    qbittorrent_save_path: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("database_url", mode="before")
    @classmethod
    def normalize_database_url(cls, value: str | None) -> str | None:
        if isinstance(value, str) and value.startswith("mysql://"):
            return f"mysql+pymysql://{value.removeprefix('mysql://')}"
        return value

    @property
    def resolved_storage_root(self) -> Path:
        return Path(self.storage_root).expanduser().resolve()

    @property
    def resolved_download_inbox_path(self) -> Path:
        return Path(self.download_inbox_path).expanduser().resolve()

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
