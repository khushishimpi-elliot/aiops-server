"""Run a single migration file against the Neon DB.
Usage: python run_migration.py migrations/004_password_auth.sql
"""
import asyncio
import sys
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import asyncpg


async def run(sql_file: str) -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL env var not set. Add it to .env or export it.")

    sql = Path(sql_file).read_text()
    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute(sql)
        print(f"Applied {sql_file} successfully.")
    finally:
        await conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(f"Usage: python {sys.argv[0]} <migration_file.sql>")
    asyncio.run(run(sys.argv[1]))
