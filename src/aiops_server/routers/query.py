import asyncpg
from fastapi import APIRouter, Depends, Query

from ..db import get_db
from ..errors import AppError
from ..models import (
    DailyToolRow,
    DevDetailResponse,
    DevSummaryResponse,
    DailyUsage,
    DevSummaryItem,
    OrgOverviewResponse,
    TaskCategoryItem,
    ToolModelBreakdown,
)
from ..security import require_admin

router = APIRouter(prefix="/api", tags=["query"])

_TOOL_MODEL_SQL = """
    SELECT tool, model,
           SUM(cost_millicents)::bigint  AS cost_millicents,
           SUM(input_tokens)::bigint     AS input_tokens,
           SUM(output_tokens)::bigint    AS output_tokens,
           COUNT(DISTINCT date)::int     AS days_active,
           SUM(session_count)::int       AS session_count
    FROM   usage
    WHERE  {where}
    GROUP BY tool, model
    ORDER BY cost_millicents DESC
"""


@router.get("/developers", response_model=DevSummaryResponse)
async def list_developers(
    days: int = Query(default=30, ge=1, le=365),
    conn: asyncpg.Connection = Depends(get_db),
    _: str = Depends(require_admin),
) -> DevSummaryResponse:
    rows = await conn.fetch(
        """
        SELECT
            u.id,
            u.email,
            u.created_at,
            COALESCE(us.total_cost_millicents, 0)::bigint  AS total_cost_millicents,
            COALESCE(us.total_input_tokens,    0)::bigint  AS total_input_tokens,
            COALESCE(us.total_output_tokens,   0)::bigint  AS total_output_tokens,
            -- Last active = most recent day the developer actually used the tool
            -- (usage.date from the Claude logs), all-time — independent of the
            -- selected window. Clamp to CURRENT_DATE to handle timezone-related
            -- date discrepancies that may push dates into the future.
            LEAST((SELECT MAX(us2.date) FROM usage us2 WHERE us2.user_id = u.id), CURRENT_DATE) AS last_active,
            COALESCE(d.active_devices, 0)::int             AS active_devices
        FROM   users u
        LEFT JOIN (
            SELECT user_id,
                   SUM(cost_millicents)::bigint AS total_cost_millicents,
                   SUM(input_tokens)::bigint    AS total_input_tokens,
                   SUM(output_tokens)::bigint   AS total_output_tokens
            FROM   usage
            WHERE  date >= CURRENT_DATE - $1::integer
            GROUP  BY user_id
        ) us ON us.user_id = u.id
        LEFT JOIN (
            SELECT user_id, COUNT(*)::int AS active_devices
            FROM   devices
            WHERE  status = 'active'
            GROUP  BY user_id
        ) d ON d.user_id = u.id
        WHERE  u.deleted_at IS NULL
        ORDER  BY total_cost_millicents DESC
        """,
        days,
    )
    return DevSummaryResponse(
        period_days=days,
        developers=[
            DevSummaryItem(
                user_id=r["id"],
                email=r["email"],
                enrolled_at=r["created_at"],
                total_cost_millicents=r["total_cost_millicents"],
                total_input_tokens=r["total_input_tokens"],
                total_output_tokens=r["total_output_tokens"],
                last_active=r["last_active"],
                active_devices=r["active_devices"] or 0,
            )
            for r in rows
        ],
    )


@router.get("/developer/{email}", response_model=DevDetailResponse)
async def developer_detail(
    email: str,
    days: int = Query(default=30, ge=1, le=365),
    conn: asyncpg.Connection = Depends(get_db),
    _: str = Depends(require_admin),
) -> DevDetailResponse:
    user = await conn.fetchrow(
        "SELECT id, email, created_at FROM users WHERE email = $1 AND deleted_at IS NULL",
        email.lower(),
    )
    if user is None:
        raise AppError(404, "user_not_found")

    totals = await conn.fetchrow(
        """
        SELECT
            COALESCE(SUM(cost_millicents),   0)::bigint AS cost_millicents,
            COALESCE(SUM(input_tokens),      0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens),     0)::bigint AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens
        FROM usage
        WHERE user_id = $1 AND date >= CURRENT_DATE - $2::integer
        """,
        user["id"], days,
    )

    breakdown_rows = await conn.fetch(
        _TOOL_MODEL_SQL.format(where="user_id = $1 AND date >= CURRENT_DATE - $2::integer"),
        user["id"], days,
    )

    daily_rows = await conn.fetch(
        """
        SELECT date,
               SUM(cost_millicents)::bigint AS cost_millicents,
               SUM(input_tokens)::bigint    AS input_tokens,
               SUM(output_tokens)::bigint   AS output_tokens
        FROM   usage
        WHERE  user_id = $1 AND date >= CURRENT_DATE - $2::integer
        GROUP  BY date
        ORDER  BY date DESC
        """,
        user["id"], days,
    )

    daily_tool_rows = await conn.fetch(
        """
        SELECT date, tool, model,
               -- GREATEST: pre-migration rows hold session_count = 0; fall
               -- back to the old COUNT(*) approximation until re-synced.
               GREATEST(SUM(session_count), COUNT(*))::int AS session_count,
               SUM(input_tokens)::bigint   AS input_tokens,
               SUM(output_tokens)::bigint  AS output_tokens,
               SUM(cost_millicents)::bigint AS cost_millicents
        FROM   usage
        WHERE  user_id = $1 AND date >= CURRENT_DATE - $2::integer
        GROUP  BY date, tool, model
        ORDER  BY date DESC, cost_millicents DESC
        """,
        user["id"], days,
    )

    cat_rows = await conn.fetch(
        """
        SELECT category, SUM(session_count)::int AS total
        FROM   usage_categories
        WHERE  user_id = $1 AND date >= CURRENT_DATE - $2::integer
        GROUP  BY category
        ORDER  BY total DESC
        """,
        user["id"], days,
    )

    device_row = await conn.fetchrow(
        """
        SELECT d.label, d.last_seen_at, t.name AS team_name
        FROM   devices d
        JOIN   users u ON u.id = d.user_id
        JOIN   teams t ON t.id = u.team_id
        WHERE  d.user_id = $1
        ORDER  BY d.last_seen_at DESC NULLS LAST
        LIMIT  1
        """,
        user["id"],
    )

    cat_total = sum(r["total"] for r in cat_rows) or 1
    task_categories = [
        TaskCategoryItem(
            category=r["category"],
            session_count=r["total"],
            pct=round(r["total"] / cat_total * 100),
        )
        for r in cat_rows
    ]

    return DevDetailResponse(
        user_id=user["id"],
        email=user["email"],
        enrolled_at=user["created_at"],
        total_cost_millicents=totals["cost_millicents"],
        total_input_tokens=totals["input_tokens"],
        total_output_tokens=totals["output_tokens"],
        total_cache_read_tokens=totals["cache_read_tokens"],
        by_tool_model=[
            ToolModelBreakdown(
                tool=r["tool"],
                model=r["model"],
                cost_millicents=r["cost_millicents"],
                input_tokens=r["input_tokens"],
                output_tokens=r["output_tokens"],
                days_active=r["days_active"],
                # Rows synced before the session_count column existed hold 0;
                # fall back to days_active (the old approximation) until the
                # agent re-syncs and overwrites them with real counts.
                session_count=r["session_count"] or r["days_active"],
            )
            for r in breakdown_rows
        ],
        daily=[
            DailyUsage(
                date=r["date"],
                cost_millicents=r["cost_millicents"],
                input_tokens=r["input_tokens"],
                output_tokens=r["output_tokens"],
            )
            for r in daily_rows
        ],
        daily_by_tool=[
            DailyToolRow(
                date=r["date"],
                tool=r["tool"],
                model=r["model"],
                session_count=r["session_count"],
                input_tokens=r["input_tokens"],
                output_tokens=r["output_tokens"],
                cost_millicents=r["cost_millicents"],
            )
            for r in daily_tool_rows
        ],
        task_categories=task_categories,
        team_name=device_row["team_name"] if device_row else None,
        machine_label=device_row["label"] if device_row else None,
        last_seen_at=device_row["last_seen_at"] if device_row else None,
    )


@router.get("/org", response_model=OrgOverviewResponse)
async def org_overview(
    days: int = Query(default=30, ge=1, le=365),
    conn: asyncpg.Connection = Depends(get_db),
    _: str = Depends(require_admin),
) -> OrgOverviewResponse:
    totals = await conn.fetchrow(
        """
        SELECT
            COALESCE(SUM(cost_millicents), 0)::bigint  AS cost_millicents,
            COALESCE(SUM(input_tokens),    0)::bigint  AS input_tokens,
            COALESCE(SUM(output_tokens),   0)::bigint  AS output_tokens,
            COUNT(DISTINCT user_id)::int               AS active_developers
        FROM usage
        WHERE date >= CURRENT_DATE - $1::integer
        """,
        days,
    )

    breakdown_rows = await conn.fetch(
        _TOOL_MODEL_SQL.format(where="date >= CURRENT_DATE - $1::integer"),
        days,
    )

    category_rows = await conn.fetch(
        """
        SELECT category, SUM(session_count)::int AS total
        FROM   usage_categories
        WHERE  date >= CURRENT_DATE - $1::integer
        GROUP  BY category
        ORDER  BY total DESC
        """,
        days,
    )

    cat_total = sum(r["total"] for r in category_rows) or 1
    task_categories = [
        TaskCategoryItem(
            category=r["category"],
            session_count=r["total"],
            pct=round(r["total"] / cat_total * 100),
        )
        for r in category_rows
    ]
    primary_use_case = category_rows[0]["category"] if category_rows else None
    distinct_cats = len(category_rows)
    task_diversity_score = round(distinct_cats / 8 * 100)

    return OrgOverviewResponse(
        period_days=days,
        total_cost_millicents=totals["cost_millicents"],
        total_input_tokens=totals["input_tokens"],
        total_output_tokens=totals["output_tokens"],
        active_developers=totals["active_developers"],
        by_tool_model=[
            ToolModelBreakdown(
                tool=r["tool"],
                model=r["model"],
                cost_millicents=r["cost_millicents"],
                input_tokens=r["input_tokens"],
                output_tokens=r["output_tokens"],
                days_active=r["days_active"],
                # Rows synced before the session_count column existed hold 0;
                # fall back to days_active (the old approximation) until the
                # agent re-syncs and overwrites them with real counts.
                session_count=r["session_count"] or r["days_active"],
            )
            for r in breakdown_rows
        ],
        task_categories=task_categories,
        primary_use_case=primary_use_case,
        task_diversity_score=task_diversity_score,
    )
