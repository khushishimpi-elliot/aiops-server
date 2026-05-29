"""Seed initial data: Elliot team, elliot.com domain, and current AI tool pricing.

Usage:
    uv run python scripts/seed.py

Safe to run multiple times — uses INSERT ... ON CONFLICT DO NOTHING.
"""

import asyncio
import os
import sys


# Pricing data: (tool, model, input_m_per_1k, output_m_per_1k, cache_read_m_per_1k, cache_write_m_per_1k)
# Prices in millicents per 1,000 tokens (1 millicent = $0.00001).
# Source: Anthropic pricing as of 2025-05 — update here when prices change,
# then run seed.py again (it will add a new current row and expire the old one).
PRICING_ROWS = [
    # Claude Code / claude.ai uses claude-sonnet-4-5 by default
    ("claude_code", "claude-sonnet-4-5",  300,  1500, 30,  375),
    ("claude_code", "claude-opus-4-5",   1500,  7500, 150, 1875),
    ("claude_code", "claude-haiku-4-5",    80,   400,  8,  100),
    # Cursor (varies by plan — using pay-as-you-go rates)
    ("cursor",      "claude-sonnet-4-5",  300,  1500, 30,  375),
    ("cursor",      "gpt-4o",             250,  1000,  0,    0),
    ("cursor",      "gpt-4o-mini",         15,    60,  0,    0),
]


async def main() -> None:
    try:
        import asyncpg
    except ImportError:
        sys.exit("asyncpg not installed — run: uv sync")

    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL is not set")

    print("Connecting ...")
    conn: asyncpg.Connection = await asyncpg.connect(dsn=db_url)

    try:
        async with conn.transaction():
            # Elliot team
            team_id: int = await conn.fetchval(
                """
                INSERT INTO teams(name) VALUES('Elliot Systems')
                ON CONFLICT DO NOTHING
                RETURNING id
                """
            )
            if team_id is None:
                team_id = await conn.fetchval("SELECT id FROM teams WHERE name = 'Elliot Systems'")
            print(f"Team id={team_id}")

            # elliot.com domain
            await conn.execute(
                """
                INSERT INTO domains(team_id, domain) VALUES($1, 'elliotsystems.com')
                ON CONFLICT DO NOTHING
                """,
                team_id,
            )
            print("Domain elliotsystems.com ensured")

            # Pricing rows — expire any existing current row for the same (tool, model)
            # before inserting the new one so the partial unique index is not violated.
            for tool, model, inp, out, cr, cw in PRICING_ROWS:
                existing = await conn.fetchval(
                    "SELECT id FROM pricing WHERE tool=$1 AND model=$2 AND effective_to IS NULL",
                    tool, model,
                )
                if existing:
                    # Check if values are identical — skip if so
                    row = await conn.fetchrow(
                        "SELECT input_millicents_per_1k, output_millicents_per_1k, "
                        "cache_read_millicents_per_1k, cache_write_millicents_per_1k "
                        "FROM pricing WHERE id=$1",
                        existing,
                    )
                    if (row["input_millicents_per_1k"] == inp
                            and row["output_millicents_per_1k"] == out
                            and row["cache_read_millicents_per_1k"] == cr
                            and row["cache_write_millicents_per_1k"] == cw):
                        print(f"Pricing {tool}/{model} unchanged, skipping")
                        continue
                    # Expire the old row
                    await conn.execute(
                        "UPDATE pricing SET effective_to = now() WHERE id=$1", existing
                    )

                await conn.execute(
                    """
                    INSERT INTO pricing(tool, model,
                        input_millicents_per_1k, output_millicents_per_1k,
                        cache_read_millicents_per_1k, cache_write_millicents_per_1k)
                    VALUES($1,$2,$3,$4,$5,$6)
                    """,
                    tool, model, inp, out, cr, cw,
                )
                print(f"Pricing {tool}/{model} seeded")

        print("\nSeed complete.")

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
