import asyncpg

from ..errors import AppError


async def compute_cost(
    conn: asyncpg.Connection,
    tool: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
) -> int:
    """Return cost in millicents (1/1000 of a cent).

    Sums all numerators before the single division to minimise rounding loss
    on small token counts (e.g. 1 token * 300 mc/1k = 0 mc without this).
    """
    row = await conn.fetchrow(
        """
        SELECT input_millicents_per_1k,
               output_millicents_per_1k,
               cache_read_millicents_per_1k,
               cache_write_millicents_per_1k
        FROM   pricing
        WHERE  tool = $1 AND model = $2 AND effective_to IS NULL
        """,
        tool,
        model,
    )
    if row is None:
        raise AppError(422, "pricing_not_found", f"No active pricing for {tool}/{model}")

    numerator = (
        input_tokens         * row["input_millicents_per_1k"]
        + output_tokens      * row["output_millicents_per_1k"]
        + cache_read_tokens  * row["cache_read_millicents_per_1k"]
        + cache_write_tokens * row["cache_write_millicents_per_1k"]
    )
    return max(0, numerator // 1000)
