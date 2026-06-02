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
try { Database = _require('better-sqlite3'); } catch { /* native module unavailable */ }

function toolExists(): boolean {
  try { return fs.existsSync(PATHS.windsurfDb); }
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
    input:  Number(obj['inputTokens']  ?? obj['tokensIn']  ?? obj['input_tokens']  ?? obj['promptTokenCount']     ?? 0),
    output: Number(obj['outputTokens'] ?? obj['tokensOut'] ?? obj['output_tokens'] ?? obj['candidatesTokenCount'] ?? 0),
  };
}

export function loadWindsurf(): AdapterResult {
  if (!toolExists()) return EMPTY_RESULT;
  if (!Database) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors  = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;

  try {
    try {
      db = new Database(PATHS.windsurfDb, { readonly: true, fileMustExist: true });
    } catch (err) {
      logError('windsurf', 'Cannot open database (may be locked)', err);
      return EMPTY_RESULT;
    }

    let tableNames: string[] = [];
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      tableNames = rows.map(r => r.name);
    } catch (err) {
      logError('windsurf', 'Failed to query sqlite_master', err);
      return EMPTY_RESULT;
    }

    if (!tableNames.includes('ItemTable')) return EMPTY_RESULT;

    let row: { value: string } | undefined;
    try {
      row = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get() as { value: string } | undefined;
    } catch (err) {
      logError('windsurf', 'Failed to query ItemTable', err);
      return EMPTY_RESULT;
    }

    if (!row) return EMPTY_RESULT;

    let list: Record<string, unknown>[] = [];
    try {
      const index = JSON.parse(row.value) as Record<string, unknown>;
      // Windsurf v1 format uses 'entries', older versions used 'sessions'/'chatSessions'
      list = (index['entries'] ?? index['sessions'] ?? index['chatSessions'] ?? (Array.isArray(index) ? index : [])) as Record<string, unknown>[];
    } catch (err) {
      logError('windsurf', 'Failed to parse chat session index JSON', err);
      return EMPTY_RESULT;
    }

    for (const s of list) {
      try {
        const ts = toTimestamp(s['createdAt'] ?? s['lastUpdated'] ?? s['timestamp']);
        const t = parseTokenField(s);
        let inputTokens  = t.input;
        let outputTokens = t.output;
        let tokenSource: SessionRecord['tokenSource'] = 'log_file';

        if (inputTokens === 0 && outputTokens === 0) {
          const text = JSON.stringify(s);
          inputTokens  = countByTiktoken(text);
          outputTokens = Math.round(inputTokens * 0.4);
          tokenSource = 'tiktoken';
        }

        const model = String(s['model'] ?? s['modelId'] ?? '');

        sessions.push({
          tool: 'windsurf',
          model: model || 'unknown',
          sessionId: String(s['id'] ?? s['sessionId'] ?? '').slice(0, 8),
          projectPath: PATHS.windsurfDb,
          projectName: 'Windsurf',
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: inputTokens + outputTokens,
          costUSD: calcCost(model, inputTokens, outputTokens),
          tokenSource,
          sessionDate: toDateStr(ts),
          sessionTimestamp: ts,
          turnCount: Number(s['turns'] ?? s['turnCount'] ?? 0),
          sentToServer: 0,
        });
      } catch (err) {
        logError('windsurf', 'Failed to parse session entry', err);
        errors++;
        skipped++;
      }
    }
  } catch (err) {
    logError('windsurf', 'Unexpected error in loadWindsurf', err);
    errors++;
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}
