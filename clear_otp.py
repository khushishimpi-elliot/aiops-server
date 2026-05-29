import asyncio
import asyncpg

async def run():
    conn = await asyncpg.connect(
        "postgresql://neondb_owner:npg_2zKbgijwL9nE@ep-dry-cherry-aouw6xwf-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
    )
    await conn.execute("DELETE FROM otp_requests WHERE email = 'astika.mhaisgawali@elliotsystems.com'")
    print("Rate limit cleared. Try enrolling again.")
    await conn.close()

asyncio.run(run())
