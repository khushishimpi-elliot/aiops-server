import fs from 'fs';
import path from 'path';
import { SessionRecord, AdapterResult, EMPTY_RESULT } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { calcCost } from '../core/pricing.js';
import { logError } from '../core/logger.js';

function toolExists(): boolean {
  try {
    return fs.existsSync(PATHS.geminiTmp) || fs.existsSync(PATHS.geminiAntigravity);
  } catch { return false; }
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
    logError('gemini', `readJsonl failed: ${file}`, err);
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
      logError('gemini', `Cannot read directory ${d}`, err);
    }
  }
  recurse(dir);
  return out;
}

export function loadGemini(): AdapterResult {
  if (!toolExists()) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors  = 0;

  let files: string[] = [];
  try { files = walkJsonl(PATHS.geminiTmp); }
  catch (err) { logError('gemini', 'walkJsonl failed', err); return EMPTY_RESULT; }

  for (const file of files) {
    try {
      const lines = readJsonl(file);
      if (!lines.length) { skipped++; continue; }

      let model = '';
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
      let turnCount = 0, firstTs = 0, lastTs = 0;
      let hasUsage = false;

      for (const e of lines) {
        try {
          const ts = toTimestamp(e['timestamp'] ?? e['created_at'] ?? e['ts']);
          if (ts) {
            if (!firstTs || ts < firstTs) firstTs = ts;
            if (!lastTs  || ts > lastTs)  lastTs  = ts;
          }

          if (!model) {
            const m = e['modelVersion'] ?? e['model'] ?? '';
            if (m) model = String(m);
          }

          const role = String(e['role'] ?? e['type'] ?? '');
          if (role === 'assistant' || role === 'model') turnCount++;

          const meta = e['usageMetadata'] as Record<string, unknown> | undefined;
          if (meta) {
            hasUsage = true;
            // Defensive: check multiple field names
            inputTokens     += Number(meta['promptTokenCount']        ?? meta['input_tokens']  ?? meta['inputTokens']  ?? 0);
            outputTokens    += Number(meta['candidatesTokenCount']    ?? meta['output_tokens'] ?? meta['outputTokens'] ?? 0);
            cacheReadTokens += Number(meta['cachedContentTokenCount'] ?? meta['cacheReads']    ?? 0);
          }
        } catch (err) {
          logError('gemini', `Error parsing line in ${file}`, err);
          errors++;
        }
      }

      if (!hasUsage) {
        const totalChars = lines.map(e => JSON.stringify(e)).join('').length;
        inputTokens  = Math.round(totalChars * 0.6 / 4);
        outputTokens = Math.round(totalChars * 0.4 / 4);
      }

      sessions.push({
        tool: 'gemini',
        model: model || 'unknown',
        sessionId: path.basename(file, '.jsonl').slice(0, 8),
        projectPath: path.dirname(file),
        projectName: path.basename(path.dirname(file)).slice(0, 12),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens + cacheReadTokens,
        costUSD: calcCost(model, inputTokens, outputTokens, cacheReadTokens, 0),
        tokenSource: hasUsage ? 'log_file' : 'estimate',
        sessionDate: toDateStr(lastTs || firstTs),
        sessionTimestamp: lastTs || firstTs,
        turnCount,
        sentToServer: 0,
      });
    } catch (err) {
      logError('gemini', `Failed to process file ${file}`, err);
      errors++;
      skipped++;
    }
  }

  // Also load antigravity sessions (.pb files — binary protobuf, can't parse tokens)
  if (fs.existsSync(PATHS.geminiAntigravity)) {
    try {
      const pbFiles = fs.readdirSync(PATHS.geminiAntigravity, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.pb'))
        .map(e => path.join(PATHS.geminiAntigravity, e.name));

      for (const f of pbFiles) {
        try {
          const stat = fs.statSync(f);
          const sizeBytes = stat.size;
          // Rough token estimate: protobuf-encoded text averages ~5 bytes/token
          const estTokens = Math.round(sizeBytes / 5);
          const estInput  = Math.round(estTokens * 0.6);
          const estOutput = Math.round(estTokens * 0.4);
          sessions.push({
            tool: 'gemini',
            model: 'gemini-antigravity',
            sessionId: path.basename(f, '.pb').slice(0, 8),
            projectPath: PATHS.geminiAntigravity,
            projectName: 'antigravity',
            inputTokens: estInput,
            outputTokens: estOutput,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: estTokens,
            costUSD: calcCost('gemini-2.0-flash', estInput, estOutput, 0, 0),
            tokenSource: 'estimate',
            sessionDate: toDateStr(stat.mtimeMs),
            sessionTimestamp: stat.mtimeMs,
            turnCount: 0,
            sentToServer: 0,
          });
        } catch (err) {
          logError('gemini', `Failed to stat antigravity file ${f}`, err);
          errors++;
        }
      }
    } catch (err) {
      logError('gemini', 'Failed to read antigravity directory', err);
    }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}
