import fs from 'fs';
import path from 'path';
import { SessionRecord, AdapterResult, EMPTY_RESULT } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { calcCost } from '../core/pricing.js';
import { logError } from '../core/logger.js';

// Pi agent stores sessions as JSONL files nested by project directory:
//   ~/.pi/agent/sessions/--project-path--/TIMESTAMP_id.jsonl
// Each file is one conversation session. Format:
//   session        — id, version, timestamp, cwd
//   model_change   — provider, modelId (e.g. "claude-opus-4-7")
//   message        — role: user | assistant
//                    assistant messages include usage:
//                    { input, output, cacheRead, cacheWrite, totalTokens,
//                      cost: { input, output, cacheRead, cacheWrite, total } }

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  function recurse(d: string, depth = 0): void {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) recurse(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
      }
    } catch (err) {
      logError('pi', `Cannot read directory ${d}`, err);
    }
  }
  recurse(dir);
  return out;
}

function readLines(file: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(file, 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as Record<string, unknown>[];
  } catch (err) {
    logError('pi', `readLines failed: ${file}`, err);
    return [];
  }
}

function toDateStr(ts: unknown): string {
  if (!ts) return '';
  try { return new Date(String(ts)).toISOString().slice(0, 10); } catch { return ''; }
}

function toTimestamp(ts: unknown): number {
  if (!ts) return 0;
  try { return new Date(String(ts)).getTime(); } catch { return 0; }
}

// Pi encodes project path in directory name as --path-parts--
function decodePiProjectName(dirName: string): string {
  if (!dirName) return 'pi';
  // e.g. "--Users-shrushtikadam-Desktop--" → "Desktop"
  const parts = dirName.replace(/^-+|-+$/g, '').split('-').filter(Boolean);
  const skip = new Set(['users', 'home', 'desktop', 'documents', 'projects', 'code', 'dev', 'work']);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!skip.has(parts[i].toLowerCase())) return parts[i].slice(0, 20);
  }
  return parts[parts.length - 1]?.slice(0, 20) || 'pi';
}

export function loadPi(): AdapterResult {
  if (!fs.existsSync(PATHS.pi)) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors = 0;

  const files = walkJsonl(PATHS.pi);

  for (const file of files) {
    try {
      const lines = readLines(file);
      if (!lines.length) { skipped++; continue; }

      let sessionId = path.basename(file, '.jsonl').slice(0, 8);
      let firstTs = 0;
      let cwd = '';
      let model = '';
      let userTurnCount = 0;
      let turnCount = 0;
      let firstPrompt = '';
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
      let totalCostUSD = 0;
      let hasCost = false;
      let hasTokens = false;

      for (const obj of lines) {
        const type = String(obj['type'] ?? '');

        if (type === 'session') {
          sessionId = String(obj['id'] ?? sessionId).slice(0, 8);
          cwd = String(obj['cwd'] ?? '');
          if (!firstTs) firstTs = toTimestamp(obj['timestamp']);
        }

        if (type === 'model_change') {
          if (!model) {
            const modelId = String(obj['modelId'] ?? '');
            if (modelId) model = modelId;
          }
        }

        if (type === 'message') {
          const msg = (obj['message'] ?? {}) as Record<string, unknown>;
          const role = String(msg['role'] ?? '');

          if (role === 'user') {
            userTurnCount++;
            if (!firstPrompt) {
              const content = msg['content'];
              if (typeof content === 'string') firstPrompt = content.slice(0, 120);
              else if (Array.isArray(content)) {
                const textBlock = (content as Record<string, unknown>[]).find(b => b['type'] === 'text');
                if (textBlock) firstPrompt = String(textBlock['text'] ?? '').slice(0, 120);
              }
            }
          }

          if (role === 'assistant') {
            turnCount++;
            if (!model && msg['model']) model = String(msg['model']);

            const usage = msg['usage'] as Record<string, unknown> | undefined;
            if (usage) {
              const inp  = Number(usage['input']       ?? 0);
              const out  = Number(usage['output']      ?? 0);
              const cr   = Number(usage['cacheRead']   ?? 0);
              const cw   = Number(usage['cacheWrite']  ?? 0);
              inputTokens      += inp;
              outputTokens     += out;
              cacheReadTokens  += cr;
              cacheWriteTokens += cw;
              if (inp > 0 || out > 0) hasTokens = true;

              const costObj = usage['cost'] as Record<string, unknown> | undefined;
              if (costObj) {
                const tc = Number(costObj['total'] ?? NaN);
                if (!isNaN(tc) && tc > 0) { totalCostUSD += tc; hasCost = true; }
              }
            }
          }
        }
      }

      if (!firstTs) {
        try { firstTs = fs.statSync(file).mtimeMs; } catch { firstTs = 0; }
      }

      if (userTurnCount === 0 && turnCount === 0) { skipped++; continue; }

      // Fall back to pricing calc if Pi didn't log cost
      const projectDir = path.basename(path.dirname(file));
      const computedCost = hasCost
        ? totalCostUSD
        : calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

      sessions.push({
        tool: 'pi',
        model: model || 'unknown',
        sessionId,
        projectPath: cwd || file,
        projectName: decodePiProjectName(projectDir),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        costUSD: computedCost,
        tokenSource: hasTokens ? 'log_file' : 'estimate',
        sessionDate: toDateStr(firstTs),
        sessionTimestamp: firstTs,
        turnCount,
        userTurnCount,
        firstPrompt: firstPrompt || undefined,
        sentToServer: 0,
      });
    } catch (err) {
      logError('pi', `Failed to process ${file}`, err);
      errors++;
      skipped++;
    }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}
