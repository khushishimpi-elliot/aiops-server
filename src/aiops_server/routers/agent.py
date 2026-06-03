import hashlib
import secrets
from datetime import date as date_type

import asyncpg
from fastapi import APIRouter, Depends, Header

from ..config import Config, get_config
from ..db import get_db
from ..errors import AppError
from ..models import (
    AgentEnrollRequest,
    AgentEnrollResponse,
    AgentSyncRequest,
)
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

router = APIRouter(prefix="/api", tags=["agent"])

_ENROLLMENT_TOKEN_TTL = 900  # 15 minutes


def _serializer(config: Config) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(
        config.session_secret.get_secret_value(),
        salt="enrollment-v1",
    )


def _hash_machine_id(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@router.post("/enroll", response_model=AgentEnrollResponse)
async def agent_enroll(
    body: AgentEnrollRequest,
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
) -> AgentEnrollResponse:
    try:
        data = _serializer(config).loads(
            body.enrollment_token, max_age=_ENROLLMENT_TOKEN_TTL
        )
    except SignatureExpired:
        raise AppError(401, "enrollment_token_expired")
    except BadSignature:
        raise AppError(401, "invalid_enrollment_token")

    email: str = data["email"]
    machine_id_hash = _hash_machine_id(body.machine_id)

    if await conn.fetchval(
        "SELECT 1 FROM devices WHERE machine_id = $1 AND status = 'revoked'",
        machine_id_hash,
    ):
        raise AppError(403, "device_permanently_revoked")

    async with conn.transaction():
        team_id = await conn.fetchval(
            "SELECT team_id FROM domains WHERE domain = $1",
            email.split("@")[1].lower(),
        )
        if team_id is None:
            raise AppError(403, "domain_not_allowed")

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

        api_token = secrets.token_urlsafe(32)
        token_hash = _hash_token(api_token)

        label = body.hostname or body.machine_id
        agent_version = body.os

        device_id: int = await conn.fetchval(
            """
            INSERT INTO devices(user_id, machine_id, label, agent_version, last_seen_at, api_token_hash)
            VALUES ($1, $2, $3, $4, now(), $5)
            RETURNING id
            """,
            user_id, machine_id_hash, label, agent_version, token_hash,
        )

        await conn.execute(
            """
            INSERT INTO audit_log(actor, action, target_type, target_id, detail)
            VALUES ($1, 'agent_enroll', 'device', $2, $3)
            """,
            email,
            device_id,
            {"machine_id_prefix": machine_id_hash[:8], "hostname": body.hostname},
        )

    return AgentEnrollResponse(api_token=api_token, device_id=device_id, user_id=user_id)


@router.post("/telemetry/daily-rollup")
async def agent_sync(
    body: AgentSyncRequest,
    x_enrollment_token: str = Header(alias="x-enrollment-token"),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict:
    token_hash = _hash_token(x_enrollment_token)

    device = await conn.fetchrow(
        "SELECT id, user_id, status FROM devices WHERE api_token_hash = $1",
        token_hash,
    )
    if device is None:
        raise AppError(401, "invalid_api_token")
    if device["status"] != "active":
        raise AppError(403, "device_revoked")

    deleted_at = await conn.fetchval(
        "SELECT deleted_at FROM users WHERE id = $1", device["user_id"]
    )
    if deleted_at is not None:
        raise AppError(403, "user_not_active")

    device_id: int = device["id"]
    user_id: int = device["user_id"]

    # Build the full set of rows up front, then persist with batched
    # executemany() calls inside a single transaction. Doing one awaited
    # INSERT per aggregate previously meant ~2 sequential DB round-trips per
    # row, which made large rollups take 20s+ and time out the client.
    usage_rows = []
    category_rows = []
    for agg in body.aggregates:
        parsed_date = date_type.fromisoformat(agg.date)
        cost_millicents = round(agg.cost_usd * 100_000)
        cache_read = agg.cache_tokens // 2
        cache_write = agg.cache_tokens - cache_read

        ikey = hashlib.sha256(
            f"{token_hash}:{agg.date}:{agg.tool}:{agg.model}:{agg.category or ''}".encode()
        ).hexdigest()[:64]

        usage_rows.append((
            user_id, device_id, parsed_date,
            agg.tool, agg.model,
            agg.input_tokens, agg.output_tokens,
            cache_read, cache_write,
            cost_millicents, agg.sessions, agg.total_turns, ikey,
        ))

        if agg.category:
            cat_ikey = hashlib.sha256(f"{ikey}:cat".encode()).hexdigest()[:64]
            category_rows.append((
                user_id, device_id, parsed_date,
                agg.category, agg.sessions, cat_ikey,
            ))

    # The agent re-sends cumulative daily totals on every sync, so a colliding
    # idempotency_key means "this day was re-synced with fresher numbers" — we
    # overwrite (last-write-wins) rather than DO NOTHING, which would freeze a
    # day's totals at the first sync and hide later sessions from the dashboard.
    async with conn.transaction():
        if usage_rows:
            await conn.executemany(
                """
                INSERT INTO usage(
                    user_id, device_id, date, tool, model,
                    input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens,
                    cost_millicents, sessions, total_turns, idempotency_key
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                ON CONFLICT (idempotency_key) DO UPDATE SET
                    input_tokens       = EXCLUDED.input_tokens,
                    output_tokens      = EXCLUDED.output_tokens,
                    cache_read_tokens  = EXCLUDED.cache_read_tokens,
                    cache_write_tokens = EXCLUDED.cache_write_tokens,
                    cost_millicents    = EXCLUDED.cost_millicents,
                    sessions           = EXCLUDED.sessions,
                    total_turns        = EXCLUDED.total_turns,
                    recorded_at        = now()
                """,
                usage_rows,
            )

        if category_rows:
            await conn.executemany(
                """
                INSERT INTO usage_categories(user_id, device_id, date, category, session_count, idempotency_key)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (idempotency_key) DO UPDATE SET
                    session_count = EXCLUDED.session_count,
                    recorded_at   = now()
                """,
                category_rows,
            )

        await conn.execute(
            "UPDATE devices SET last_seen_at = now() WHERE id = $1",
            device_id,
        )

    # ON CONFLICT DO NOTHING means some rows may already exist; we report the
    # number submitted rather than tracking per-row insert results (executemany
    # does not return rowcounts).
    return {"ok": True, "stored": len(usage_rows), "total": len(body.aggregates)}
