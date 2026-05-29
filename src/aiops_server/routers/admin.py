import asyncpg
from fastapi import APIRouter, Cookie, Depends, Query, Response
from pydantic import BaseModel, ConfigDict

from ..config import Config, get_config
from ..db import get_db
from ..errors import AppError
from ..models import (
    AuditLogItem,
    DeviceAdminItem,
    DomainItem,
    RegisterDomainRequest,
    UserAdminItem,
)
from ..security import (
    COOKIE_NAME,
    create_session,
    delete_session,
    require_admin,
    verify_admin_password,
)
from ..services import audit

router = APIRouter(prefix="/admin", tags=["admin"])


class LoginRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    password: str


class LoginResponse(BaseModel):
    ok: bool
    email: str


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest,
    response: Response,
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
) -> LoginResponse:
    if not verify_admin_password(body.password, config):
        raise AppError(401, "invalid_credentials")

    await create_session(conn, config, response, config.admin_email)
    await audit.log(conn, config.admin_email, "admin_login")

    return LoginResponse(ok=True, email=config.admin_email)


@router.post("/logout")
async def logout(
    response: Response,
    aiops_session: str | None = Cookie(default=None),
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
) -> dict:
    if aiops_session:
        await delete_session(conn, config, aiops_session)
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
async def me(admin_email: str = Depends(require_admin)) -> dict:
    return {"email": admin_email}


# ---------------------------------------------------------------------------
# Domains
# ---------------------------------------------------------------------------

@router.get("/domains", response_model=list[DomainItem])
async def list_domains(
    conn: asyncpg.Connection = Depends(get_db),
    admin_email: str = Depends(require_admin),
) -> list[DomainItem]:
    rows = await conn.fetch(
        "SELECT id, domain, created_at FROM domains ORDER BY domain"
    )
    return [DomainItem(id=r["id"], domain=r["domain"], created_at=r["created_at"]) for r in rows]


@router.post("/domains", response_model=DomainItem, status_code=201)
async def register_domain(
    body: RegisterDomainRequest,
    conn: asyncpg.Connection = Depends(get_db),
    config: Config = Depends(get_config),
    admin_email: str = Depends(require_admin),
) -> DomainItem:
    team_id = await conn.fetchval("SELECT id FROM teams LIMIT 1")
    if team_id is None:
        raise AppError(500, "no_team", "No team exists to attach domain to")

    existing = await conn.fetchval(
        "SELECT id FROM domains WHERE domain = $1", body.domain
    )
    if existing:
        raise AppError(409, "domain_already_registered")

    domain_id, created_at = await conn.fetchrow(
        "INSERT INTO domains(team_id, domain) VALUES ($1, $2) RETURNING id, created_at",
        team_id, body.domain,
    )

    await audit.log(conn, admin_email, "register_domain", "domain", domain_id,
                    {"domain": body.domain})

    return DomainItem(id=domain_id, domain=body.domain, created_at=created_at)


@router.delete("/domains/{domain_id}", status_code=204)
async def delete_domain(
    domain_id: int,
    conn: asyncpg.Connection = Depends(get_db),
    admin_email: str = Depends(require_admin),
) -> None:
    row = await conn.fetchrow(
        "SELECT id, domain FROM domains WHERE id = $1", domain_id
    )
    if row is None:
        raise AppError(404, "domain_not_found")

    await conn.execute("DELETE FROM domains WHERE id = $1", domain_id)
    await audit.log(conn, admin_email, "delete_domain", "domain", domain_id,
                    {"domain": row["domain"]})


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

@router.get("/users", response_model=list[UserAdminItem])
async def list_users(
    include_deleted: bool = Query(default=False),
    conn: asyncpg.Connection = Depends(get_db),
    _: str = Depends(require_admin),
) -> list[UserAdminItem]:
    rows = await conn.fetch(
        """
        SELECT
            u.id,
            u.email,
            u.created_at,
            u.deleted_at,
            COALESCE(SUM(us.cost_millicents), 0)::bigint AS total_cost_millicents,
            COUNT(DISTINCT d.id) FILTER (WHERE d.status = 'active')::int AS active_devices
        FROM   users u
        LEFT JOIN usage   us ON us.user_id = u.id
        LEFT JOIN devices d  ON d.user_id  = u.id
        WHERE  ($1 OR u.deleted_at IS NULL)
        GROUP  BY u.id, u.email, u.created_at, u.deleted_at
        ORDER  BY total_cost_millicents DESC
        """,
        include_deleted,
    )
    return [
        UserAdminItem(
            user_id=r["id"],
            email=r["email"],
            enrolled_at=r["created_at"],
            deleted_at=r["deleted_at"],
            total_cost_millicents=r["total_cost_millicents"],
            active_devices=r["active_devices"] or 0,
        )
        for r in rows
    ]


@router.delete("/users/{user_id}", status_code=204)
async def purge_user(
    user_id: int,
    conn: asyncpg.Connection = Depends(get_db),
    admin_email: str = Depends(require_admin),
) -> None:
    exists = await conn.fetchval(
        "SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", user_id
    )
    if exists is None:
        raise AppError(404, "user_not_found")

    # purge_user() handles device revocation, email anonymisation, and audit row
    await conn.execute("SELECT purge_user($1, $2)", user_id, admin_email)


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

@router.get("/devices", response_model=list[DeviceAdminItem])
async def list_devices(
    status: str | None = Query(default=None, pattern="^(active|revoked)$"),
    conn: asyncpg.Connection = Depends(get_db),
    _: str = Depends(require_admin),
) -> list[DeviceAdminItem]:
    rows = await conn.fetch(
        """
        SELECT
            d.id, d.user_id, d.machine_id, d.label, d.agent_version,
            d.last_seen_at, d.status, d.enrolled_at,
            u.email AS user_email
        FROM   devices d
        JOIN   users   u ON u.id = d.user_id
        WHERE  ($1::text IS NULL OR d.status = $1)
        ORDER  BY d.enrolled_at DESC
        """,
        status,
    )
    return [
        DeviceAdminItem(
            device_id=r["id"],
            user_id=r["user_id"],
            user_email=r["user_email"],
            machine_id_prefix=r["machine_id"][:12] + "...",
            label=r["label"],
            agent_version=r["agent_version"],
            last_seen_at=r["last_seen_at"],
            status=r["status"],
            enrolled_at=r["enrolled_at"],
        )
        for r in rows
    ]


@router.post("/devices/{device_id}/revoke", status_code=204)
async def revoke_device(
    device_id: int,
    conn: asyncpg.Connection = Depends(get_db),
    admin_email: str = Depends(require_admin),
) -> None:
    row = await conn.fetchrow(
        "SELECT id, status FROM devices WHERE id = $1", device_id
    )
    if row is None:
        raise AppError(404, "device_not_found")
    if row["status"] == "revoked":
        raise AppError(409, "device_already_revoked")

    await conn.execute(
        "UPDATE devices SET status = 'revoked' WHERE id = $1", device_id
    )
    await audit.log(conn, admin_email, "revoke_device", "device", device_id)


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

@router.get("/audit-log", response_model=list[AuditLogItem])
async def audit_log(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    actor: str | None = None,
    action: str | None = None,
    conn: asyncpg.Connection = Depends(get_db),
    _: str = Depends(require_admin),
) -> list[AuditLogItem]:
    rows = await conn.fetch(
        """
        SELECT id, actor, action, target_type, target_id, detail, created_at
        FROM   audit_log
        WHERE  ($1::text IS NULL OR actor  = $1)
          AND  ($2::text IS NULL OR action = $2)
        ORDER  BY created_at DESC
        LIMIT  $3 OFFSET $4
        """,
        actor, action, limit, offset,
    )
    return [
        AuditLogItem(
            id=r["id"],
            actor=r["actor"],
            action=r["action"],
            target_type=r["target_type"],
            target_id=r["target_id"],
            detail=r["detail"],
            created_at=r["created_at"],
        )
        for r in rows
    ]
