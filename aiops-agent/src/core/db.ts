import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { SessionRecord } from './types.js';
import { logError } from './logger.js';
import type { HistoricalSummary } from './types.js';

const _require = createRequire(import.meta.url);
let Database: any = null;
try { Database = _require('better-sqlite3'); } catch { /* optional */ }

const AIOPS_DIR = path.join(os.homedir(), '.aiops');
const DB_PATH   = path.join(AIOPS_DIR, 'sessions.db');

let db: any = null;

export function openDb(): void {
  if (db) return;
  if (!Database) return;
  try {
    fs.mkdirSync(AIOPS_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id         TEXT NOT NULL,
        tool               TEXT NOT NULL,
        model              TEXT NOT NULL DEFAULT '',
        project_name       TEXT NOT NULL DEFAULT '',
        project_path       TEXT NOT NULL DEFAULT '',
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens       INTEGER NOT NULL DEFAULT 0,
        cost_usd           REAL NOT NULL DEFAULT 0,
        token_source       TEXT NOT NULL DEFAULT 'estimate',
        session_date       TEXT NOT NULL DEFAULT '',
        session_timestamp  INTEGER NOT NULL DEFAULT 0,
        turn_count         INTEGER NOT NULL DEFAULT 0,
        user_turn_count    INTEGER NOT NULL DEFAULT 0,
        first_prompt       TEXT,
        sent_to_server     INTEGER NOT NULL DEFAULT 0,
        inserted_at        INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(session_id, tool)
      );
      CREATE INDEX IF NOT EXISTS idx_date ON sessions(session_date);
      CREATE INDEX IF NOT EXISTS idx_tool ON sessions(tool);
      CREATE INDEX IF NOT EXISTS idx_ts   ON sessions(session_timestamp);

      CREATE TABLE IF NOT EXISTS scans (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        scanned_at       INTEGER NOT NULL,
        sessions_seen    INTEGER NOT NULL,
        sessions_new     INTEGER NOT NULL,
        sessions_updated INTEGER NOT NULL,
        total_cost_usd   REAL NOT NULL,
        duration_ms      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budgets (
        period     TEXT PRIMARY KEY,
        limit_usd  REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  } catch (err) {
    logError('db', 'openDb failed', err);
    db = null;
  }
}

function ensureOpen(): boolean {
  if (db) return true;
  if (!Database) return false;
  openDb();
  return db !== null;
}

export function isAvailable(): boolean {
  return ensureOpen();
}

export function dbPath(): string {
  return DB_PATH;
}

export interface UpsertResult {
  seen: number;
  inserted: number;
  updated: number;
  durationMs: number;
}

export function upsertSessions(sessions: SessionRecord[]): UpsertResult {
  const t0 = Date.now();
  const empty: UpsertResult = { seen: sessions.length, inserted: 0, updated: 0, durationMs: 0 };
  if (!ensureOpen() || !db) return empty;

  try {
    const findStmt = db.prepare(
      `SELECT total_tokens, cost_usd FROM sessions WHERE session_id = ? AND tool = ?`
    );
    const insertStmt = db.prepare(`
      INSERT INTO sessions (
        session_id, tool, model, project_name, project_path,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        cost_usd, token_source, session_date, session_timestamp,
        turn_count, user_turn_count, first_prompt, sent_to_server
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = db.prepare(`
      UPDATE sessions SET
        model = ?, project_name = ?, project_path = ?,
        input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
        total_tokens = ?, cost_usd = ?, token_source = ?,
        session_date = ?, session_timestamp = ?,
        turn_count = ?, user_turn_count = ?, first_prompt = ?
      WHERE session_id = ? AND tool = ?
    `);

    let inserted = 0, updated = 0;
    const tx = db.transaction((rows: SessionRecord[]) => {
      for (const s of rows) {
        try {
          const existing = findStmt.get(s.sessionId, s.tool) as
            | { total_tokens: number; cost_usd: number }
            | undefined;
          if (existing) {
            const changed =
              existing.total_tokens !== s.totalTokens ||
              Math.abs(existing.cost_usd - s.costUSD) > 1e-9;
            updateStmt.run(
              s.model ?? '', s.projectName ?? '', s.projectPath ?? '',
              s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens,
              s.totalTokens, s.costUSD, s.tokenSource ?? 'estimate',
              s.sessionDate ?? '', s.sessionTimestamp ?? 0,
              s.turnCount, s.userTurnCount ?? 0, s.firstPrompt ?? null,
              s.sessionId, s.tool,
            );
            if (changed) updated++;
          } else {
            insertStmt.run(
              s.sessionId, s.tool, s.model ?? '', s.projectName ?? '', s.projectPath ?? '',
              s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens, s.totalTokens,
              s.costUSD, s.tokenSource ?? 'estimate', s.sessionDate ?? '', s.sessionTimestamp ?? 0,
              s.turnCount, s.userTurnCount ?? 0, s.firstPrompt ?? null, s.sentToServer,
            );
            inserted++;
          }
        } catch (err) {
          logError('db', `Failed to upsert session ${s.tool}/${s.sessionId}`, err);
        }
      }
    });
    tx(sessions);

    const durationMs = Date.now() - t0;
    try {
      db.prepare(`
        INSERT INTO scans
          (scanned_at, sessions_seen, sessions_new, sessions_updated, total_cost_usd, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        Date.now(), sessions.length, inserted, updated,
        sessions.reduce((a, s) => a + s.costUSD, 0), durationMs,
      );
    } catch (err) {
      logError('db', 'Failed to record scan', err);
    }

    return { seen: sessions.length, inserted, updated, durationMs };
  } catch (err) {
    logError('db', 'upsertSessions failed', err);
    return empty;
  }
}

function rowToSession(r: Record<string, unknown>): SessionRecord {
  return {
    tool:             String(r['tool'] ?? ''),
    model:            String(r['model'] ?? ''),
    sessionId:        String(r['session_id'] ?? ''),
    projectPath:      String(r['project_path'] ?? ''),
    projectName:      String(r['project_name'] ?? ''),
    inputTokens:      Number(r['input_tokens'] ?? 0),
    outputTokens:     Number(r['output_tokens'] ?? 0),
    cacheReadTokens:  Number(r['cache_read_tokens'] ?? 0),
    cacheWriteTokens: Number(r['cache_write_tokens'] ?? 0),
    totalTokens:      Number(r['total_tokens'] ?? 0),
    costUSD:          Number(r['cost_usd'] ?? 0),
    tokenSource:      (r['token_source'] as SessionRecord['tokenSource']) ?? 'estimate',
    sessionDate:      String(r['session_date'] ?? ''),
    sessionTimestamp: Number(r['session_timestamp'] ?? 0),
    turnCount:        Number(r['turn_count'] ?? 0),
    userTurnCount:    r['user_turn_count'] == null ? undefined : Number(r['user_turn_count']),
    firstPrompt:      r['first_prompt'] == null ? undefined : String(r['first_prompt']),
    sentToServer:     0,
  };
}

export function getSessionsSince(days: number): SessionRecord[] {
  if (!ensureOpen() || !db) return [];
  const cutoff = Date.now() - days * 86400000;
  try {
    // Include sessions with session_timestamp = 0 (unknown timestamp) so they
    // are never silently dropped from syncs regardless of the days window.
    const rows = db.prepare(
      `SELECT * FROM sessions WHERE session_timestamp >= ? OR session_timestamp = 0 ORDER BY session_timestamp DESC`
    ).all(cutoff) as Record<string, unknown>[];
    return rows.map(rowToSession);
  } catch (err) {
    logError('db', 'getSessionsSince failed', err);
    return [];
  }
}

export interface DailyTotal { date: string; sessions: number; tokens: number; cost: number; }

export function getDailyTotals(days: number): DailyTotal[] {
  if (!ensureOpen() || !db) return [];
  const cutoff = Date.now() - days * 86400000;
  try {
    const rows = db.prepare(`
      SELECT session_date AS date,
             COUNT(*) AS sessions,
             SUM(total_tokens) AS tokens,
             SUM(cost_usd) AS cost
      FROM sessions
      WHERE session_timestamp >= ? AND session_date != ''
      GROUP BY session_date
      ORDER BY session_date ASC
    `).all(cutoff) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      date:     String(r['date'] ?? ''),
      sessions: Number(r['sessions'] ?? 0),
      tokens:   Number(r['tokens'] ?? 0),
      cost:     Number(r['cost'] ?? 0),
    }));
  } catch (err) {
    logError('db', 'getDailyTotals failed', err);
    return [];
  }
}

export interface WeeklyTotal { weekStart: string; sessions: number; tokens: number; cost: number; }

export function getWeeklyTotals(weeks: number): WeeklyTotal[] {
  const daily = getDailyTotals(weeks * 7 + 7);
  const buckets: Record<string, WeeklyTotal> = {};
  for (const d of daily) {
    if (!d.date) continue;
    const dt = new Date(d.date + 'T12:00:00Z');
    const dow = (dt.getUTCDay() + 6) % 7;
    const monday = new Date(dt.getTime() - dow * 86400000);
    const key = monday.toISOString().slice(0, 10);
    if (!buckets[key]) buckets[key] = { weekStart: key, sessions: 0, tokens: 0, cost: 0 };
    buckets[key].sessions += d.sessions;
    buckets[key].tokens   += d.tokens;
    buckets[key].cost     += d.cost;
  }
  return Object.values(buckets)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .slice(-weeks);
}

export interface ScanRecord {
  scannedAt: number; sessionsSeen: number; sessionsNew: number;
  sessionsUpdated: number; totalCostUsd: number; durationMs: number;
}

export function getRecentScans(limit = 10): ScanRecord[] {
  if (!ensureOpen() || !db) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM scans ORDER BY scanned_at DESC LIMIT ?`
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      scannedAt:       Number(r['scanned_at'] ?? 0),
      sessionsSeen:    Number(r['sessions_seen'] ?? 0),
      sessionsNew:     Number(r['sessions_new'] ?? 0),
      sessionsUpdated: Number(r['sessions_updated'] ?? 0),
      totalCostUsd:    Number(r['total_cost_usd'] ?? 0),
      durationMs:      Number(r['duration_ms'] ?? 0),
    }));
  } catch (err) {
    logError('db', 'getRecentScans failed', err);
    return [];
  }
}

export interface BudgetStatus {
  period: 'daily' | 'weekly' | 'monthly'; limitUsd: number; spentUsd: number; pctUsed: number;
}

export function setBudget(period: 'daily' | 'weekly' | 'monthly', limitUsd: number): boolean {
  if (!ensureOpen() || !db) return false;
  try {
    db.prepare(`
      INSERT INTO budgets (period, limit_usd, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(period) DO UPDATE SET limit_usd = excluded.limit_usd, updated_at = excluded.updated_at
    `).run(period, limitUsd, Date.now());
    return true;
  } catch (err) {
    logError('db', `setBudget(${period}) failed`, err);
    return false;
  }
}

export function getBudgets(): BudgetStatus[] {
  if (!ensureOpen() || !db) return [];
  try {
    const rows = db.prepare(
      `SELECT period, limit_usd FROM budgets`
    ).all() as Array<Record<string, unknown>>;
    if (!rows.length) return [];
    const now = Date.now();
    const out: BudgetStatus[] = [];
    for (const r of rows) {
      const period = String(r['period']) as 'daily' | 'weekly' | 'monthly';
      const limitUsd = Number(r['limit_usd'] ?? 0);
      const fromMs =
        period === 'daily'  ? now - 86400000 :
        period === 'weekly' ? now - 7 * 86400000 :
                              now - 30 * 86400000;
      const row = db.prepare(
        `SELECT SUM(cost_usd) AS spent FROM sessions WHERE session_timestamp >= ?`
      ).get(fromMs) as { spent: number | null };
      const spentUsd = Number(row?.spent ?? 0);
      out.push({ period, limitUsd, spentUsd, pctUsed: limitUsd > 0 ? (spentUsd / limitUsd) * 100 : 0 });
    }
    return out;
  } catch (err) {
    logError('db', 'getBudgets failed', err);
    return [];
  }
}

export function getDbStats(): { totalRows: number; dbSizeKb: number; oldestDate: string } {
  if (!ensureOpen() || !db) return { totalRows: 0, dbSizeKb: 0, oldestDate: '' };
  try {
    const totalRows = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM sessions`).get() as { cnt: number }
    ).cnt;
    const dbSizeKb = Math.round(fs.statSync(DB_PATH).size / 1024);
    const oldest = db.prepare(
      `SELECT MIN(session_date) AS d FROM sessions`
    ).get() as { d: string | null };
    return { totalRows, dbSizeKb, oldestDate: oldest.d ?? '' };
  } catch (err) {
    logError('db', 'getDbStats failed', err);
    return { totalRows: 0, dbSizeKb: 0, oldestDate: '' };
  }
}

export function getUnsent(): SessionRecord[] {
  if (!ensureOpen() || !db) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM sessions WHERE sent_to_server = 0`
    ).all() as Record<string, unknown>[];
    return rows.map(rowToSession);
  } catch (err) {
    logError('db', 'getUnsent failed', err);
    return [];
  }
}

export function markSent(sessionIds: string[]): void {
  if (!ensureOpen() || !db || !sessionIds.length) return;
  try {
    const placeholders = sessionIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE sessions SET sent_to_server = 1 WHERE session_id IN (${placeholders})`
    ).run(...sessionIds);
  } catch (err) {
    logError('db', 'markSent failed', err);
  }
}

export function getHistoricalSummary(days = 28): HistoricalSummary {
  const empty: HistoricalSummary = {
    totalSessions: 0, totalTokens: 0, totalCostUsd: 0,
    byDay: [], byWeek: [], byTool: [], byModel: [],
  };
  if (!ensureOpen() || !db) return empty;
  const cutoff = Date.now() - days * 86400000;
  try {
    const totals = db.prepare(`
      SELECT COUNT(*) AS total_sessions,
             SUM(total_tokens) AS total_tokens,
             SUM(cost_usd) AS total_cost
      FROM sessions WHERE session_timestamp >= ?
    `).get(cutoff) as { total_sessions: number; total_tokens: number; total_cost: number };

    const byDayRows = db.prepare(`
      SELECT session_date AS date,
             COUNT(*) AS sessions,
             SUM(total_tokens) AS tokens,
             SUM(cost_usd) AS cost_usd
      FROM sessions WHERE session_timestamp >= ?
      GROUP BY session_date ORDER BY session_date DESC
    `).all(cutoff) as Array<{ date: string; sessions: number; tokens: number; cost_usd: number }>;

    const byToolRows = db.prepare(`
      SELECT tool,
             COUNT(*) AS sessions,
             SUM(total_tokens) AS tokens,
             SUM(cost_usd) AS cost_usd
      FROM sessions WHERE session_timestamp >= ?
      GROUP BY tool ORDER BY sessions DESC
    `).all(cutoff) as Array<{ tool: string; sessions: number; tokens: number; cost_usd: number }>;

    const byModelRows = db.prepare(`
      SELECT model,
             COUNT(*) AS sessions,
             SUM(total_tokens) AS tokens,
             SUM(cost_usd) AS cost_usd
      FROM sessions WHERE session_timestamp >= ?
      GROUP BY model ORDER BY cost_usd DESC
    `).all(cutoff) as Array<{ model: string; sessions: number; tokens: number; cost_usd: number }>;

    // Build byWeek buckets from byDay results
    const now = Date.now();
    const w4cut = now - 7 * 86400000;
    const w3cut = now - 14 * 86400000;
    const w2cut = now - 21 * 86400000;
    const w1cut = now - 28 * 86400000;

    type WBucket = { sessions: number; tokens: number; costUsd: number };
    const wb: Record<string, WBucket> = {
      'W4 (last 7 days)':  { sessions: 0, tokens: 0, costUsd: 0 },
      'W3 (8–14 days)':    { sessions: 0, tokens: 0, costUsd: 0 },
      'W2 (15–21 days)':   { sessions: 0, tokens: 0, costUsd: 0 },
      'W1 (22–28 days)':   { sessions: 0, tokens: 0, costUsd: 0 },
    };
    for (const d of byDayRows) {
      const ts = new Date(d.date + 'T12:00:00Z').getTime();
      const b =
        ts >= w4cut ? wb['W4 (last 7 days)'] :
        ts >= w3cut ? wb['W3 (8–14 days)']   :
        ts >= w2cut ? wb['W2 (15–21 days)']  :
        ts >= w1cut ? wb['W1 (22–28 days)']  : null;
      if (b) { b.sessions += d.sessions; b.tokens += d.tokens; b.costUsd += d.cost_usd; }
    }

    return {
      totalSessions: Number(totals.total_sessions ?? 0),
      totalTokens:   Number(totals.total_tokens ?? 0),
      totalCostUsd:  Number(totals.total_cost ?? 0),
      byDay:   byDayRows.map(r => ({ date: r.date, sessions: r.sessions, tokens: r.tokens, costUsd: r.cost_usd })),
      byWeek:  Object.entries(wb).map(([week, v]) => ({ week, ...v })),
      byTool:  byToolRows.map(r => ({ tool: r.tool, sessions: r.sessions, tokens: r.tokens, costUsd: r.cost_usd })),
      byModel: byModelRows.map(r => ({ model: r.model, sessions: r.sessions, tokens: r.tokens, costUsd: r.cost_usd })),
    };
  } catch (err) {
    logError('db', 'getHistoricalSummary failed', err);
    return empty;
  }
}
