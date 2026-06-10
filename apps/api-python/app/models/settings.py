from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Enum, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def cuid() -> str:
    return f"py_{uuid4().hex}"


class MonitorImportMode(StrEnum):
    COPY = "COPY"
    MOVE = "MOVE"


class MonitorFolder(Base):
    __tablename__ = "MonitorFolder"

    id: Mapped[str] = mapped_column(String(191), primary_key=True, default=cuid)
    name: Mapped[str] = mapped_column(String(191), nullable=False)
    root_path: Mapped[str] = mapped_column("rootPath", String(191), unique=True, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    import_mode: Mapped[MonitorImportMode] = mapped_column("importMode", Enum(MonitorImportMode), nullable=False, default=MonitorImportMode.COPY)
    ignore_patterns: Mapped[str | None] = mapped_column("ignorePatterns", Text, nullable=True)
    ignore_hidden: Mapped[bool] = mapped_column("ignoreHidden", Boolean, nullable=False, default=True)
    min_file_size_bytes: Mapped[int] = mapped_column("minFileSizeBytes", Integer, nullable=False, default=10240)
    description: Mapped[str | None] = mapped_column(String(191), nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class SystemSetting(Base):
    __tablename__ = "SystemSetting"

    key: Mapped[str] = mapped_column(String(191), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
