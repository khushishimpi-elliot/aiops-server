import fs from 'fs';
import path from 'path';
import { SessionRecord, AdapterResult, EMPTY_RESULT } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { calcCost } from '../core/pricing.js';
import { logError } from '../core/logger.js';

function toolExists(): boolean {
  try { return fs.existsSync(PATHS.claude); }
  catch { return false; }
}

function readJsonl(file: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(file, 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as Record<string, unknown>[];
  } catch (err) {
    logError('claude', `readJsonl failed: ${file}`, err);
    return [];
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

const SKIP_PATH_PARTS = new Set(['users', 'home', 'desktop', 'documents', 'projects', 'code', 'dev', 'work', 'src', 'repos']);

function decodeProjectName(folderName: string): string {
  // Claude encodes project paths by replacing / with -
  // e.g. -Users-shrushtikadam-Desktop-myapp → myapp
  const parts = folderName.replace(/^-+/, '').split('-').filter(Boolean);
  const meaningful: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase();
    if (SKIP_PATH_PARTS.has(p)) break;
    meaningful.unshift(parts[i]);
    if (meaningful.length >= 3) break;
  }
  return meaningful.join('-') || folderName.slice(0, 14);
}

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
      logError('claude', `walkJsonl: cannot read directory ${d}`, err);
    }
  }
  recurse(dir);
  return out;
}

function parseTokens(u: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  return {
    input:      Number(u['input_tokens']                ?? u['inputTokens']          ?? u['promptTokenCount']      ?? 0),
    output:     Number(u['output_tokens']               ?? u['outputTokens']         ?? u['candidatesTokenCount']  ?? 0),
    cacheRead:  Number(u['cache_read_input_tokens']     ?? u['cacheReadTokens']      ?? 0),
    cacheWrite: Number(u['cache_creation_input_tokens'] ?? u['cacheWriteTokens']     ?? 0),
  };
}

export function loadClaude(): AdapterResult {
  if (!toolExists()) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors  = 0;

  let files: string[] = [];
  try { files = walkJsonl(PATHS.claude); }
  catch (err) { logError('claude', 'walkJsonl top-level failed', err); return EMPTY_RESULT; }

  for (const file of files) {
    try {
      const lines = readJsonl(file);
      if (!lines.length) { skipped++; continue; }

      let model = '';
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
      let turnCount = 0, userTurnCount = 0, firstTs = 0, lastTs = 0;
      let hasUsage = false;
      let firstPrompt = '';

      for (const e of lines) {
        try {
          const ts = toTimestamp(e['timestamp']);
          if (ts) {
            if (!firstTs || ts < firstTs) firstTs = ts;
            if (!lastTs  || ts > lastTs)  lastTs  = ts;
          }
          if (e['type'] === 'human' || e['type'] === 'user') {
            userTurnCount++;
            if (!firstPrompt) {
              const msg = (e['message'] ?? e) as Record<string, unknown>;
              const content = msg['content'] ?? e['content'];
              if (typeof content === 'string') firstPrompt = content.slice(0, 120);
              else if (Array.isArray(content)) {
                const textBlock = (content as Record<string, unknown>[]).find(b => b['type'] === 'text');
                if (textBlock) firstPrompt = String(textBlock['text'] ?? '').slice(0, 120);
              }
            }
          }
          if (e['type'] === 'assistant') {
            turnCount++;
            const msg = (e['message'] ?? e) as Record<string, unknown>;
            if (!model && msg['model']) model = String(msg['model']);
            const u = msg['usage'] as Record<string, unknown> | undefined;
            if (u) {
              hasUsage = true;
              const t = parseTokens(u);
              inputTokens      += t.input;
              outputTokens     += t.output;
              cacheReadTokens  += t.cacheRead;
              cacheWriteTokens += t.cacheWrite;
            }
          }
        } catch (err) {
          logError('claude', `Error parsing line in ${file}`, err);
          errors++;
        }
      }

      if (!hasUsage) {
        const totalChars = lines.map(e => JSON.stringify(e)).join('').length;
        inputTokens  = Math.round(totalChars * 0.6 / 4);
        outputTokens = Math.round(totalChars * 0.4 / 4);
      }

      const projectHash = path.basename(path.dirname(file));
      sessions.push({
        tool: 'claude',
        model: model || 'unknown',
        sessionId: path.basename(file, '.jsonl').slice(0, 8),
        projectPath: projectHash,
        projectName: decodeProjectName(projectHash),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        costUSD: calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
        tokenSource: hasUsage ? 'log_file' : 'estimate',
        sessionDate: toDateStr(lastTs || firstTs),
        sessionTimestamp: firstTs || lastTs,
        sessionEndTimestamp: lastTs || firstTs,
        turnCount,
        userTurnCount,
        firstPrompt: firstPrompt || undefined,
        sentToServer: 0,
      });
    } catch (err) {
      logError('claude', `Failed to process file ${file}`, err);
      errors++;
      skipped++;
    }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}
