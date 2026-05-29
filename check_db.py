import asyncio
import os
import asyncpg
from dotenv import load_dotenv

load_dotenv()

async def main():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    version = await conn.fetchval("SELECT version()")
    print("Connected:", version.split(",")[0])
    await conn.close()

asyncio.run(main())
