from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core.auth import clear_session_cookie, create_session, delete_session_cookie, get_current_user, set_session_cookie, verify_password
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.models.auth import User
from app.schemas.auth import LoginRequest
from app.schemas.responses import fail, ok

router = APIRouter()


@router.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user = db.query(User).filter(User.email == payload.email).one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        return fail("邮箱或密码不正确", status_code=401)

    user_session, token = create_session(db, user.id)
    response = ok({"user": user.to_auth_view()})
    set_session_cookie(response, token, user_session.expires_at, settings)
    return response


@router.get("/me")
def me(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, token, refreshed_expires_at = get_current_user(db, request, settings)
    if user is None:
        return fail("UNAUTHORIZED", status_code=401)
    response = ok({"user": user.to_auth_view()})
    if token is not None and refreshed_expires_at is not None:
        set_session_cookie(response, token, refreshed_expires_at, settings)
    return response


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    clear_session_cookie(db, request, settings)
    response = ok({"loggedOut": True})
    delete_session_cookie(response, settings)
    return response
