"""
One-time cleanup: delete usage rows with old token-based idempotency keys.

Old format:  <token_hash>:<date>:<tool>:<model>:<category>
New format:  dev<device_id>:<date>:<tool>:<model>:<category>

The old rows are duplicates left over from before the idempotency key format
changed (token-based → device-id-based).  Because old and new enrollments
hashed machine_id differently, the regular sync cleanup never matched them.

Usage:
    python clean_duplicates.py
"""
import asyncio
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import asyncpg


async def run() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL env var not set")

    conn = await asyncpg.connect(db_url)
    try:
        # Count before
        old_usage = await conn.fetchval(
            "SELECT COUNT(*) FROM usage WHERE idempotency_key NOT LIKE 'dev%'"
        )
        old_cats = await conn.fetchval(
            "SELECT COUNT(*) FROM usage_categories WHERE idempotency_key NOT LIKE 'dev%'"
        )
        print(f"Found {old_usage} stale usage rows, {old_cats} stale category rows")

        if old_usage == 0 and old_cats == 0:
            print("Nothing to clean — already up to date.")
            return

        async with conn.transaction():
            deleted_usage = await conn.execute(
                "DELETE FROM usage WHERE idempotency_key NOT LIKE 'dev%'"
            )
            deleted_cats = await conn.execute(
                "DELETE FROM usage_categories WHERE idempotency_key NOT LIKE 'dev%'"
            )

        print(f"Deleted: {deleted_usage}")
        print(f"Deleted: {deleted_cats}")
        print()
        print("Done. Each developer's next sync will re-insert clean data.")
        print("They can run  aiops sync --days 365  to repopulate immediately.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(run())
