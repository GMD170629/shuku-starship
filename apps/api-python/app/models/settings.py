from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def cuid() -> str:
    return f"py_{uuid4().hex}"


def db_timestamp() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class MonitorFolder(Base):
    __tablename__ = "MonitorFolder"

    id: Mapped[str] = mapped_column(String(191), primary_key=True, default=cuid)
    name: Mapped[str] = mapped_column(String(191), nullable=False)
    root_path: Mapped[str] = mapped_column("rootPath", String(191), unique=True, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    ignore_patterns: Mapped[str | None] = mapped_column("ignorePatterns", Text, nullable=True)
    ignore_hidden: Mapped[bool] = mapped_column("ignoreHidden", Boolean, nullable=False, default=True)
    min_file_size_bytes: Mapped[int] = mapped_column("minFileSizeBytes", Integer, nullable=False, default=10240)
    description: Mapped[str | None] = mapped_column(String(191), nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, nullable=False, default=db_timestamp, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, nullable=False, default=db_timestamp, onupdate=db_timestamp, server_default=func.now())


class SystemSetting(Base):
    __tablename__ = "SystemSetting"

    key: Mapped[str] = mapped_column(String(191), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, nullable=False, default=db_timestamp, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, nullable=False, default=db_timestamp, onupdate=db_timestamp, server_default=func.now())


class SystemEvent(Base):
    __tablename__ = "SystemEvent"

    id: Mapped[str] = mapped_column(String(191), primary_key=True, default=cuid)
    level: Mapped[str] = mapped_column(String(191), nullable=False, default="info")
    source: Mapped[str] = mapped_column(String(191), nullable=False)
    actor_type: Mapped[str] = mapped_column("actorType", String(191), nullable=False, default="system")
    actor_id: Mapped[str | None] = mapped_column("actorId", String(191), nullable=True)
    action: Mapped[str] = mapped_column(String(191), nullable=False)
    target_type: Mapped[str | None] = mapped_column("targetType", String(191), nullable=True)
    target_id: Mapped[str | None] = mapped_column("targetId", String(191), nullable=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, nullable=False, default=db_timestamp, server_default=func.now())
