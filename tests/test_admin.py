"""Admin auth tests — login, session cookie, protected endpoint, logout."""
import pytest
from httpx import AsyncClient
from unittest.mock import patch

from aiops_server.config import Config

# Bcrypt hash of "test-admin-password" — pre-computed so tests don't need to hash
TEST_PASSWORD = "test-admin-password"
TEST_PASSWORD_HASH = "$2b$12$hHdkQOl.MFygBr/FSKfFFumxEozUoC7nEQI1Xa1XuL1JvHVcV8sle"
TEST_ADMIN_EMAIL = "admin@elliotsystems.com"


def _patched_config(base: Config) -> Config:
    """Return a copy of Config with the test password hash and admin email."""
    data = base.model_dump()
    data["admin_password_hash"] = TEST_PASSWORD_HASH
    data["admin_email"] = TEST_ADMIN_EMAIL
    return Config(**data)


@pytest.mark.asyncio
async def test_login_wrong_password(client: AsyncClient) -> None:
    from aiops_server.main import app
    from aiops_server.config import get_config
    base_config = get_config()
    app.dependency_overrides[get_config] = lambda: _patched_config(base_config)
    try:
        resp = await client.post("/admin/login", json={"password": "wrong"})
        assert resp.status_code == 401
        assert resp.json()["error"] == "invalid_credentials"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_me_unauthenticated(client: AsyncClient) -> None:
    resp = await client.get("/admin/me")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_login_sets_cookie(client: AsyncClient) -> None:
    from aiops_server.config import get_config
    base_config = get_config()

    with patch("aiops_server.routers.admin.get_config", return_value=lambda: _patched_config(base_config)):
        with patch("aiops_server.security.get_config", return_value=lambda: _patched_config(base_config)):
            # Use a fresh client call with the patched config injected via dependency override
            from aiops_server.main import app
            app.dependency_overrides[get_config] = lambda: _patched_config(base_config)
            try:
                resp = await client.post("/admin/login", json={"password": TEST_PASSWORD})
                assert resp.status_code == 200
                data = resp.json()
                assert data["ok"] is True
                assert data["email"] == TEST_ADMIN_EMAIL
                assert "aiops_session" in resp.cookies
            finally:
                app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_full_admin_flow(client: AsyncClient) -> None:
    """Login → /me returns email → logout → /me returns 401."""
    from aiops_server.main import app
    from aiops_server.config import get_config
    base_config = get_config()

    app.dependency_overrides[get_config] = lambda: _patched_config(base_config)
    try:
        login_resp = await client.post("/admin/login", json={"password": TEST_PASSWORD})
        assert login_resp.status_code == 200

        me_resp = await client.get("/admin/me")
        assert me_resp.status_code == 200
        assert me_resp.json()["email"] == TEST_ADMIN_EMAIL

        logout_resp = await client.post("/admin/logout")
        assert logout_resp.status_code == 200

        me_after = await client.get("/admin/me")
        assert me_after.status_code == 401
    finally:
        app.dependency_overrides.clear()
