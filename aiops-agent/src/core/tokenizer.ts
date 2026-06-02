import { encode } from 'gpt-tokenizer';

export function countByTiktoken(text: string): number {
  if (!text) return 0;
  try {
    return (encode(text) as number[]).length;
  } catch {
    return estimateByChars(text);
  }
}

export function estimateByChars(text: string): number {
  return Math.ceil(text.length / 4);
}
