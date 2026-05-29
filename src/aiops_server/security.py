import secrets
from datetime import datetime, timedelta, timezone

import asyncpg
import bcrypt
from fastapi import Cookie, Depends, Response
from itsdangerous import BadSignature, URLSafeSerializer

from .config import Config, get_config
from .db import get_db
from .errors import AppError

COOKIE_NAME = "aiops_session"


def verify_admin_password(plain: str, config: Config) -> bool:
    try:
        return bcrypt.checkpw(
            plain.encode(),
            config.admin_password_hash.get_secret_value().encode(),
        )
    except ValueError:
        # Malformed hash in config — treat as wrong password, not a 500
        return False


def _signer(config: Config) -> URLSafeSerializer:
    return URLSafeSerializer(
        config.session_secret.get_secret_value(),
        salt="admin-session-v1",
    )


async def create_session(
    conn: asyncpg.Connection,
    config: Config,
    response: Response,
    admin_email: str,
) -> None:
    session_id = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=config.session_lifetime_hours)

    await conn.execute(
        "INSERT INTO admin_sessions(id, admin_email, expires_at) VALUES ($1, $2, $3)",
        session_id, admin_email, expires_at,
    )

    signed = _signer(config).dumps(session_id)
    response.set_cookie(
        COOKIE_NAME,
        signed,
        httponly=True,
        samesite="strict",
        secure=config.cookie_secure,
        max_age=config.session_lifetime_hours * 3600,
        path="/",
    )


async def delete_session(
    conn: asyncpg.Connection,
    config: Config,
    cookie_value: str,
) -> None:
    try:
        session_id = _signer(config).loads(cookie_value)
        await conn.execute("DELETE FROM admin_sessions WHERE id = $1", session_id)
    except BadSignature:
        pass  # invalid cookie on logout is fine — just clear it


async def require_admin(
    aiops_session: str | None = Cookie(default=None),
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
) -> str:
    if aiops_session is None:
        raise AppError(401, "not_authenticated")

    try:
        session_id: str = _signer(config).loads(aiops_session)
    except BadSignature:
        raise AppError(401, "invalid_session")

    row = await conn.fetchrow(
        "SELECT admin_email, expires_at FROM admin_sessions WHERE id = $1",
        session_id,
    )
    if row is None:
        raise AppError(401, "session_not_found")
    if row["expires_at"].replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise AppError(401, "session_expired")

    return str(row["admin_email"])
