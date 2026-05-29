"""Telemetry ingestion tests — cost computation, idempotency, validation."""
import datetime
import hashlib
import time

import pytest
from httpx import AsyncClient


def _idem_key(seed: str) -> str:
    return hashlib.sha256(f"{seed}-{time.time()}".encode()).hexdigest()[:32]


def _rollup(device_id: int, **overrides) -> dict:
    base = {
        "device_id": device_id,
        "date": datetime.date.today().isoformat(),
        "tool": "claude_code",
        "model": "claude-sonnet-4-5",
        "input_tokens": 1000,
        "output_tokens": 500,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "idempotency_key": _idem_key("base"),
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_daily_rollup_success(
    client: AsyncClient, test_device: tuple[int, int]
) -> None:
    _, device_id = test_device
    payload = _rollup(device_id, idempotency_key=_idem_key("success"))

    resp = await client.post("/telemetry/daily-rollup", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["usage_id"] > 0
    # 1000 input * 300 mc/1k + 500 output * 1500 mc/1k = 300 + 750 = 1050 mc
    assert data["cost_millicents"] == 1050


@pytest.mark.asyncio
async def test_daily_rollup_idempotent(
    client: AsyncClient, test_device: tuple[int, int]
) -> None:
    _, device_id = test_device
    key = _idem_key("idempotent")
    payload = _rollup(device_id, idempotency_key=key)

    resp1 = await client.post("/telemetry/daily-rollup", json=payload)
    assert resp1.status_code == 200

    resp2 = await client.post("/telemetry/daily-rollup", json=payload)
    assert resp2.status_code == 200

    # Same usage_id and cost on both attempts
    assert resp1.json()["usage_id"] == resp2.json()["usage_id"]
    assert resp1.json()["cost_millicents"] == resp2.json()["cost_millicents"]


@pytest.mark.asyncio
async def test_daily_rollup_device_not_found(client: AsyncClient) -> None:
    payload = _rollup(device_id=999999999, idempotency_key=_idem_key("no-device"))
    resp = await client.post("/telemetry/daily-rollup", json=payload)
    assert resp.status_code == 404
    assert resp.json()["error"] == "device_not_found"


@pytest.mark.asyncio
async def test_daily_rollup_pricing_not_found(
    client: AsyncClient, test_device: tuple[int, int]
) -> None:
    _, device_id = test_device
    payload = _rollup(
        device_id,
        tool="unknown_tool",
        model="unknown-model-9000",
        idempotency_key=_idem_key("no-pricing"),
    )
    resp = await client.post("/telemetry/daily-rollup", json=payload)
    assert resp.status_code == 422
    assert resp.json()["error"] == "pricing_not_found"


@pytest.mark.asyncio
async def test_daily_rollup_cost_with_cache(
    client: AsyncClient, test_device: tuple[int, int]
) -> None:
    _, device_id = test_device
    payload = _rollup(
        device_id,
        input_tokens=2000,
        output_tokens=1000,
        cache_read_tokens=5000,
        cache_write_tokens=500,
        idempotency_key=_idem_key("cache-cost"),
    )
    resp = await client.post("/telemetry/daily-rollup", json=payload)
    assert resp.status_code == 200, resp.text

    # claude-sonnet-4-5 rates: inp=300, out=1500, cr=30, cw=375 mc/1k
    # (2000*300 + 1000*1500 + 5000*30 + 500*375) // 1000
    # = (600000 + 1500000 + 150000 + 187500) // 1000
    # = 2437500 // 1000 = 2437
    assert resp.json()["cost_millicents"] == 2437


@pytest.mark.asyncio
async def test_daily_rollup_updates_agent_version(
    client: AsyncClient, test_device: tuple[int, int]
) -> None:
    _, device_id = test_device
    payload = _rollup(
        device_id,
        agent_version="2.0.0",
        idempotency_key=_idem_key("agent-ver"),
    )
    resp = await client.post("/telemetry/daily-rollup", json=payload)
    assert resp.status_code == 200

    from aiops_server.db import _pool
    async with _pool.acquire() as conn:
        version = await conn.fetchval(
            "SELECT agent_version FROM devices WHERE id = $1", device_id
        )
    assert version == "2.0.0"
