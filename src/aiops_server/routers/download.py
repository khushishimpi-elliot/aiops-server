"""Public download endpoints so enrolled users can install and self-update the
agent without git access. The CLI bundle committed at aiops-agent/dist/cli.cjs
is served directly; the agent compares its own bundle hash to /download/manifest
and pulls a new copy when they differ.
"""
import hashlib
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, PlainTextResponse

from ..errors import AppError

router = APIRouter(prefix="/download", tags=["download"])

# routers -> aiops_server -> src -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]
_CLI_BUNDLE = _REPO_ROOT / "aiops-agent" / "dist" / "cli.cjs"


def _bundle_sha256() -> str:
    h = hashlib.sha256()
    with _CLI_BUNDLE.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


@router.get("/manifest")
async def manifest() -> dict:
    if not _CLI_BUNDLE.exists():
        raise AppError(404, "bundle_not_found")
    stat = _CLI_BUNDLE.stat()
    return {"sha256": _bundle_sha256(), "size": stat.st_size}


@router.get("/cli.cjs")
async def cli_bundle() -> FileResponse:
    if not _CLI_BUNDLE.exists():
        raise AppError(404, "bundle_not_found")
    return FileResponse(
        _CLI_BUNDLE,
        media_type="application/javascript",
        filename="cli.cjs",
        headers={"Cache-Control": "no-store"},
    )
