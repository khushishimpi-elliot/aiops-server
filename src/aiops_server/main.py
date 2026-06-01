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
from .routers import admin, enrollment, health, query, telemetry


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

    # Serve React SPA — fall back to index.html for unknown paths so React Router works
    dashboard_path = Path(__file__).parent / "dashboard"
    if dashboard_path.exists():
        class SPAStaticFiles(StaticFiles):
            async def get_response(self, path: str, scope):  # type: ignore[override]
                try:
                    return await super().get_response(path, scope)
                except StarletteHTTPException as exc:
                    if exc.status_code == 404:
                        return await super().get_response("index.html", scope)
                    raise

        app.mount("/", SPAStaticFiles(directory=dashboard_path, html=True), name="dashboard")

    return app


app = create_app()
