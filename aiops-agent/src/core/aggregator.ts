import { getSessionsSince } from './db.js';
import { getAllSessions } from '../adapters/index.js';
import type { SessionRecord } from './types.js';

export interface DailyAggregate {
  date: string;
  tool: string;
  model: string;
  category: string;
  sessions: number;
  total_turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_usd: number;
  active_day: number;
}

function classifyCategory(prompt: string | undefined): string {
  if (!prompt) return 'other';
  const p = prompt.toLowerCase();
  if (/\b(bug|fix|error|exception|crash|debug|broken|issue)\b/.test(p)) return 'debugging';
  if (/\b(write|draft|document|readme|comment|describe)\b/.test(p))     return 'writing';
  if (/\b(analyze|analyse|review|audit|check|assess)\b/.test(p))        return 'analysis';
  if (/\b(test|spec|coverage|mock|unit)\b/.test(p))                     return 'automation';
  if (/\b(config|setup|install|configure|settings|init)\b/.test(p))     return 'configuration';
  if (/\b(research|find|search|what is|how does)\b/.test(p))            return 'research';
  if (/\b(create|build|implement|add|generate|function|component)\b/.test(p)) return 'code_generation';
  return 'other';
}

export function computeDailyAggregates(days: number): DailyAggregate[] {
  // Aggregate from the LIVE scan so the synced data matches `aiops scan`
  // exactly. The persisted DB retains sessions whose source logs have since
  // been removed, which inflated the dashboard above the live scan total.
  // Fall back to the DB only when the live scan yields nothing (e.g. the
  // tool logs are temporarily unreadable) so offline syncs still work.
  let sessions: SessionRecord[] = [];
  try {
    sessions = getAllSessions();
  } catch {
    sessions = [];
  }
  if (sessions.length) {
    const cutoff = Date.now() - days * 86_400_000;
    sessions = sessions.filter(s => !s.sessionTimestamp || s.sessionTimestamp >= cutoff);
  } else {
    try {
      sessions = getSessionsSince(days);
    } catch {
      return [];
    }
  }

  const groups = new Map<string, DailyAggregate>();

  for (const s of sessions) {
    const category = classifyCategory(s.firstPrompt);
    const key = [s.sessionDate, s.tool, s.model, category].join('|');

    if (!groups.has(key)) {
      groups.set(key, {
        date:          s.sessionDate || '',
        tool:          s.tool || 'unknown',
        model:         s.model || 'unknown',
        category,
        sessions:      0,
        total_turns:   0,
        input_tokens:  0,
        output_tokens: 0,
        cache_tokens:  0,
        cost_usd:      0,
        active_day:    1,
      });
    }

    const g = groups.get(key)!;
    g.sessions      += 1;
    g.total_turns   += (s.turnCount || 0);
    g.input_tokens  += (s.inputTokens || 0);
    g.output_tokens += (s.outputTokens || 0);
    g.cache_tokens  += (s.cacheReadTokens || 0) + (s.cacheWriteTokens || 0);
    g.cost_usd      += (s.costUSD || 0);
  }

  return Array.from(groups.values())
    .filter(g => g.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}
