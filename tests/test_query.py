"""Query endpoint tests — developers list, developer detail, org overview."""
import pytest
from httpx import AsyncClient

from aiops_server.config import get_config
from aiops_server.main import app

TEST_PASSWORD = "test-admin-password"
TEST_PASSWORD_HASH = "$2b$12$hHdkQOl.MFygBr/FSKfFFumxEozUoC7nEQI1Xa1XuL1JvHVcV8sle"
TEST_ADMIN_EMAIL = "admin@elliotsystems.com"


def _patched_config(base):
    data = base.model_dump()
    data["admin_password_hash"] = TEST_PASSWORD_HASH
    data["admin_email"] = TEST_ADMIN_EMAIL
    from aiops_server.config import Config
    return Config(**data)


@pytest.fixture(autouse=True)
def patch_config():
    base = get_config()
    app.dependency_overrides[get_config] = lambda: _patched_config(base)
    yield
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_developers_requires_auth(client: AsyncClient) -> None:
    await client.post("/admin/logout")  # session-scoped client may carry a cookie
    resp = await client.get("/api/developers")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_developers_list(client: AsyncClient) -> None:
    await client.post("/admin/login", json={"password": TEST_PASSWORD})
    resp = await client.get("/api/developers")
    assert resp.status_code == 200
    data = resp.json()
    assert "developers" in data
    assert "period_days" in data
    assert isinstance(data["developers"], list)


@pytest.mark.asyncio
async def test_developers_list_with_days_param(client: AsyncClient) -> None:
    await client.post("/admin/login", json={"password": TEST_PASSWORD})
    resp = await client.get("/api/developers?days=7")
    assert resp.status_code == 200
    assert resp.json()["period_days"] == 7


@pytest.mark.asyncio
async def test_developer_detail_not_found(client: AsyncClient) -> None:
    await client.post("/admin/login", json={"password": TEST_PASSWORD})
    resp = await client.get("/api/developer/nobody@elliotsystems.com")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_developer_detail(client: AsyncClient, test_device) -> None:
    user_id, device_id = test_device
    await client.post("/admin/login", json={"password": TEST_PASSWORD})

    # Get the email for the seeded test user
    from aiops_server.db import _pool
    async with _pool.acquire() as conn:
        email = await conn.fetchval("SELECT email FROM users WHERE id = $1", user_id)

    resp = await client.get(f"/api/developer/{email}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["user_id"] == user_id
    assert data["email"] == email
    assert "by_tool_model" in data
    assert "daily" in data


@pytest.mark.asyncio
async def test_org_overview(client: AsyncClient) -> None:
    await client.post("/admin/login", json={"password": TEST_PASSWORD})
    resp = await client.get("/api/org")
    assert resp.status_code == 200
    data = resp.json()
    assert "total_cost_millicents" in data
    assert "active_developers" in data
    assert "by_tool_model" in data
    assert data["period_days"] == 30


@pytest.mark.asyncio
async def test_org_overview_breakdown_structure(client: AsyncClient) -> None:
    """by_tool_model entries have the expected fields and non-negative numbers."""
    await client.post("/admin/login", json={"password": TEST_PASSWORD})
    resp = await client.get("/api/org")
    assert resp.status_code == 200
    for entry in resp.json()["by_tool_model"]:
        assert "tool" in entry and "model" in entry
        assert entry["cost_millicents"] >= 0
        assert entry["input_tokens"] >= 0
        assert entry["days_active"] >= 1
