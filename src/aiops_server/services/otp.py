import secrets
from datetime import datetime, timedelta, timezone

import asyncpg
import bcrypt

OTP_DIGITS = 6
OTP_EXPIRY_MINUTES = 10
OTP_MAX_PER_HOUR = 10


def _generate_code() -> str:
    return str(secrets.randbelow(10 ** OTP_DIGITS)).zfill(OTP_DIGITS)


def _hash_code(code: str) -> str:
    return bcrypt.hashpw(code.encode(), bcrypt.gensalt()).decode()


def _verify_code(code: str, code_hash: str) -> bool:
    return bcrypt.checkpw(code.encode(), code_hash.encode())


async def within_rate_limit(conn: asyncpg.Connection, email: str) -> bool:
    count: int = await conn.fetchval(
        """
        SELECT COUNT(*) FROM otp_requests
        WHERE email = $1
          AND created_at > now() - INTERVAL '1 hour'
        """,
        email,
    )
    return count < OTP_MAX_PER_HOUR


async def create_otp(
    conn: asyncpg.Connection,
    email: str,
    ip_address: str | None,
) -> tuple[str, datetime]:
    """Insert a new OTP row and return (plaintext_code, expires_at)."""
    code = _generate_code()
    code_hash = _hash_code(code)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=OTP_EXPIRY_MINUTES)

    await conn.execute(
        """
        INSERT INTO otp_requests(email, code_hash, expires_at, ip_address)
        VALUES ($1, $2, $3, $4::inet)
        """,
        email, code_hash, expires_at, ip_address,
    )
    return code, expires_at


async def consume_otp(conn: asyncpg.Connection, email: str, code: str) -> bool:
    """Verify and mark used. Returns True on success, False on invalid/expired."""
    row = await conn.fetchrow(
        """
        SELECT id, code_hash FROM otp_requests
        WHERE email    = $1
          AND used_at  IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
        """,
        email,
    )
    if row is None or not _verify_code(code, row["code_hash"]):
        return False

    await conn.execute(
        "UPDATE otp_requests SET used_at = now() WHERE id = $1",
        row["id"],
    )
    return True
