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
