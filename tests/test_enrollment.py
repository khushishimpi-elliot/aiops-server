"""Enrollment flow tests — run against a real DB (test Neon branch).

These tests require DATABASE_URL to point at a database that already has the
schema applied. They are intentionally integration-style: we care that the DB
constraints, OTP hashing, and signed tokens all work end-to-end, not just that
the router parses JSON.
"""
import hashlib
import time
import pytest
from httpx import AsyncClient
from unittest.mock import patch


KNOWN_DOMAIN_EMAIL = f"test.user.{int(time.time())}@elliotsystems.com"
UNKNOWN_DOMAIN_EMAIL = "outsider@gmail.com"
MACHINE_ID = hashlib.sha256(b"test-machine-001").hexdigest()


@pytest.mark.asyncio
async def test_discover_allowed(client: AsyncClient) -> None:
    resp = await client.post("/enroll/discover", json={"email": KNOWN_DOMAIN_EMAIL})
    assert resp.status_code == 200
    assert resp.json()["allowed"] is True


@pytest.mark.asyncio
async def test_discover_unknown_domain(client: AsyncClient) -> None:
    resp = await client.post("/enroll/discover", json={"email": UNKNOWN_DOMAIN_EMAIL})
    assert resp.status_code == 200
    assert resp.json()["allowed"] is False


@pytest.mark.asyncio
async def test_send_otp_unknown_domain(client: AsyncClient) -> None:
    resp = await client.post("/enroll/send-otp", json={"email": UNKNOWN_DOMAIN_EMAIL})
    assert resp.status_code == 403
    assert resp.json()["error"] == "domain_not_allowed"


@pytest.mark.asyncio
async def test_verify_otp_wrong_code(client: AsyncClient) -> None:
    resp = await client.post(
        "/enroll/verify-otp",
        json={"email": KNOWN_DOMAIN_EMAIL, "code": "000000"},
    )
    assert resp.status_code == 401
    assert resp.json()["error"] == "invalid_or_expired_otp"


@pytest.mark.asyncio
async def test_enroll_invalid_token(client: AsyncClient) -> None:
    resp = await client.post(
        "/enroll/device",
        json={
            "enrollment_token": "not.a.valid.token",
            "machine_id": MACHINE_ID,
        },
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_full_enrollment_flow(client: AsyncClient) -> None:
    """Happy path: send-otp → verify-otp → enroll device.

    Patches send_otp_email so no real email is sent, and intercepts the OTP
    code by inspecting what was passed to send_otp_email.
    """
    captured: list[str] = []

    async def fake_send(config, to, code):
        captured.append(code)

    with patch("aiops_server.routers.enrollment.send_otp_email", side_effect=fake_send):
        otp_resp = await client.post(
            "/enroll/send-otp", json={"email": KNOWN_DOMAIN_EMAIL}
        )
        assert otp_resp.status_code == 200
        assert otp_resp.json()["expires_in_seconds"] == 600

        code = captured[0]
        assert len(code) == 6 and code.isdigit()

        verify_resp = await client.post(
            "/enroll/verify-otp",
            json={"email": KNOWN_DOMAIN_EMAIL, "code": code},
        )
        assert verify_resp.status_code == 200
        token = verify_resp.json()["enrollment_token"]
        assert token

    machine_id = hashlib.sha256(b"test-machine-full-flow").hexdigest()
    enroll_resp = await client.post(
        "/enroll/device",
        json={
            "enrollment_token": token,
            "machine_id": machine_id,
            "label": "Dev laptop",
            "agent_version": "1.0.0",
        },
    )
    assert enroll_resp.status_code == 200
    data = enroll_resp.json()
    assert data["device_id"] > 0
    assert data["user_id"] > 0
