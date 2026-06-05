import fs from 'fs';
import { createRequire } from 'module';
import { SessionRecord, AdapterResult, EMPTY_RESULT } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { calcCost } from '../core/pricing.js';
import { countByTiktoken } from '../core/tokenizer.js';
import { logError } from '../core/logger.js';

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try { Database = _require('better-sqlite3'); } catch { /* native module unavailable — Cursor/Windsurf data will be skipped */ }

function toolExists(): boolean {
  try { return fs.existsSync(PATHS.cursorDb); }
  catch { return false; }
}

function toDateStr(ts: unknown): string {
  if (!ts) return '';
  try {
    const n = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : Number(ts);
    return new Date(isNaN(n) ? String(ts) : n).toISOString().slice(0, 10);
  } catch { return ''; }
}

function toTimestamp(ts: unknown): number {
  if (!ts) return 0;
  try {
    const n = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : Number(ts);
    return isNaN(n) ? new Date(String(ts)).getTime() : n;
  } catch { return 0; }
}

function parseTokenField(obj: Record<string, unknown>): { input: number; output: number } {
  return {
    input:  Number(obj['inputTokens']  ?? obj['input_tokens']  ?? obj['promptTokenCount']     ?? 0),
    output: Number(obj['outputTokens'] ?? obj['output_tokens'] ?? obj['candidatesTokenCount'] ?? 0),
  };
}

export function loadCursor(): AdapterResult {
  if (!toolExists()) return EMPTY_RESULT;
  if (!Database) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors  = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;

  try {
    try {
      db = new Database(PATHS.cursorDb, { readonly: true, fileMustExist: true });
    } catch (err) {
      // Database is locked or corrupt — skip this cycle, retry on next watcher tick
      logError('cursor', 'Cannot open database (may be locked)', err);
      return EMPTY_RESULT;
    }

    let tableNames: string[] = [];
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      tableNames = rows.map(r => r.name);
    } catch (err) {
      logError('cursor', 'Failed to query sqlite_master', err);
      return EMPTY_RESULT;
    }

    if (!tableNames.includes('cursorDiskKV')) return EMPTY_RESULT;

    let rows: { key: string; value: string }[] = [];
    try {
      rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as { key: string; value: string }[];
    } catch (err) {
      logError('cursor', 'Failed to query cursorDiskKV', err);
      return EMPTY_RESULT;
    }

    for (const row of rows) {
      try {
        const data = JSON.parse(row.value) as Record<string, unknown>;
        if (!data) { skipped++; continue; }

        const composerId = row.key.replace('composerData:', '');

        let inputTokens = 0, outputTokens = 0;
        let model = '';
        let turnCount = 0;
        let hasTokens = false;

        // Cursor stores bubbles as "bubbleId:{composerId}:{bubbleId}" in the same table
        const bubbleRows = db.prepare(
          "SELECT value FROM cursorDiskKV WHERE key LIKE ?"
        ).all(`bubbleId:${composerId}:%`) as { value: string }[];

        for (const br of bubbleRows) {
          try {
            const b = JSON.parse(br.value) as Record<string, unknown>;
            if (!b) continue;

            // type 1 = AI response, type 2 = user message
            const btype = Number(b['type'] ?? -1);
            if (btype === 1) turnCount++;

            // Model is in modelInfo.modelName on AI bubbles
            if (!model && btype === 1) {
              const mi = b['modelInfo'] as Record<string, unknown> | undefined;
              if (mi?.['modelName']) model = String(mi['modelName']);
            }

            // Token counts (Cursor stores these but often 0 for free-tier usage)
            const tc = (b['tokenCount'] ?? {}) as Record<string, unknown>;
            const t = parseTokenField(tc);
            if (t.input > 0 || t.output > 0) {
              hasTokens = true;
              inputTokens  += t.input;
              outputTokens += t.output;
            }
          } catch (err) {
            logError('cursor', `Failed to parse bubble for composer ${composerId}`, err);
            errors++;
          }
        }

        // Fallback: model config from composer-level data
        if (!model) {
          const mc = data['modelConfig'] as Record<string, unknown> | undefined;
          if (mc?.['modelName']) model = String(mc['modelName']);
        }

        const sessionTs = toTimestamp(data['createdAt']);

        // Include sessions with a valid timestamp, even if no interactions (turnCount=0, bubbleRows=0)
        // These are initialized sessions that exist but weren't used yet
        if (!sessionTs) { skipped++; continue; }

        sessions.push({
          tool: 'cursor',
          model: model || 'cursor',
          sessionId: composerId.slice(0, 8),
          projectPath: PATHS.cursorDb,
          projectName: 'Cursor',
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: inputTokens + outputTokens,
          costUSD: calcCost(model, inputTokens, outputTokens),
          tokenSource: hasTokens ? 'log_file' : 'estimate',
          sessionDate: toDateStr(sessionTs),
          sessionTimestamp: sessionTs,
          turnCount,
          sentToServer: 0,
        });
      } catch (err) {
        logError('cursor', `Failed to parse composer row ${row.key}`, err);
        errors++;
        skipped++;
      }
    }
  } catch (err) {
    logError('cursor', 'Unexpected error in loadCursor', err);
    errors++;
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}
