import { encode } from 'gpt-tokenizer';

function tokenCount(text) {
  if (!text) return 0;
  return encode(text).length;
}

export function countTokens(messages) {
  // Prefer embedded usage data from the API (most accurate)
  let hasUsage = false;
  let totalInput = 0;
  let totalOutput = 0;

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.usage) {
      totalInput += msg.usage.input_tokens ?? 0;
      totalOutput += msg.usage.output_tokens ?? 0;
      hasUsage = true;
    }
  }

  if (hasUsage) return { inputTokens: totalInput, outputTokens: totalOutput, source: 'api' };

  // Fallback: simulate cumulative context window billing
  // Each turn's input = all messages sent so far (Claude sees the full history)
  const userMessages = [];
  let fallbackInput = 0;
  let fallbackOutput = 0;

  for (const msg of messages) {
    if (msg.role === 'user') {
      userMessages.push(msg.content);
    } else if (msg.role === 'assistant') {
      // Input for this turn = all user messages accumulated so far
      const contextText = userMessages.join('\n');
      fallbackInput += tokenCount(contextText);
      fallbackOutput += tokenCount(msg.content);
    }
  }

  return { inputTokens: fallbackInput, outputTokens: fallbackOutput, source: 'estimated' };
}
