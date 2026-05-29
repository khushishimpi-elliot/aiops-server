import hashlib
import time

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from aiops_server.main import app


@pytest_asyncio.fixture(scope="session")
async def client():
    # ASGITransport triggers the app lifespan, which initialises the asyncpg pool
    # once for the whole test session.
    async with AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=True),
        base_url="http://test",
    ) as c:
        yield c


@pytest_asyncio.fixture(scope="session")
async def test_device(client: AsyncClient):
    """Insert a real user + device into the DB and return (user_id, device_id).

    Uses a timestamp suffix so parallel test runs don't collide.
    The client fixture is listed as a dep so the pool is guaranteed to be open.
    """
    from aiops_server.db import _pool

    stamp = int(time.time())
    email = f"telemetry.test.{stamp}@elliotsystems.com"
    machine_id = hashlib.sha256(f"test-telemetry-{stamp}".encode()).hexdigest()

    async with _pool.acquire() as conn:
        team_id = await conn.fetchval(
            "SELECT id FROM teams WHERE name = 'Elliot Systems'"
        )
        user_id = await conn.fetchval(
            "INSERT INTO users(team_id, email) VALUES ($1, $2) RETURNING id",
            team_id,
            email,
        )
        device_id = await conn.fetchval(
            """
            INSERT INTO devices(user_id, machine_id, label, last_seen_at)
            VALUES ($1, $2, 'telemetry-test-device', now())
            RETURNING id
            """,
            user_id,
            machine_id,
        )

    return user_id, device_id
