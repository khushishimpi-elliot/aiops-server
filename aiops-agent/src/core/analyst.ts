import fs from 'fs';
import path from 'path';
import { runAllAdapters } from '../adapters/index.js';
import { SessionRecord } from './types.js';
import { PATHS } from './paths.js';
import { logError } from './logger.js';

const NOW = Date.now();
const DAYS_28 = 28 * 24 * 60 * 60 * 1000;
const DAYS_30 = 30 * 24 * 60 * 60 * 1000;
const CUTOFF_28 = NOW - DAYS_28;
const CUTOFF_30 = NOW - DAYS_30;

interface NormalizedSession {
  session_id: string;
  tool_name: string;
  date: string;
  hour: number;
  turn_count: number;
  user_turn_count: number;
  first_prompt: string;
  dominant_task_category: string;
  session_duration_minutes: number | null;
}

const TASK_CATEGORIES = [
  'code_generation', 'debugging', 'writing', 'analysis',
  'research', 'automation', 'configuration', 'other',
] as const;
type TaskCategory = typeof TASK_CATEGORIES[number];

function classifyTask(prompt: string): TaskCategory {
  const p = prompt.toLowerCase();
  if (/\b(bug|fix|error|exception|crash|debug|broken|issue|failing|traceback)\b/.test(p)) return 'debugging';
  if (/\b(write|draft|document|readme|comment|explain|describe|summarize|essay)\b/.test(p)) return 'writing';
  if (/\b(analyze|analyse|review|audit|check|assess|evaluate|inspect|report)\b/.test(p)) return 'analysis';
  if (/\b(research|find out|what is|how does|explain|learn|understand|look up)\b/.test(p)) return 'research';
  if (/\b(automate|script|schedule|pipeline|workflow|ci|cd|deploy|cron|job)\b/.test(p)) return 'automation';
  if (/\b(config|setup|install|configure|settings|env|environment|init|scaffold)\b/.test(p)) return 'configuration';
  if (/\b(create|build|implement|add|generate|code|function|class|component|feature|make)\b/.test(p)) return 'code_generation';
  return 'other';
}

function walkDir(dir: string, exts: string[], maxDepth = 3): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  function recurse(d: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) recurse(full, depth + 1);
        else if (e.isFile() && exts.some(ext => e.name.endsWith(ext))) out.push(full);
      }
    } catch { /* skip unreadable dirs */ }
  }
  recurse(dir, 0);
  return out;
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// Scan flat-file tools not covered by existing adapters
function scanExtraPath(toolName: string, dir: string): NormalizedSession[] {
  const sessions: NormalizedSession[] = [];
  const files = walkDir(dir, ['.json', '.jsonl'])
    .filter(f => { try { return fs.statSync(f).mtimeMs >= CUTOFF_30; } catch { return false; } });

  for (const file of files) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const date = new Date(mtime).toISOString().slice(0, 10);
      const hour = new Date(mtime).getHours();
      sessions.push({
        session_id: path.basename(file, path.extname(file)).slice(0, 16),
        tool_name: toolName,
        date,
        hour,
        turn_count: 0,
        user_turn_count: 0,
        first_prompt: '',
        dominant_task_category: 'other',
        session_duration_minutes: null,
      });
    } catch { /* skip */ }
  }
  return sessions;
}

// Try to query goose SQLite (sessions.db)
function scanGooseDb(): NormalizedSession[] {
  if (!fs.existsSync(PATHS.gooseDb)) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let Database: typeof import('better-sqlite3') | null = null;
    try { Database = require('better-sqlite3'); } catch { return []; }
    if (!Database) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new (Database as any)(PATHS.gooseDb, { readonly: true, fileMustExist: true });
    const tables: { name: string }[] = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    const sessions: NormalizedSession[] = [];
    const sessionTable = tableNames.find(n => /session/i.test(n));
    if (sessionTable) {
      const rows: Record<string, unknown>[] = db.prepare(`SELECT * FROM "${sessionTable}" ORDER BY rowid DESC LIMIT 200`).all() as Record<string, unknown>[];
      for (const row of rows) {
        const tsRaw = row['created_at'] ?? row['timestamp'] ?? row['updated_at'];
        const ts = tsRaw ? new Date(String(tsRaw)).getTime() : 0;
        if (ts && ts < CUTOFF_28) continue;
        const date = ts ? new Date(ts).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
        sessions.push({
          session_id: String(row['id'] ?? row['session_id'] ?? '').slice(0, 16),
          tool_name: 'Goose',
          date,
          hour: ts ? new Date(ts).getHours() : 0,
          turn_count: Number(row['turn_count'] ?? row['message_count'] ?? 0),
          user_turn_count: 0,
          first_prompt: '',
          dominant_task_category: 'other',
          session_duration_minutes: null,
        });
      }
    }
    db.close();
    return sessions;
  } catch (err) {
    logError('analyst', 'Failed to query goose DB', err);
    return [];
  }
}

function normalizeFromRecord(s: SessionRecord): NormalizedSession {
  const ts = s.sessionTimestamp || 0;
  const endTs = s.sessionEndTimestamp || ts;
  const durationMin = (ts && endTs && endTs > ts)
    ? Math.round((endTs - ts) / 60000)
    : null;
  const totalTurns = (s.userTurnCount ?? 0) + s.turnCount;
  return {
    session_id: s.sessionId,
    tool_name: s.tool,
    date: s.sessionDate,
    hour: ts ? new Date(ts).getHours() : 0,
    turn_count: totalTurns || s.turnCount,
    user_turn_count: s.userTurnCount ?? 0,
    first_prompt: s.firstPrompt ?? '',
    dominant_task_category: classifyTask(s.firstPrompt ?? ''),
    session_duration_minutes: durationMin,
  };
}

function weekKey(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  const diffMs = NOW - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 7)  return 'W4';
  if (diffDays < 14) return 'W3';
  if (diffDays < 21) return 'W2';
  return 'W1';
}

function avgWords(prompts: string[]): number {
  if (!prompts.length) return 0;
  const total = prompts.reduce((a, p) => a + p.split(/\s+/).filter(Boolean).length, 0);
  return Math.round(total / prompts.length);
}

export function runAnalysis(): Record<string, unknown> {
  const dataQualityNotes: string[] = [];
  const toolsDetected: string[] = [];

  // Gather sessions from existing adapters
  let adapterSessions: NormalizedSession[] = [];
  try {
    const results = runAllAdapters();
    for (const r of results) {
      if (r.sessions.length > 0) toolsDetected.push(r.label);
      for (const s of r.sessions) {
        if (!s.sessionTimestamp || s.sessionTimestamp < CUTOFF_28) continue;
        adapterSessions.push(normalizeFromRecord(s));
      }
    }
  } catch (err) {
    logError('analyst', 'runAllAdapters failed', err);
    dataQualityNotes.push('Adapter scan encountered errors — some tools may be missing');
  }

  // Gather sessions from extra paths
  const extraScanMap: Array<{ label: string; dir: string }> = [
    { label: 'Claude Agent', dir: PATHS.claudeAgentSessions },
    { label: 'Codex',        dir: PATHS.codexSessions },
    { label: 'Kiro',         dir: PATHS.kiroAgent },
    { label: 'OpenCode',     dir: PATHS.opencode },
    { label: 'OpenClaw',     dir: PATHS.openclaw },
    { label: 'Gemini Antigravity', dir: PATHS.geminiAntigravity },
    { label: 'Qwen',         dir: PATHS.qwen },
    { label: 'Pi',           dir: PATHS.pi },
    { label: 'OMP',          dir: PATHS.omp },
    { label: 'Factory',      dir: PATHS.factory },
  ];

  const extraSessions: NormalizedSession[] = [];
  for (const { label, dir } of extraScanMap) {
    if (fs.existsSync(dir)) {
      const found = scanExtraPath(label, dir);
      if (found.length > 0) {
        toolsDetected.push(label);
        extraSessions.push(...found);
      }
    }
  }

  // Goose SQLite
  const gooseSessions = scanGooseDb();
  if (gooseSessions.length > 0) {
    toolsDetected.push('Goose');
    extraSessions.push(...gooseSessions);
  }

  const allSessions = [...adapterSessions, ...extraSessions];

  if (!allSessions.length) {
    return {
      error: 'no_session_data_found',
      paths_checked: [
        PATHS.claude, PATHS.geminiTmp, PATHS.cursorDb, PATHS.windsurfDb,
        PATHS.clineTasks, PATHS.rooTasks, PATHS.kiloTasks,
        PATHS.claudeAgentSessions, PATHS.codexSessions, PATHS.kiroAgent,
        PATHS.opencode, PATHS.openclaw, PATHS.gooseDb, PATHS.geminiAntigravity,
        PATHS.qwen, PATHS.pi, PATHS.omp, PATHS.factory,
      ],
    };
  }

  // ── ENGAGEMENT ──────────────────────────────────────────────────────────────
  const byWeek: Record<string, NormalizedSession[]> = { W1: [], W2: [], W3: [], W4: [] };
  const activeDaysSet = new Set<string>();

  for (const s of allSessions) {
    const wk = weekKey(s.date);
    byWeek[wk].push(s);
    activeDaysSet.add(s.date);
  }

  const sessionsPerWeek = { W1: byWeek['W1'].length, W2: byWeek['W2'].length, W3: byWeek['W3'].length, W4: byWeek['W4'].length };
  const activeDays = activeDaysSet.size;
  const totalUserPrompts = allSessions.reduce((a, s) => a + s.user_turn_count, 0);

  // ── DEPTH ────────────────────────────────────────────────────────────────────
  const turns = allSessions.map(s => s.turn_count);
  const avgTurns = turns.length ? Math.round((turns.reduce((a, b) => a + b, 0) / turns.length) * 10) / 10 : 0;
  const multiTurnRate = turns.length ? Math.round((turns.filter(t => t >= 5).length / turns.length) * 100) : 0;
  const deepSessionRate = turns.length ? Math.round((turns.filter(t => t >= 10).length / turns.length) * 100) : 0;
  const longestSessionTurns = turns.length ? Math.max(...turns) : 0;

  // ── TASK COVERAGE ────────────────────────────────────────────────────────────
  const categoryCount: Record<string, number> = {};
  for (const s of allSessions) {
    categoryCount[s.dominant_task_category] = (categoryCount[s.dominant_task_category] ?? 0) + 1;
  }
  const total = allSessions.length;
  const taskBreakdown: Record<string, { count: number; pct: number }> = {};
  for (const [cat, cnt] of Object.entries(categoryCount)) {
    taskBreakdown[cat] = { count: cnt, pct: Math.round((cnt / total) * 100) };
  }
  const sortedCats = Object.entries(categoryCount).sort((a, b) => b[1] - a[1]);
  const primaryUseCase = sortedCats[0]?.[0] ?? 'other';
  const distinctCategories = Object.keys(categoryCount).length;
  const taskDiversityScore = Math.round((distinctCategories / 8) * 100);
  const top3UseCases = sortedCats.slice(0, 3).map(([cat]) => cat);

  // ── PROGRESSION ──────────────────────────────────────────────────────────────
  const w1 = sessionsPerWeek.W1, w4 = sessionsPerWeek.W4;
  const wowTrend = w1 > 0 ? Math.round(((w4 - w1) / w1) * 100) : (w4 > 0 ? 100 : 0);

  const toolCounts: Record<string, number> = {};
  for (const s of allSessions) {
    toolCounts[s.tool_name] = (toolCounts[s.tool_name] ?? 0) + 1;
  }

  const promptByWeek: Record<string, string[]> = { W1: [], W2: [], W3: [], W4: [] };
  for (const s of allSessions) {
    if (s.first_prompt) promptByWeek[weekKey(s.date)].push(s.first_prompt);
  }
  const avgPromptLengthTrend = {
    W1: avgWords(promptByWeek['W1']),
    W2: avgWords(promptByWeek['W2']),
    W3: avgWords(promptByWeek['W3']),
    W4: avgWords(promptByWeek['W4']),
  };

  // ── FRICTION ─────────────────────────────────────────────────────────────────
  const abandonedRate = turns.length ? Math.round((turns.filter(t => t <= 2).length / turns.length) * 100) : 0;

  // Build set of all 28 days
  const allDates: string[] = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(NOW - i * 86400000);
    allDates.push(d.toISOString().slice(0, 10));
  }
  const zeroSessionDays = allDates.filter(d => !activeDaysSet.has(d)).length;

  // Longest consecutive gap
  let longestGap = 0, currentGap = 0;
  for (const d of allDates.reverse()) {
    if (!activeDaysSet.has(d)) {
      currentGap++;
      if (currentGap > longestGap) longestGap = currentGap;
    } else {
      currentGap = 0;
    }
  }

  // ── READINESS SCORE ──────────────────────────────────────────────────────────
  const engagementScore = Math.min((activeDays / 28) * 50 + Math.min(total / 28, 1) * 50, 100);
  const depthScore = Math.min((avgTurns / 20) * 40 + (multiTurnRate * 0.4) + (deepSessionRate * 0.2), 100);
  const taskScore = taskDiversityScore;
  const progressionScore = Math.min(Math.max(50 + wowTrend / 2, 0), 100);
  const frictionScore = Math.max((1 - abandonedRate / 100) * 70 + (1 - Math.min(longestGap / 14, 1)) * 30, 0);
  const readinessScore = Math.round(
    engagementScore  * 0.25 +
    depthScore       * 0.25 +
    taskScore        * 0.20 +
    progressionScore * 0.15 +
    frictionScore    * 0.15
  );

  // ── 1-ON-1 TOPICS ────────────────────────────────────────────────────────────
  const topics: string[] = [];
  if (abandonedRate > 40) topics.push(`High session abandonment rate (${abandonedRate}%) — explore what's blocking completion`);
  if (deepSessionRate < 20) topics.push('Low deep-session rate — discuss strategies for more exploratory use cases');
  if (taskDiversityScore < 50) topics.push(`Tool usage concentrated in ${primaryUseCase} — identify untapped use cases`);
  if (wowTrend < -20) topics.push(`Usage declining week-over-week (${wowTrend}%) — check for friction or tooling issues`);
  if (wowTrend > 50)  topics.push(`Strong usage growth (${wowTrend}% WoW) — review quality and prompt patterns`);
  if (zeroSessionDays > 14) topics.push('More than half the period had no activity — discuss adoption barriers');
  if (Object.keys(toolCounts).length > 2) topics.push(`Multiple AI tools in use (${Object.keys(toolCounts).join(', ')}) — discuss consolidation or specialization`);
  while (topics.length < 3) {
    if (topics.length === 0) topics.push(`Primary use case is ${primaryUseCase} — explore adjacent workflows`);
    else if (topics.length === 1) topics.push('Review first-prompt patterns to identify recurring problem types');
    else topics.push('Set measurable goals for AI tool adoption in the next 4 weeks');
  }

  if (dataQualityNotes.length === 0) dataQualityNotes.push('All detected tool paths scanned successfully');

  return {
    report_generated: new Date().toISOString(),
    period: 'last_28_days',
    tools_detected: [...new Set(toolsDetected)],
    engagement: {
      total_sessions: total,
      sessions_per_week: sessionsPerWeek,
      active_days: activeDays,
      active_days_per_week: Math.round((activeDays / 4) * 10) / 10,
      total_user_prompts: totalUserPrompts,
    },
    depth: {
      avg_turns_per_session: avgTurns,
      multi_turn_rate: multiTurnRate,
      deep_session_rate: deepSessionRate,
      longest_session_turns: longestSessionTurns,
    },
    task_coverage: {
      task_category_breakdown: taskBreakdown,
      primary_use_case: primaryUseCase,
      task_diversity_score: taskDiversityScore,
    },
    progression: {
      week_over_week_trend: wowTrend,
      tools_used: toolCounts,
      tool_diversity_count: Object.keys(toolCounts).length,
      avg_prompt_length_trend: avgPromptLengthTrend,
    },
    friction: {
      abandoned_session_rate: abandonedRate,
      zero_session_days: zeroSessionDays,
      longest_gap_days: longestGap,
    },
    readiness_score: readinessScore,
    top_3_use_cases: top3UseCases,
    recommended_1on1_topics: topics.slice(0, 3),
    data_quality_notes: dataQualityNotes,
  };
}
