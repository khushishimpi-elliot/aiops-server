"""Admin management endpoint tests — domains, users, devices, audit log."""
import hashlib
import time

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


@pytest.fixture(autouse=True)
async def logged_in(client: AsyncClient, patch_config):
    await client.post("/admin/login", json={"password": TEST_PASSWORD})
    yield


# ---------------------------------------------------------------------------
# Domains
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_domains(client: AsyncClient) -> None:
    resp = await client.get("/admin/domains")
    assert resp.status_code == 200
    domains = resp.json()
    assert isinstance(domains, list)
    assert any(d["domain"] == "elliotsystems.com" for d in domains)


@pytest.mark.asyncio
async def test_register_and_delete_domain(client: AsyncClient) -> None:
    new_domain = f"test-{int(time.time())}.example.com"

    create_resp = await client.post("/admin/domains", json={"domain": new_domain})
    assert create_resp.status_code == 201
    domain_id = create_resp.json()["id"]
    assert create_resp.json()["domain"] == new_domain

    # Domain should appear in list
    list_resp = await client.get("/admin/domains")
    assert any(d["domain"] == new_domain for d in list_resp.json())

    # Delete it
    del_resp = await client.delete(f"/admin/domains/{domain_id}")
    assert del_resp.status_code == 204

    # Gone from list
    list_after = await client.get("/admin/domains")
    assert not any(d["domain"] == new_domain for d in list_after.json())


@pytest.mark.asyncio
async def test_register_duplicate_domain(client: AsyncClient) -> None:
    resp = await client.post("/admin/domains", json={"domain": "elliotsystems.com"})
    assert resp.status_code == 409
    assert resp.json()["error"] == "domain_already_registered"


@pytest.mark.asyncio
async def test_delete_nonexistent_domain(client: AsyncClient) -> None:
    resp = await client.delete("/admin/domains/999999999")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_users(client: AsyncClient) -> None:
    resp = await client.get("/admin/users")
    assert resp.status_code == 200
    users = resp.json()
    assert isinstance(users, list)
    assert len(users) > 0
    assert all("user_id" in u for u in users)
    assert all("total_cost_millicents" in u for u in users)


@pytest.mark.asyncio
async def test_purge_user(client: AsyncClient) -> None:
    """Create a throwaway user, purge it, verify it no longer appears in active list."""
    from aiops_server.db import _pool

    stamp = int(time.time())
    email = f"purge.test.{stamp}@elliotsystems.com"

    async with _pool.acquire() as conn:
        team_id = await conn.fetchval("SELECT id FROM teams WHERE name = 'Elliot Systems'")
        user_id = await conn.fetchval(
            "INSERT INTO users(team_id, email) VALUES ($1, $2) RETURNING id",
            team_id, email,
        )

    resp = await client.delete(f"/admin/users/{user_id}")
    assert resp.status_code == 204

    # User should not appear in the active list
    list_resp = await client.get("/admin/users")
    active_ids = [u["user_id"] for u in list_resp.json()]
    assert user_id not in active_ids

    # But visible with include_deleted=true
    deleted_resp = await client.get("/admin/users?include_deleted=true")
    all_ids = [u["user_id"] for u in deleted_resp.json()]
    assert user_id in all_ids


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_devices(client: AsyncClient, test_device) -> None:
    resp = await client.get("/admin/devices")
    assert resp.status_code == 200
    devices = resp.json()
    assert isinstance(devices, list)
    _, device_id = test_device
    assert any(d["device_id"] == device_id for d in devices)


@pytest.mark.asyncio
async def test_revoke_device(client: AsyncClient) -> None:
    """Create a throwaway device, revoke it, verify status changes."""
    from aiops_server.db import _pool

    stamp = int(time.time())
    email = f"revoke.test.{stamp}@elliotsystems.com"
    machine_id = hashlib.sha256(f"revoke-{stamp}".encode()).hexdigest()

    async with _pool.acquire() as conn:
        team_id = await conn.fetchval("SELECT id FROM teams WHERE name = 'Elliot Systems'")
        user_id = await conn.fetchval(
            "INSERT INTO users(team_id, email) VALUES ($1, $2) RETURNING id",
            team_id, email,
        )
        device_id = await conn.fetchval(
            "INSERT INTO devices(user_id, machine_id, label) VALUES ($1, $2, 'throwaway') RETURNING id",
            user_id, machine_id,
        )

    resp = await client.post(f"/admin/devices/{device_id}/revoke")
    assert resp.status_code == 204

    # Revoked device shows in filtered list
    revoked_resp = await client.get("/admin/devices?status=revoked")
    assert any(d["device_id"] == device_id for d in revoked_resp.json())


@pytest.mark.asyncio
async def test_revoke_already_revoked(client: AsyncClient) -> None:
    from aiops_server.db import _pool

    stamp = int(time.time())
    machine_id = hashlib.sha256(f"double-revoke-{stamp}".encode()).hexdigest()

    async with _pool.acquire() as conn:
        team_id = await conn.fetchval("SELECT id FROM teams WHERE name = 'Elliot Systems'")
        user_id = await conn.fetchval(
            "INSERT INTO users(team_id, email) VALUES ($1, $2) RETURNING id",
            team_id, f"double.revoke.{stamp}@elliotsystems.com",
        )
        device_id = await conn.fetchval(
            "INSERT INTO devices(user_id, machine_id, label, status) VALUES ($1, $2, 'x', 'revoked') RETURNING id",
            user_id, machine_id,
        )

    resp = await client.post(f"/admin/devices/{device_id}/revoke")
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_audit_log_returns_entries(client: AsyncClient) -> None:
    resp = await client.get("/admin/audit-log")
    assert resp.status_code == 200
    entries = resp.json()
    assert isinstance(entries, list)
    assert len(entries) > 0
    assert all("actor" in e and "action" in e for e in entries)


@pytest.mark.asyncio
async def test_audit_log_pagination(client: AsyncClient) -> None:
    resp1 = await client.get("/admin/audit-log?limit=2&offset=0")
    resp2 = await client.get("/admin/audit-log?limit=2&offset=2")
    assert resp1.status_code == 200
    assert resp2.status_code == 200
    ids1 = {e["id"] for e in resp1.json()}
    ids2 = {e["id"] for e in resp2.json()}
    assert ids1.isdisjoint(ids2)


@pytest.mark.asyncio
async def test_audit_log_filter_by_action(client: AsyncClient) -> None:
    resp = await client.get("/admin/audit-log?action=admin_login")
    assert resp.status_code == 200
    entries = resp.json()
    assert all(e["action"] == "admin_login" for e in entries)
