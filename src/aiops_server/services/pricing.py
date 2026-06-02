import asyncpg

# ---------------------------------------------------------------------------
# Fallback pricing table (USD per million tokens → millicents per 1k tokens)
# Used when the database has no pricing row for a given tool/model.
# Matched by substring so versioned IDs like "claude-haiku-4-5-20251001" hit
# the right entry. Ordered longest-match-first within each model family.
# ---------------------------------------------------------------------------
_FALLBACK: list[tuple[str, int, int, int, int]] = [
    # pattern                   inp_mc  out_mc  cr_mc  cw_mc  (all per 1k tokens)
    ("claude-opus-4",              500,   2500,    50,   625),
    ("claude-sonnet-4",            300,   1500,    30,   375),
    ("claude-haiku-4",             100,    500,    10,   125),
    ("claude-3-7-sonnet",          300,   1500,    30,   375),
    ("claude-3-5-sonnet",          300,   1500,    30,   375),
    ("claude-3-5-haiku",            80,    400,     8,   100),
    ("claude-3-opus",             1500,   7500,   150,  1875),
    ("claude-3-sonnet",            300,   1500,    30,   375),
    ("claude-3-haiku",              25,    125,     3,    30),
    ("claude",                     300,   1500,    30,   375),  # generic Claude fallback
    ("gemini-2.5-pro",             125,   1000,     0,     0),
    ("gemini-2.5-flash",            15,     60,     0,     0),
    ("gemini-2.0-flash",             8,     30,     2,     9),
    ("gemini-1.5-pro",             125,    500,     0,     0),
    ("gemini-1.5-flash",             8,     30,     2,     9),
    ("gemini-antigravity",           8,     30,     0,     0),
    ("gemini",                       8,     30,     2,     9),  # generic Gemini fallback
    ("gpt-4o-mini",                 15,     60,     8,     0),
    ("gpt-4o",                     250,   1000,    63,   313),
    ("gpt-4.1-nano",                10,     40,     0,     0),
    ("gpt-4.1-mini",                40,    160,     0,     0),
    ("gpt-4.1",                    200,    800,     0,     0),
    ("gpt-4-turbo",               1000,   3000,     0,     0),
    ("gpt-4",                     1000,   3000,     0,     0),
    ("gpt-3.5",                     50,    150,     0,     0),
    ("o4-mini",                    110,    440,    28,     0),
    ("o3-mini",                    110,    440,    28,     0),
    ("o3",                        1000,   4000,   250,     0),
    ("o1-mini",                    300,   1200,    75,     0),
    ("o1",                        1500,   6000,   375,     0),
    # Wrapped tools — cost tracked via token estimates, price is $0
    ("copilot",                      0,      0,     0,     0),
    ("cursor",                       0,      0,     0,     0),
    ("windsurf",                     0,      0,     0,     0),
    ("cline",                        0,      0,     0,     0),
    ("roo",                          0,      0,     0,     0),
    ("kilo",                         0,      0,     0,     0),
    ("codex",                        0,      0,     0,     0),
]


def _fallback_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
) -> int:
    """Compute cost in millicents using the hardcoded fallback table."""
    key = (model or "").lower()
    for pattern, p_in, p_out, p_cr, p_cw in _FALLBACK:
        if pattern in key:
            numerator = (
                input_tokens        * p_in
                + output_tokens     * p_out
                + cache_read_tokens * p_cr
                + cache_write_tokens * p_cw
            )
            return max(0, numerator // 1000)
    return 0


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

    Tries the database pricing table first (exact tool+model match).
    Falls back to the hardcoded _FALLBACK table so unknown models never
    cause a 422 — they just get $0 cost until a pricing row is added.
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

    if row is not None:
        numerator = (
            input_tokens         * row["input_millicents_per_1k"]
            + output_tokens      * row["output_millicents_per_1k"]
            + cache_read_tokens  * row["cache_read_millicents_per_1k"]
            + cache_write_tokens * row["cache_write_millicents_per_1k"]
        )
        return max(0, numerator // 1000)

    # No DB row — use fallback (never raises)
    return _fallback_cost(
        model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens,
    )
