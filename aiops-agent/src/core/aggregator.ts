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

function classifyCategory(
  prompt: string | undefined,
  tool?: string,
  turnCount?: number,
  projectName?: string,
): string {
  const p = (prompt || '').toLowerCase().trim();
  const proj = (projectName || '').toLowerCase();
  const t = (tool || '').toLowerCase();
  const turns = turnCount || 0;

  // ── PROMPT-BASED CLASSIFICATION ─────────────
  if (p.length > 3) {
    if (/\b(bug|fix|error|exception|crash|debug|broken|issue|fail|wrong|not work|undefined|null|traceback|stack trace|cannot|could not|doesn't work|doesn't compile|syntax error|type error|runtime|warning)\b/.test(p))
      return 'debugging';

    if (/\b(review|check this|look at this|feedback|suggest|improve|optimize|better way|best practice|is this correct|is this right|what do you think|any issues|code quality|clean up|cleanup|lgtm)\b/.test(p))
      return 'code_review';

    if (/\b(refactor|restructure|reorganize|rename|move|extract|simplify|rewrite|redesign|clean|decouple|modular|modularize|split|separate)\b/.test(p))
      return 'refactoring';

    if (/\b(test|spec|coverage|mock|unit|jest|pytest|assert|expect|integration|e2e|cypress|vitest|playwright|describe|it should|test case|test suite|tdd|bdd)\b/.test(p))
      return 'testing';

    if (/\b(document|readme|comment|docstring|jsdoc|wiki|changelog|docs|add docs|write docs|explain this code|what does this do|annotate|summarize)\b/.test(p))
      return 'documentation';

    if (/\b(config|setup|install|configure|settings|init|environment|env|deploy|docker|kubernetes|helm|ci|cd|pipeline|workflow|nginx|apache|database|db|connection|port|host|url|certificate|ssl|aws|gcp|azure|render|vercel)\b/.test(p))
      return 'configuration';

    if (/\b(architect|design|structure|pattern|approach|strategy|system design|how should|best approach|which approach|how to organize|folder structure|project structure|database schema|data model|api design|erd|uml)\b/.test(p))
      return 'architecture';

    if (/\b(what is|what are|how does|how do|explain|tell me|difference between|compare|pros and cons|when to use|which is better|learn|understand|overview|introduction|tutorial|help me understand|can you explain)\b/.test(p))
      return 'research';

    if (/\b(analyse|analyze|review|audit|assess|evaluate|performance|bottleneck|slow|memory leak|cpu usage|optimize|profil|metrics|monitoring|benchmark)\b/.test(p))
      return 'analysis';

    if (/\b(automate|automation|script|schedule|cron|workflow|pipeline|batch|process|scaffolding|boilerplate|generate)\b/.test(p))
      return 'automation';

    if (/\b(write|create|build|implement|add|make|new|function|class|component|module|feature|endpoint|api|route|model|schema|migration|service|controller|handler|hook|helper|utility|util|page|view|widget|button|form|table|chart|dashboard)\b/.test(p))
      return 'code_generation';
  }

  // ── TOOL-BASED FALLBACK ─────────────────────
  if (t === 'copilot')   return 'code_generation';
  if (t === 'cursor')    return 'code_generation';
  if (t === 'windsurf')  return 'code_generation';
  if (t === 'cline')     return 'code_generation';
  if (t === 'roo')       return 'code_generation';
  if (t === 'kilo')      return 'code_generation';
  if (t === 'codex')     return 'code_generation';
  if (t === 'gemini')    return 'research';
  if (t === 'pi')        return 'research';

  // ── TURN COUNT FALLBACK ─────────────────────
  if (turns >= 50) return 'debugging';
  if (turns >= 20) return 'code_generation';
  if (turns >= 10) return 'analysis';
  if (turns >= 5)  return 'code_generation';
  if (turns >= 2)  return 'research';

  // ── PROJECT NAME FALLBACK ───────────────────
  if (proj.includes('test'))    return 'testing';
  if (proj.includes('doc'))     return 'documentation';
  if (proj.includes('config'))  return 'configuration';
  if (proj.includes('setup'))   return 'configuration';
  if (proj.includes('deploy'))  return 'configuration';
  if (proj.includes('infra'))   return 'configuration';
  if (proj.includes('server'))  return 'code_generation';
  if (proj.includes('api'))     return 'code_generation';
  if (proj.includes('frontend'))return 'code_generation';
  if (proj.includes('backend')) return 'code_generation';
  if (proj.includes('aiops'))   return 'code_generation';
  if (proj.includes('dashboard'))return 'code_generation';

  return 'other';
}

export function computeDailyAggregates(days: number): DailyAggregate[] {
  // Aggregate from the LIVE scan so synced data matches `aiops scan` and works
  // on machines where better-sqlite3 isn't built (empty DB). Fall back to the
  // DB only when the live scan yields nothing (offline/unreadable logs).
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

  const todayStr = new Date().toISOString().slice(0, 10);

  for (const s of sessions) {
    const category = classifyCategory(
      s.firstPrompt,
      s.tool,
      s.turnCount,
      s.projectName,
    );
    // Some tools (e.g. Codex) leave sessionDate empty but carry a timestamp.
    // Derive the date from the timestamp so the session still syncs and lands
    // on the right day — falling back to today only if neither is present.
    const date = s.sessionDate
      || (s.sessionTimestamp ? new Date(s.sessionTimestamp).toISOString().slice(0, 10) : todayStr);
    const key = [date, s.tool, s.model, category].join('|');

    if (!groups.has(key)) {
      groups.set(key, {
        date,
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
    .filter(g => g.sessions > 0)
    .map(g => ({
      ...g,
      date: g.date || new Date().toISOString().slice(0, 10),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
