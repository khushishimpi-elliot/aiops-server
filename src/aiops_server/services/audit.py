import asyncpg


async def log(
    conn: asyncpg.Connection,
    actor: str,
    action: str,
    target_type: str | None = None,
    target_id: int | None = None,
    detail: dict | None = None,
) -> None:
    await conn.execute(
        """
        INSERT INTO audit_log(actor, action, target_type, target_id, detail)
        VALUES ($1, $2, $3, $4, $5)
        """,
        actor, action, target_type, target_id, detail,
    )
