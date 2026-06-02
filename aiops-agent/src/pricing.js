// Prices in USD per million tokens
const PRICING = {
  'claude-opus-4-7':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':    { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00 },
  'claude-sonnet-4-5':  { input:  3.00, output: 15.00 },
  'claude-haiku-4-5':   { input:  0.80, output:  4.00 },
  'claude-haiku-3-5':   { input:  0.80, output:  4.00 },
};

const FALLBACK_MODEL = 'claude-sonnet-4-6';

export function getPrice(modelName) {
  if (!modelName) return { ...PRICING[FALLBACK_MODEL], estimated: true };

  // Exact match
  if (PRICING[modelName]) return { ...PRICING[modelName], estimated: false };

  // Partial match — strip date suffixes like -20250514
  const normalized = modelName.toLowerCase().replace(/-\d{8}$/, '');
  for (const [key, price] of Object.entries(PRICING)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return { ...price, estimated: false };
    }
  }

  // Last resort fallback
  return { ...PRICING[FALLBACK_MODEL], estimated: true };
}

export function calculateCost(modelName, inputTokens, outputTokens) {
  const { input, output, estimated } = getPrice(modelName);
  const inputCost  = (inputTokens  / 1_000_000) * input;
  const outputCost = (outputTokens / 1_000_000) * output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost, estimated };
}
