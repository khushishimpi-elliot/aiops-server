interface PriceEntry {
  match: RegExp;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// Prices in USD per 1M tokens. More specific patterns must come before general ones.
const PRICING: PriceEntry[] = [
  // ── Anthropic Claude ────────────────────────────────────────────────────────
  { match: /claude-opus-4/,           input: 5.00,   output: 25.00,  cacheRead: 0.50,  cacheWrite: 6.25  },
  { match: /claude-sonnet-4/,         input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  },
  { match: /claude-haiku-4/,          input: 1.00,   output: 5.00,   cacheRead: 0.10,  cacheWrite: 1.25  },
  { match: /claude-3-7-sonnet/,       input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  },
  { match: /claude-3-5-sonnet/,       input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  },
  { match: /claude-3-5-haiku/,        input: 0.80,   output: 4.00,   cacheRead: 0.08,  cacheWrite: 1.00  },
  { match: /claude-3-opus/,           input: 15.00,  output: 75.00,  cacheRead: 1.50,  cacheWrite: 18.75 },
  { match: /claude-3-sonnet/,         input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  },
  { match: /claude-3-haiku/,          input: 0.25,   output: 1.25,   cacheRead: 0.03,  cacheWrite: 0.30  },

  // ── Google Gemini ─────────────────────────────────────────────────────────
  { match: /gemini-2\.5-pro/,         input: 1.25,   output: 10.00  },
  { match: /gemini-2\.5-flash/,       input: 0.15,   output: 0.60   },
  { match: /gemini-2\.0-flash-lite/,  input: 0.075,  output: 0.30,  cacheRead: 0.02,  cacheWrite: 0.09  },
  { match: /gemini-2\.0-flash/,       input: 0.075,  output: 0.30,  cacheRead: 0.02,  cacheWrite: 0.09  },
  { match: /gemini-1\.5-flash/,       input: 0.075,  output: 0.30,  cacheRead: 0.02,  cacheWrite: 0.09  },
  { match: /gemini-1\.5-pro/,         input: 1.25,   output: 5.00   },
  { match: /gemini-1\.0-pro/,         input: 0.50,   output: 1.50   },
  { match: /gemini-exp/,              input: 0.00,   output: 0.00   },

  // ── OpenAI GPT ─────────────────────────────────────────────────────────────
  // NOTE: gpt-4o-mini MUST come before gpt-4o — otherwise gpt-4o-mini matches gpt-4o regex
  { match: /gpt-4\.1-nano/,           input: 0.10,   output: 0.40   },
  { match: /gpt-4\.1-mini/,           input: 0.40,   output: 1.60   },
  { match: /gpt-4\.1/,               input: 2.00,   output: 8.00   },
  { match: /gpt-4o-mini/,            input: 0.15,   output: 0.60,  cacheRead: 0.075 },
  { match: /gpt-4o/,                 input: 2.50,   output: 10.00, cacheRead: 0.63,  cacheWrite: 3.13  },
  { match: /gpt-4-turbo/,            input: 10.00,  output: 30.00  },
  { match: /gpt-4/,                  input: 10.00,  output: 30.00  },
  { match: /gpt-3\.5-turbo/,         input: 0.50,   output: 1.50   },

  // ── OpenAI o-series reasoning ─────────────────────────────────────────────
  // Most specific (longest name) first to prevent o1 swallowing o1-mini etc.
  { match: /o4-mini/,                input: 1.10,   output: 4.40,  cacheRead: 0.28  },
  { match: /o3-mini/,                input: 1.10,   output: 4.40,  cacheRead: 0.28  },
  { match: /o3/,                     input: 10.00,  output: 40.00, cacheRead: 2.50  },
  { match: /o1-mini/,                input: 3.00,   output: 12.00, cacheRead: 0.75  },
  { match: /o1-pro/,                 input: 150.00, output: 600.00 },
  { match: /\bo1\b/,                 input: 15.00,  output: 60.00, cacheRead: 3.75  },

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  { match: /deepseek-r1/,            input: 0.55,   output: 2.19   },
  { match: /deepseek/,               input: 0.27,   output: 1.10   },

  // ── Mistral ──────────────────────────────────────────────────────────────
  { match: /mistral-large/,          input: 2.00,   output: 6.00   },
  { match: /mistral-medium/,         input: 0.40,   output: 1.20   },
  { match: /mistral-small/,          input: 0.20,   output: 0.60   },
  { match: /mixtral/,                input: 0.24,   output: 0.24   },
  { match: /mistral/,                input: 0.20,   output: 0.60   },

  // ── Meta Llama ───────────────────────────────────────────────────────────
  { match: /llama-3\.3/,             input: 0.20,   output: 0.20   },
  { match: /llama-3\.1/,             input: 0.10,   output: 0.10   },
  { match: /llama-3/,                input: 0.10,   output: 0.10   },
  { match: /llama/,                  input: 0.10,   output: 0.10   },

  // ── Qwen ─────────────────────────────────────────────────────────────────
  { match: /qwen2\.5/,               input: 0.07,   output: 0.21   },
  { match: /qwen/,                   input: 0.07,   output: 0.21   },

  // ── Microsoft Phi ────────────────────────────────────────────────────────
  { match: /phi-4/,                  input: 0.07,   output: 0.14   },
  { match: /phi-3/,                  input: 0.07,   output: 0.14   },

  // ── Cohere ───────────────────────────────────────────────────────────────
  { match: /command-r-plus/,         input: 2.50,   output: 10.00  },
  { match: /command-r/,              input: 0.15,   output: 0.60   },
];

// Fallback when model is unknown — use mid-range pricing rather than over/underestimating
const DEFAULT_PRICE = { input: 1.00, output: 3.00, cacheRead: 0.10, cacheWrite: 0.25 };

export function getPrice(model = ''): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const m = (model ?? '').toLowerCase();
  for (const p of PRICING) {
    if (p.match.test(m)) {
      return { input: p.input, output: p.output, cacheRead: p.cacheRead ?? 0, cacheWrite: p.cacheWrite ?? 0 };
    }
  }
  return DEFAULT_PRICE;
}

export function calcCost(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): number {
  const p = getPrice(model);
  return (
    (input      / 1e6) * p.input +
    (output     / 1e6) * p.output +
    (cacheRead  / 1e6) * p.cacheRead +
    (cacheWrite / 1e6) * p.cacheWrite
  );
}
