"""
One-time cleanup: remove usage rows from old duplicate device entries.

When a developer re-enrolled before the dedup fix was applied, a new device
row was created instead of reusing the existing one. Both old and new device
rows accumulated usage data for the same machine, doubling the dashboard totals.

This script:
1. Finds (user_id, machine_id) groups that have more than one device row.
2. Keeps only the most recent device (highest id) for each group.
3. Deletes all usage and usage_categories rows belonging to the older devices.
4. Deletes the older device rows themselves.

Run once against the production database:
    python cleanup_duplicate_devices.py
"""
import asyncio
import os
import asyncpg
from dotenv import load_dotenv

load_dotenv()


async def main() -> None:
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])

    # Find all (user_id, machine_id) groups with more than one device row.
    dupe_groups = await conn.fetch(
        """
        SELECT user_id, machine_id, COUNT(*) AS cnt,
               MAX(id) AS keep_device_id,
               ARRAY_AGG(id ORDER BY id) AS all_device_ids
        FROM   devices
        GROUP  BY user_id, machine_id
        HAVING COUNT(*) > 1
        """
    )

    if not dupe_groups:
        print("No duplicate devices found — database is clean.")
        await conn.close()
        return

    print(f"Found {len(dupe_groups)} (user_id, machine_id) group(s) with duplicates:\n")
    for row in dupe_groups:
        print(f"  user_id={row['user_id']}  machine_id={row['machine_id'][:12]}…"
              f"  devices={row['all_device_ids']}  keeping={row['keep_device_id']}")

    print()

    # Collect old device IDs to purge (all except the latest for each group).
    old_device_ids: list[int] = []
    for row in dupe_groups:
        stale = [d for d in row["all_device_ids"] if d != row["keep_device_id"]]
        old_device_ids.extend(stale)

    print(f"Old device IDs to purge: {old_device_ids}\n")

    # Preview: how many usage rows will be deleted?
    usage_count = await conn.fetchval(
        "SELECT COUNT(*) FROM usage WHERE device_id = ANY($1::bigint[])",
        old_device_ids,
    )
    cat_count = await conn.fetchval(
        "SELECT COUNT(*) FROM usage_categories WHERE device_id = ANY($1::bigint[])",
        old_device_ids,
    )
    print(f"Will delete: {usage_count} usage row(s), {cat_count} usage_categories row(s).\n")

    confirm = input("Proceed? [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        await conn.close()
        return

    async with conn.transaction():
        deleted_usage = await conn.execute(
            "DELETE FROM usage WHERE device_id = ANY($1::bigint[])",
            old_device_ids,
        )
        deleted_cats = await conn.execute(
            "DELETE FROM usage_categories WHERE device_id = ANY($1::bigint[])",
            old_device_ids,
        )
        deleted_devices = await conn.execute(
            "DELETE FROM devices WHERE id = ANY($1::bigint[])",
            old_device_ids,
        )

    print(f"\nDone.")
    print(f"  {deleted_usage} usage rows deleted")
    print(f"  {deleted_cats} usage_categories rows deleted")
    print(f"  {deleted_devices} device rows deleted")

    await conn.close()


asyncio.run(main())
