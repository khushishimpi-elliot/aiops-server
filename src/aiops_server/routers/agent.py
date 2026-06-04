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

        # Re-enrolling the same machine must REUSE its device row (rotating
        # the token), not insert a duplicate — duplicate devices kept their
        # old usage rows and double-counted everything on the dashboard.
        device_id: int | None = await conn.fetchval(
            """
            UPDATE devices
            SET    api_token_hash = $3, label = $4, agent_version = $5, last_seen_at = now()
            WHERE  id = (
                SELECT id FROM devices
                WHERE  user_id = $1 AND machine_id = $2 AND status = 'active'
                ORDER  BY id DESC LIMIT 1
            )
            RETURNING id
            """,
            user_id, machine_id_hash, token_hash, label, agent_version,
        )
        if device_id is None:
            device_id = await conn.fetchval(
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

    usage_rows: list[tuple] = []
    category_rows: list[tuple] = []
    usage_ikeys: list[str] = []
    category_ikeys: list[str] = []
    payload_dates: set[date_type] = set()

    for agg in body.aggregates:
        parsed_date = date_type.fromisoformat(agg.date)
        payload_dates.add(parsed_date)
        cost_millicents = round(agg.cost_usd * 100_000)
        cache_read = agg.cache_tokens // 2
        cache_write = agg.cache_tokens - cache_read

        # Keyed by device_id, NOT the api token: enrollment rotates the
        # token, and token-based keys orphaned every prior row on
        # re-enroll, so the next sync re-inserted the whole history as
        # duplicates and the dashboard double-counted.
        ikey = hashlib.sha256(
            f"dev{device_id}:{agg.date}:{agg.tool}:{agg.model}:{agg.category or ''}".encode()
        ).hexdigest()[:64]
        usage_ikeys.append(ikey)

        usage_rows.append((
            user_id, device_id, parsed_date,
            agg.tool, agg.model,
            agg.input_tokens, agg.output_tokens,
            cache_read, cache_write,
            cost_millicents, agg.sessions, ikey,
        ))

        if agg.category:
            cat_ikey = hashlib.sha256(f"{ikey}:cat".encode()).hexdigest()[:64]
            category_ikeys.append(cat_ikey)
            category_rows.append((
                user_id, device_id, parsed_date,
                agg.category, agg.sessions, cat_ikey,
            ))

    # The agent sends CUMULATIVE daily totals recomputed from its full local
    # DB on every sync, so a conflict means "newer totals for the same day" —
    # overwrite, never drop (DO NOTHING froze the dashboard at the first-sync
    # snapshot). Batched: per-row round-trips made large rollups take >20s.
    async with conn.transaction():
        await conn.executemany(
            """
            INSERT INTO usage(
                user_id, device_id, date, tool, model,
                input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens,
                cost_millicents, session_count, idempotency_key
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT (idempotency_key) DO UPDATE SET
                input_tokens       = EXCLUDED.input_tokens,
                output_tokens      = EXCLUDED.output_tokens,
                cache_read_tokens  = EXCLUDED.cache_read_tokens,
                cache_write_tokens = EXCLUDED.cache_write_tokens,
                cost_millicents    = EXCLUDED.cost_millicents,
                session_count      = EXCLUDED.session_count,
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
                    session_count = EXCLUDED.session_count
                """,
                category_rows,
            )

        # The payload is the authoritative snapshot for every date it covers:
        # remove rows for THIS MACHINE (any of its device rows — re-enrollment
        # used to create duplicates) on those dates that the agent no longer
        # reports. Catches tool renames (claude_code -> claude), category
        # reclassification, and old token-based idempotency keys, all of which
        # left stale rows behind that inflated dashboard counts.
        dates = sorted(payload_dates)
        # Remove stale rows for the covered dates — two cases:
        # 1. Same machine_id, different device (re-enrollment created a new row)
        # 2. Old token-based idempotency keys (NOT LIKE 'dev%') — these come from
        #    enrollments before the key format changed; machine_id may differ
        #    (old /enroll/device flow hashed differently than /api/enroll).
        await conn.execute(
            """
            DELETE FROM usage u
            USING devices d, devices me
            WHERE me.id = $1
              AND d.user_id = me.user_id AND d.machine_id = me.machine_id
              AND u.device_id = d.id
              AND u.date = ANY($2::date[])
              AND u.idempotency_key != ALL($3::text[])
            """,
            device_id, dates, usage_ikeys,
        )
        # Also wipe any old-format (token-hash) rows for this user on these dates
        await conn.execute(
            """
            DELETE FROM usage
            WHERE user_id = $1
              AND date = ANY($2::date[])
              AND idempotency_key NOT LIKE 'dev%'
            """,
            user_id, dates,
        )
        await conn.execute(
            """
            DELETE FROM usage_categories u
            USING devices d, devices me
            WHERE me.id = $1
              AND d.user_id = me.user_id AND d.machine_id = me.machine_id
              AND u.device_id = d.id
              AND u.date = ANY($2::date[])
              AND u.idempotency_key != ALL($3::text[])
            """,
            device_id, dates, category_ikeys,
        )
        await conn.execute(
            """
            DELETE FROM usage_categories
            WHERE user_id = $1
              AND date = ANY($2::date[])
              AND idempotency_key NOT LIKE 'dev%'
            """,
            user_id, dates,
        )

    stored = len(usage_rows)

    await conn.execute(
        "UPDATE devices SET last_seen_at = now() WHERE id = $1",
        device_id,
    )

    return {"ok": True, "stored": stored, "total": len(body.aggregates)}
