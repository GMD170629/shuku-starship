from __future__ import annotations

from datetime import datetime
from hashlib import sha1
from importlib import resources
import logging
import re

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.core.auth import hash_password
from app.core.config import Settings

LOGGER = logging.getLogger(__name__)
MYSQL_URL_PREFIXES = ("mysql://", "mysql+pymysql://")
IGNORABLE_MYSQL_ERROR_CODES = {
    1050,  # table already exists
    1061,  # duplicate key name
    1062,  # duplicate entry
    1091,  # can't drop/check missing object during idempotent sync
    1826,  # duplicate foreign key constraint name
}


def bootstrap_database(engine: Engine, settings: Settings) -> None:
    """Initialize the production MySQL schema and baseline data."""
    if not settings.database_url.startswith(MYSQL_URL_PREFIXES):
        return

    apply_schema(engine)
    with Session(engine) as db:
        seed_baseline_data(db, settings)


def apply_schema(engine: Engine) -> None:
    ddl = resources.files("app.db").joinpath("schema.sql").read_text(encoding="utf-8")
    ddl = "\n".join(line for line in ddl.splitlines() if not line.strip().startswith("--"))
    statements = [statement.strip() for statement in re.split(r";\s*(?:\n|$)", ddl) if statement.strip()]

    with engine.begin() as connection:
        for statement in statements:
            try:
                connection.execute(text(statement))
            except (OperationalError, ProgrammingError) as exc:
                if _mysql_error_code(exc) in IGNORABLE_MYSQL_ERROR_CODES:
                    continue
                raise


def seed_baseline_data(db: Session, settings: Settings) -> None:
    now = datetime.now()
    existing_user_id = db.execute(text("SELECT `id` FROM `User` WHERE `email` = :email"), {"email": settings.admin_email}).scalar()
    if existing_user_id:
        db.execute(
            text("UPDATE `User` SET `name` = :name, `role` = 'admin', `updatedAt` = :now WHERE `id` = :id"),
            {"id": existing_user_id, "name": settings.admin_name, "now": now},
        )
    else:
        db.execute(
            text(
                "INSERT INTO `User` (`id`, `email`, `name`, `passwordHash`, `role`, `createdAt`, `updatedAt`) "
                "VALUES (:id, :email, :name, :password_hash, 'admin', :now, :now)"
            ),
            {
                "id": f"py_{sha1(settings.admin_email.encode('utf-8')).hexdigest()[:24]}",
                "email": settings.admin_email,
                "name": settings.admin_name,
                "password_hash": hash_password(settings.admin_password),
                "now": now,
            },
        )

    system_settings = {
        "systemName": "书库星舰",
        "theme": "system",
        "language": "zh-CN",
        "timezone": "Asia/Shanghai",
    }
    for key, value in system_settings.items():
        exists = db.execute(text("SELECT `key` FROM `SystemSetting` WHERE `key` = :key"), {"key": key}).scalar()
        if exists:
            db.execute(text("UPDATE `SystemSetting` SET `value` = :value, `updatedAt` = :now WHERE `key` = :key"), {"key": key, "value": value, "now": now})
        else:
            db.execute(
                text("INSERT INTO `SystemSetting` (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, :now, :now)"),
                {"key": key, "value": value, "now": now},
            )
    db.commit()
    LOGGER.info("database bootstrap complete: admin=%s", settings.admin_email)


def _mysql_error_code(exc: OperationalError | ProgrammingError) -> int | None:
    original = getattr(exc, "orig", None)
    args = getattr(original, "args", ())
    if args and isinstance(args[0], int):
        return args[0]
    return None


def main() -> None:
    from app.core.config import get_settings
    from app.db.session import engine

    bootstrap_database(engine, get_settings())


if __name__ == "__main__":
    main()
