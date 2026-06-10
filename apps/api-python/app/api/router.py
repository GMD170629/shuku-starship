from fastapi import APIRouter

from app.api.routes import auth, compat, health

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(compat.router, tags=["compat"])
