import asyncpg
from fastapi import APIRouter, Depends, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from ..config import Config, get_config
from ..db import get_db
from ..errors import AppError
from ..models import (
    DiscoverRequest,
    DiscoverResponse,
    EnrollRequest,
    EnrollResponse,
    SendOtpRequest,
    SendOtpResponse,
    VerifyOtpRequest,
    VerifyOtpResponse,
)
from ..services import otp as otp_svc
from ..services.email import send_otp_email

router = APIRouter(prefix="/enroll", tags=["enrollment"])

_ENROLLMENT_TOKEN_TTL = 900  # 15 minutes


def _serializer(config: Config) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(
        config.session_secret.get_secret_value(),
        salt="enrollment-v1",
    )


@router.post("/discover", response_model=DiscoverResponse)
async def discover(
    body: DiscoverRequest,
    conn: asyncpg.Connection = Depends(get_db),
) -> DiscoverResponse:
    domain = str(body.email).split("@")[1].lower()
    exists = await conn.fetchval(
        "SELECT 1 FROM domains WHERE domain = $1", domain
    )
    return DiscoverResponse(allowed=bool(exists))


@router.post("/send-otp", response_model=SendOtpResponse)
async def send_otp(
    request: Request,
    body: SendOtpRequest,
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
) -> SendOtpResponse:
    email = str(body.email)
    domain = email.split("@")[1].lower()

    allowed = await conn.fetchval("SELECT 1 FROM domains WHERE domain = $1", domain)
    if not allowed:
        raise AppError(403, "domain_not_allowed")

    if not await otp_svc.within_rate_limit(conn, email):
        raise AppError(429, "otp_rate_limit_exceeded", "Max 3 OTPs per hour.")

    ip = request.client.host if request.client else None
    code, _ = await otp_svc.create_otp(conn, email, ip)
    await send_otp_email(config, email, code)

    return SendOtpResponse(expires_in_seconds=600)


@router.post("/verify-otp", response_model=VerifyOtpResponse)
async def verify_otp(
    body: VerifyOtpRequest,
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
) -> VerifyOtpResponse:
    email = str(body.email)
    if not await otp_svc.consume_otp(conn, email, body.code):
        raise AppError(401, "invalid_or_expired_otp")

    token = _serializer(config).dumps({"email": email})
    return VerifyOtpResponse(enrollment_token=token)


@router.post("/device", response_model=EnrollResponse)
async def enroll_device(
    body: EnrollRequest,
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
) -> EnrollResponse:
    try:
        data = _serializer(config).loads(
            body.enrollment_token, max_age=_ENROLLMENT_TOKEN_TTL
        )
    except SignatureExpired:
        raise AppError(401, "enrollment_token_expired")
    except BadSignature:
        raise AppError(401, "invalid_enrollment_token")

    email: str = data["email"]

    # Permanent revocation check — machine blocked forever once revoked
    if await conn.fetchval(
        "SELECT 1 FROM devices WHERE machine_id = $1 AND status = 'revoked'",
        body.machine_id,
    ):
        raise AppError(403, "device_permanently_revoked")

    async with conn.transaction():
        team_id = await conn.fetchval(
            "SELECT team_id FROM domains WHERE domain = $1",
            email.split("@")[1].lower(),
        )
        if team_id is None:
            raise AppError(403, "domain_not_allowed")

        # Look up or create user; reject if previously purged
        user_row = await conn.fetchrow(
            "SELECT id, deleted_at FROM users WHERE email = $1", email
        )
        if user_row and user_row["deleted_at"] is not None:
            raise AppError(403, "user_purged")

        if user_row:
            user_id: int = user_row["id"]
        else:
            user_id = await conn.fetchval(
                "INSERT INTO users(team_id, email) VALUES($1, $2) RETURNING id",
                team_id, email,
            )

        device_id: int = await conn.fetchval(
            """
            INSERT INTO devices(user_id, machine_id, label, agent_version, last_seen_at)
            VALUES ($1, $2, $3, $4, now())
            RETURNING id
            """,
            user_id, body.machine_id, body.label, body.agent_version,
        )

        await conn.execute(
            """
            INSERT INTO audit_log(actor, action, target_type, target_id, detail)
            VALUES ($1, 'enroll_device', 'device', $2, $3)
            """,
            email,
            device_id,
            {"machine_id_prefix": body.machine_id[:8]},
        )

    return EnrollResponse(device_id=device_id, user_id=user_id)
