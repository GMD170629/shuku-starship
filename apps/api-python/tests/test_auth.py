from app.core.auth import hash_password
from app.models.auth import User
from sqlalchemy import event


def test_login_me_and_logout(client, db_session):
    user = User(email="admin@example.com", name="管理员", password_hash=hash_password("starshipnas"), role="admin")
    db_session.add(user)
    db_session.commit()

    login = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "starshipnas"})
    assert login.status_code == 200
    assert login.json()["ok"] is True
    assert login.json()["data"]["user"]["email"] == "admin@example.com"
    assert "shuku_session" in login.cookies

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["data"]["user"]["role"] == "admin"

    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert logout.json()["data"]["loggedOut"] is True


def test_login_rejects_bad_password(client, db_session):
    user = User(email="admin@example.com", name="管理员", password_hash=hash_password("starshipnas"), role="admin")
    db_session.add(user)
    db_session.commit()

    response = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "wrong"})

    assert response.status_code == 401
    assert response.json()["ok"] is False


def test_login_session_insert_sends_updated_at(client, db_session):
    user = User(email="admin@example.com", name="管理员", password_hash=hash_password("starshipnas"), role="admin")
    db_session.add(user)
    db_session.commit()
    statements: list[str] = []

    def capture_statement(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(db_session.bind, "before_cursor_execute", capture_statement)
    try:
        response = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "starshipnas"})
    finally:
        event.remove(db_session.bind, "before_cursor_execute", capture_statement)

    assert response.status_code == 200
    session_inserts = [statement for statement in statements if "INSERT INTO" in statement and "Session" in statement]
    assert session_inserts
    assert "updatedAt" in session_inserts[-1]


def test_me_requires_session(client):
    response = client.get("/api/auth/me")

    assert response.status_code == 401
    assert response.json()["ok"] is False
