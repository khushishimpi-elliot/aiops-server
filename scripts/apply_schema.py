"""Apply schema.sql to the database pointed at by DATABASE_URL.

Usage:
    uv run python scripts/apply_schema.py

Reads DATABASE_URL from .env automatically via python-dotenv (if installed)
or from the environment. The schema file is idempotent in the sense that it
runs inside a single transaction — if anything fails the whole apply rolls back.
"""

import asyncio
import os
import sys
from pathlib import Path


async def main() -> None:
    try:
        import asyncpg
    except ImportError:
        sys.exit("asyncpg not installed — run: uv sync")

    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass  # dotenv optional; fall back to real env vars

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL is not set")

    schema_path = Path(__file__).parent.parent / "schema.sql"
    if not schema_path.exists():
        sys.exit(f"schema.sql not found at {schema_path}")

    sql = schema_path.read_text(encoding="utf-8")

    print(f"Connecting to database...")
    conn: asyncpg.Connection = await asyncpg.connect(dsn=db_url)
    try:
        print("Applying schema.sql ...")
        await conn.execute(sql)
        print("Done.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
