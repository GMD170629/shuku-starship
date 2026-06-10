from app.core.config import get_settings


def main() -> None:
    settings = get_settings()
    raise SystemExit(
        "Python worker skeleton is installed but not active yet. "
        f"MONITOR_ROOT={settings.monitor_root or '<unset>'}"
    )


if __name__ == "__main__":
    main()
