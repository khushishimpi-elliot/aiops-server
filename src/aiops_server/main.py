from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import sentry_sdk
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from .config import get_config
from .db import close_pool, init_pool
from .errors import register_error_handlers
from .routers import admin, agent, download, enrollment, health, query, telemetry


async def _fix_other_categories() -> None:
    """
    Re-classify usage_categories rows stored as 'other' using tool from usage table.
    Runs on every startup — safe to run multiple times (only updates 'other' rows).
    """
    import logging
    from .db import get_pool

    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            updated = await conn.fetchval("""
                WITH tool_data AS (
                    SELECT
                        uc.id,
                        u.tool,
                        u.model,
                        COALESCE(
                            SUM(uc.session_count), 1
                        ) as turns
                    FROM usage_categories uc
                    JOIN usage u ON
                        u.user_id  = uc.user_id AND
                        u.date     = uc.date
                    WHERE uc.category = 'other'
                    GROUP BY uc.id, u.tool, u.model
                )
                UPDATE usage_categories uc
                SET category = CASE
                    WHEN td.tool IN (
                        'copilot','cursor','windsurf',
                        'cline','roo','kilo','codex'
                    ) THEN 'code_generation'
                    WHEN td.tool IN ('gemini','pi')
                        THEN 'research'
                    WHEN td.turns >= 50
                        THEN 'debugging'
                    WHEN td.turns >= 20
                        THEN 'code_generation'
                    WHEN td.turns >= 10
                        THEN 'analysis'
                    WHEN td.turns >= 5
                        THEN 'code_generation'
                    WHEN td.turns >= 2
                        THEN 'research'
                    ELSE 'code_generation'
                END
                FROM tool_data td
                WHERE uc.id = td.id
                AND   uc.category = 'other'
                RETURNING 1
            """)
            if updated:
                logging.info(f"Fixed {updated} other categories on startup")
    except Exception as e:
        logging.warning(f"Category startup fix skipped: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    import logging
    config = get_config()
    await init_pool(config)
    if not config.email_configured:
        logging.warning(
            "EMAIL NOT CONFIGURED: Set SMTP_USER and SMTP_PASSWORD in Render environment variables. "
            "OTPs will be logged to console instead."
        )

    # Run category fix on startup
    await _fix_other_categories()

    logging.info("AIOps server started")
    yield
    await close_pool()


def create_app() -> FastAPI:
    config = get_config()

    if config.sentry_dsn:
        sentry_sdk.init(dsn=config.sentry_dsn, traces_sample_rate=0.1)

    limiter = Limiter(key_func=get_remote_address)

    app = FastAPI(
        title="AIOps Server",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    register_error_handlers(app)

    app.include_router(health.router)
    app.include_router(enrollment.router)
    app.include_router(admin.router)
    app.include_router(telemetry.router)
    app.include_router(query.router)
    app.include_router(agent.router)
    app.include_router(download.router)

    # Serve React SPA — fall back to index.html for unknown paths so React Router works
    dashboard_path = Path(__file__).parent / "dashboard"
    if dashboard_path.exists():
        class SPAStaticFiles(StaticFiles):
            async def get_response(self, path: str, scope):  # type: ignore[override]
                try:
                    response = await super().get_response(path, scope)
                    # Never cache index.html — always fetch fresh so the browser
                    # picks up the new content-hashed JS/CSS bundle on each deploy.
                    if path in ("", "index.html") or path.endswith("/"):
                        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                        response.headers["Pragma"] = "no-cache"
                    return response
                except StarletteHTTPException as exc:
                    if exc.status_code == 404:
                        response = await super().get_response("index.html", scope)
                        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                        response.headers["Pragma"] = "no-cache"
                        return response
                    raise

        app.mount("/", SPAStaticFiles(directory=dashboard_path, html=True), name="dashboard")

    return app


app = create_app()
