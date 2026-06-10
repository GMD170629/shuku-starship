from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def cuid() -> str:
    return f"py_{uuid4().hex}"


class User(Base):
    __tablename__ = "User"

    id: Mapped[str] = mapped_column(String(191), primary_key=True, default=cuid)
    email: Mapped[str] = mapped_column(String(191), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(191), nullable=False)
    password_hash: Mapped[str] = mapped_column("passwordHash", String(191), nullable=False)
    role: Mapped[str] = mapped_column(String(191), nullable=False, default="admin")
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    sessions: Mapped[list[Session]] = relationship("Session", back_populates="user", cascade="all, delete-orphan")

    def to_auth_view(self) -> dict[str, str]:
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "role": self.role,
        }


class Session(Base):
    __tablename__ = "Session"

    id: Mapped[str] = mapped_column(String(191), primary_key=True, default=cuid)
    token_hash: Mapped[str] = mapped_column("tokenHash", String(191), unique=True, nullable=False)
    user_id: Mapped[str] = mapped_column("userId", String(191), ForeignKey("User.id", ondelete="CASCADE"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    user: Mapped[User] = relationship("User", back_populates="sessions")
