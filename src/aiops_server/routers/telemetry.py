import hashlib
from datetime import date as date_type

import asyncpg
from asyncpg.exceptions import UniqueViolationError
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import AppError
from ..models import (
    CategoryRollupRequest,
    CategoryRollupResponse,
    DailyRollupRequest,
    DailyRollupResponse,
)
from ..services.pricing import compute_cost

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


@router.post("/daily-rollup", response_model=DailyRollupResponse)
async def daily_rollup(
    body: DailyRollupRequest,
    conn: asyncpg.Connection = Depends(get_db),
) -> DailyRollupResponse:
    # Device must exist and be active
    device = await conn.fetchrow(
        "SELECT user_id, status FROM devices WHERE id = $1",
        body.device_id,
    )
    if device is None:
        raise AppError(404, "device_not_found")
    if device["status"] != "active":
        raise AppError(403, "device_revoked")

    # User must not be purged
    deleted_at = await conn.fetchval(
        "SELECT deleted_at FROM users WHERE id = $1",
        device["user_id"],
    )
    if deleted_at is not None:
        raise AppError(403, "user_not_active")

    cost_millicents = await compute_cost(
        conn,
        body.tool,
        body.model,
        body.input_tokens,
        body.output_tokens,
        body.cache_read_tokens,
        body.cache_write_tokens,
    )

    parsed_date = date_type.fromisoformat(body.date)

    try:
        async with conn.transaction():
            usage_id: int = await conn.fetchval(
                """
                INSERT INTO usage(
                    user_id, device_id, date, tool, model,
                    input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens,
                    cost_millicents, idempotency_key
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                RETURNING id
                """,
                device["user_id"], body.device_id, parsed_date,
                body.tool, body.model,
                body.input_tokens, body.output_tokens,
                body.cache_read_tokens, body.cache_write_tokens,
                cost_millicents, body.idempotency_key,
            )

            # Keep device heartbeat and agent version current
            await conn.execute(
                """
                UPDATE devices
                SET last_seen_at  = now(),
                    agent_version = COALESCE($2, agent_version)
                WHERE id = $1
                """,
                body.device_id,
                body.agent_version,
            )

    except UniqueViolationError:
        # Idempotent retry — return the original row unchanged
        row = await conn.fetchrow(
            "SELECT id, cost_millicents FROM usage WHERE idempotency_key = $1",
            body.idempotency_key,
        )
        return DailyRollupResponse(
            usage_id=row["id"],
            cost_millicents=row["cost_millicents"],
        )

    return DailyRollupResponse(usage_id=usage_id, cost_millicents=cost_millicents)


@router.post("/categories", response_model=CategoryRollupResponse)
async def submit_categories(
    body: CategoryRollupRequest,
    conn: asyncpg.Connection = Depends(get_db),
) -> CategoryRollupResponse:
    device = await conn.fetchrow(
        "SELECT user_id, status FROM devices WHERE id = $1", body.device_id
    )
    if device is None:
        raise AppError(404, "device_not_found")
    if device["status"] != "active":
        raise AppError(403, "device_revoked")

    user_id: int = device["user_id"]
    parsed_date = date_type.fromisoformat(body.date)

    async with conn.transaction():
        for category, count in body.categories.items():
            if count <= 0:
                continue
            cat_ikey = hashlib.sha256(
                f"{body.idempotency_key}:{category}".encode()
            ).hexdigest()[:64]
            await conn.execute(
                """
                INSERT INTO usage_categories(user_id, device_id, date, category, session_count, idempotency_key)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (idempotency_key) DO NOTHING
                """,
                user_id, body.device_id, parsed_date, category, count, cat_ikey,
            )

    return CategoryRollupResponse(ok=True)
