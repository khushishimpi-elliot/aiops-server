import json
from typing import AsyncGenerator

import asyncpg
from fastapi import Depends

from .config import Config, get_config

_pool: asyncpg.Pool | None = None


async def _setup_codecs(conn: asyncpg.Connection) -> None:
    # Register Python dict/list ↔ JSONB automatically for every connection in the pool.
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


async def init_pool(config: Config) -> None:
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=config.database_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
        init=_setup_codecs,
    )
    await _run_startup_migrations()


async def _run_startup_migrations() -> None:
    """Idempotent schema patches applied at boot.

    Render deploys code but never runs migration files; a deploy that
    references a column before the migration was applied manually has
    already taken the dashboard down once (ff782c9/ebde058). Anything
    here must be safe to run on every startup.
    """
    assert _pool is not None
    async with _pool.acquire() as conn:
        # 005_usage_session_count.sql
        await conn.execute(
            "ALTER TABLE usage ADD COLUMN IF NOT EXISTS session_count int NOT NULL DEFAULT 0"
        )


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def get_db(
    config: Config = Depends(get_config),
) -> AsyncGenerator[asyncpg.Connection, None]:
    if _pool is None:
        await init_pool(config)
    async with _pool.acquire() as conn:  # type: ignore[union-attr]
        yield conn
