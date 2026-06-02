import fs from 'fs';
import path from 'path';
import { SessionRecord, AdapterResult, EMPTY_RESULT } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { calcCost } from '../core/pricing.js';
import { estimateByChars } from '../core/tokenizer.js';
import { logError } from '../core/logger.js';

// Codex CLI stores sessions as JSONL files nested by date:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
// Each file is one task/session. Format uses typed event lines:
//   session_meta  — id, cwd, model_provider, cli_version
//   event_msg     — subtypes: task_started, user_message, task_complete
//   response_item — role: developer | user | assistant, content array
//   turn_context  — cwd snapshot per turn
// Token counts are NOT stored — estimated from content text.

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  function recurse(d: string, depth = 0): void {
    if (depth > 5) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) recurse(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
      }
    } catch (err) {
      logError('codex', `Cannot read directory ${d}`, err);
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
    logError('codex', `readLines failed: ${file}`, err);
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

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Record<string, unknown>[])
    .filter(b => b['type'] === 'text' || b['type'] === 'input_text' || b['type'] === 'output_text')
    .map(b => String(b['text'] ?? ''))
    .join(' ');
}

function cwdToProjectName(cwd: string): string {
  if (!cwd) return 'codex';
  return path.basename(cwd).slice(0, 20) || 'codex';
}

export function loadCodex(): AdapterResult {
  if (!fs.existsSync(PATHS.codexSessions)) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors = 0;

  const files = walkJsonl(PATHS.codexSessions);

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
      let allText = '';

      for (const obj of lines) {
        const type = String(obj['type'] ?? '');
        const payload = (obj['payload'] ?? obj) as Record<string, unknown>;

        if (type === 'session_meta') {
          sessionId = String(payload['id'] ?? sessionId).slice(0, 8);
          cwd = String(payload['cwd'] ?? '');
          if (!firstTs) firstTs = toTimestamp(payload['timestamp'] ?? obj['timestamp']);
        }

        if (type === 'turn_context') {
          if (!model && payload['model']) model = String(payload['model']);
        }

        if (type === 'event_msg') {
          const subtype = String(payload['type'] ?? '');
          if (subtype === 'user_message') {
            userTurnCount++;
            const msg = String(payload['message'] ?? '');
            if (!firstPrompt && msg) firstPrompt = msg.slice(0, 120);
            allText += ' ' + msg;
          }
        }

        if (type === 'response_item') {
          const role = String(payload['role'] ?? '');
          const content = payload['content'];
          const text = extractText(content);
          // Codex uses 'developer' role for assistant responses
          if (role === 'assistant' || role === 'developer') turnCount++;
          allText += ' ' + text;
        }
      }

      if (!model) model = 'o4-mini';

      if (!firstTs) {
        try { firstTs = fs.statSync(file).mtimeMs; } catch { firstTs = 0; }
      }

      // Estimate tokens from all text in the file
      const totalChars = allText.length;
      const inputTokens  = Math.round(estimateByChars(allText) * 0.6);
      const outputTokens = Math.round(estimateByChars(allText) * 0.4);

      if (userTurnCount === 0 && totalChars < 100) { skipped++; continue; }

      sessions.push({
        tool: 'codex',
        model,
        sessionId,
        projectPath: cwd || file,
        projectName: cwdToProjectName(cwd),
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens,
        costUSD: calcCost(model, inputTokens, outputTokens),
        tokenSource: 'estimate',
        sessionDate: toDateStr(firstTs),
        sessionTimestamp: firstTs,
        turnCount: turnCount || userTurnCount,
        userTurnCount,
        firstPrompt: firstPrompt || undefined,
        sentToServer: 0,
      });
    } catch (err) {
      logError('codex', `Failed to process ${file}`, err);
      errors++;
      skipped++;
    }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}
