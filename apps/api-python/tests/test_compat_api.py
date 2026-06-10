from app.core.auth import hash_password
from app.models.auth import User


def _login(client, db_session):
    user = User(email="admin@example.com", name="管理员", password_hash=hash_password("starshipnas"), role="admin")
    db_session.add(user)
    db_session.commit()
    response = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "starshipnas"})
    assert response.status_code == 200


def test_core_compat_endpoints_return_envelopes(client, db_session, test_settings):
    test_settings.resolved_monitor_root.mkdir(parents=True)
    _login(client, db_session)

    endpoints = [
        "/api/dashboard/summary",
        "/api/dashboard/recent-books",
        "/api/dashboard/continue-reading",
        "/api/dashboard/system-status",
        "/api/works",
        "/api/monitor-folders",
        "/api/system-settings",
        "/api/reader/preferences",
        "/api/download-tasks",
        "/api/import-tasks",
        "/api/sources",
        "/api/source-search-records",
        "/api/shelves",
        "/api/organize/jobs",
        "/api/organize/pending",
        "/api/backups",
        "/api/tracking/release-title-parser?title=Example%20Vol.3%20Ch.4",
    ]

    for endpoint in endpoints:
        response = client.get(endpoint)
        assert response.status_code == 200, endpoint
        payload = response.json()
        assert payload["ok"] is True, endpoint
        assert "data" in payload, endpoint


def test_monitor_folder_and_system_settings_mutations(client, db_session, test_settings):
    test_settings.resolved_monitor_root.mkdir(parents=True)
    _login(client, db_session)

    created = client.post(
        "/api/monitor-folders",
        json={"name": "Inbox", "rootPath": str(test_settings.resolved_monitor_root), "enabled": True},
    )
    assert created.status_code == 201
    folder_id = created.json()["data"]["folder"]["id"]

    updated = client.put(f"/api/monitor-folders/{folder_id}", json={"enabled": False, "importMode": "MOVE"})
    assert updated.status_code == 200
    assert updated.json()["data"]["folder"]["enabled"] is False

    settings = client.put("/api/system-settings", json={"settings": {"readerTheme": "dark"}})
    assert settings.status_code == 200
    assert settings.json()["data"]["settings"]["readerTheme"] == "dark"
