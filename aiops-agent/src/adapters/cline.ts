import fs from 'fs';
import path from 'path';
import { SessionRecord, AdapterResult, EMPTY_RESULT } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { calcCost } from '../core/pricing.js';
import { logError } from '../core/logger.js';

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    logError('cline', `readJson failed: ${file}`, err);
    return null;
  }
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

function parseTokenField(obj: Record<string, unknown>, key: string, ...fallbacks: string[]): number {
  for (const k of [key, ...fallbacks]) {
    const v = Number(obj[k] ?? NaN);
    if (!isNaN(v) && v >= 0) return v;
  }
  return 0;
}

export function loadClineFamily(tasksDir: string, toolName: string): AdapterResult {
  if (!fs.existsSync(tasksDir)) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors  = 0;

  let taskDirs: string[] = [];
  try {
    taskDirs = fs.readdirSync(tasksDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(tasksDir, e.name));
  } catch (err) {
    logError(toolName, `Cannot read tasks directory: ${tasksDir}`, err);
    return EMPTY_RESULT;
  }

  for (const td of taskDirs) {
    try {
      const uiMessages = readJson(path.join(td, 'ui_messages.json'));
      if (!Array.isArray(uiMessages)) { skipped++; continue; }

      let model = '';
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
      let turnCount = 0, lastTs = 0;
      let costUSD = 0, hasCost = false, hasTokens = false;

      for (const m of uiMessages as Record<string, unknown>[]) {
        try {
          // Cline 3.x stores model in top-level modelInfo, older versions in m['model']
          if (!model) {
            if (m['model']) {
              model = String(m['model']);
            } else {
              const mi = m['modelInfo'] as Record<string, unknown> | undefined;
              if (mi?.['modelId']) model = String(mi['modelId']);
            }
          }

          if (m['type'] === 'say' && m['say'] === 'api_req_started' && m['text']) {
            try {
              const p = JSON.parse(String(m['text'])) as Record<string, unknown>;
              if (!model && p['model']) model = String(p['model']);

              const inp = parseTokenField(p, 'tokensIn', 'inputTokens', 'input_tokens', 'promptTokenCount');
              const out = parseTokenField(p, 'tokensOut', 'outputTokens', 'output_tokens', 'candidatesTokenCount');
              const cr  = parseTokenField(p, 'cacheReads', 'cacheReadTokens', 'cache_read_input_tokens');
              const cw  = parseTokenField(p, 'cacheWrites', 'cacheWriteTokens', 'cache_creation_input_tokens');

              if (inp > 0 || out > 0) {
                hasTokens = true;
                inputTokens      += inp;
                outputTokens     += out;
                cacheReadTokens  += cr;
                cacheWriteTokens += cw;
                turnCount++;
              }

              const tc = Number(p['totalCost'] ?? p['cost'] ?? NaN);
              if (!isNaN(tc) && tc > 0) { hasCost = true; costUSD += tc; }
            } catch (err) {
              logError(toolName, `Failed to parse api_req_started text in ${td}`, err);
              errors++;
            }
          }

          const ts = toTimestamp(m['ts'] ?? m['timestamp']);
          if (ts > lastTs) lastTs = ts;
        } catch (err) {
          logError(toolName, `Failed to parse message in ${td}`, err);
          errors++;
        }
      }

      // Fallback: read task_metadata.json (Cline) for model if still unknown
      if (!model) {
        try {
          const meta = readJson(path.join(td, 'task_metadata.json')) as Record<string, unknown> | null;
          if (meta) {
            const usages = meta['model_usage'] as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(usages) && usages.length > 0 && usages[0]['model_id']) {
              model = String(usages[0]['model_id']);
            }
          }
        } catch { /* ignore */ }
      }

      // Fallback: read history_item.json (Roo) for token summary if still no tokens
      if (!hasTokens && !hasCost) {
        try {
          const hist = readJson(path.join(td, 'history_item.json')) as Record<string, unknown> | null;
          if (hist) {
            const inp = Number(hist['tokensIn'] ?? NaN);
            const out = Number(hist['tokensOut'] ?? NaN);
            const tc  = Number(hist['totalCost'] ?? NaN);
            if (!isNaN(inp) && inp > 0) { inputTokens = inp; outputTokens = isNaN(out) ? 0 : out; hasTokens = true; }
            if (!isNaN(tc) && tc > 0)   { hasCost = true; costUSD = tc; }
          }
        } catch { /* ignore */ }
      }

      if (!lastTs) {
        try { lastTs = fs.statSync(td).mtimeMs; } catch { lastTs = 0; }
      }

      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      if (!hasCost) {
        costUSD = calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
      }

      sessions.push({
        tool: toolName,
        model: model || 'unknown',
        sessionId: path.basename(td).slice(0, 8),
        projectPath: td,
        projectName: path.basename(td).slice(0, 12),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        costUSD,
        tokenSource: hasTokens ? 'log_file' : 'estimate',
        sessionDate: toDateStr(lastTs),
        sessionTimestamp: lastTs,
        turnCount,
        sentToServer: 0,
      });
    } catch (err) {
      logError(toolName, `Failed to process task dir ${td}`, err);
      errors++;
      skipped++;
    }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}

export function loadCline(): AdapterResult {
  return loadClineFamily(PATHS.clineTasks, 'cline');
}
