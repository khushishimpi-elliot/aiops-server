import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { SessionRecord, AdapterResult, EMPTY_RESULT } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { calcCost } from '../core/pricing.js';
import { countByTiktoken, estimateByChars } from '../core/tokenizer.js';
import { logError } from '../core/logger.js';

const _require = createRequire(import.meta.url);

// GitHub Copilot Chat stores conversations per VS Code workspace:
//   {workspaceStorage}/<workspaceHash>/chatSessions/<sessionId>.json
// Each file is a single chat session (Copilot Chat panel or inline).
// Token counts are NOT recorded — we estimate via gpt-tokenizer/chars.
// We only count sessions whose agent extensionId is github.copilot-chat
// so VS Code's own non-Copilot chat (e.g. user-installed chat extensions) is ignored.

interface CopilotRequest {
  message?: { text?: string; parts?: unknown };
  response?: unknown;
  agent?: { extensionId?: { value?: string }; id?: string };
  timestamp?: number;
  modelId?: string;
  result?: { details?: string; metadata?: Record<string, unknown> };
}

interface CopilotSessionFile {
  sessionId?: string;
  responderUsername?: string;
  initialLocation?: string;
  creationDate?: number;
  lastMessageDate?: number;
  requests?: CopilotRequest[];
}

function readJson(file: string): CopilotSessionFile | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as CopilotSessionFile; }
  catch (err) {
    logError('copilot', `readJson failed: ${file}`, err);
    return null;
  }
}

function listChatSessionFiles(workspaceStorageRoot: string): string[] {
  if (!fs.existsSync(workspaceStorageRoot)) return [];
  const out: string[] = [];
  let workspaceDirs: fs.Dirent[] = [];
  try {
    workspaceDirs = fs.readdirSync(workspaceStorageRoot, { withFileTypes: true })
      .filter(e => e.isDirectory());
  } catch (err) {
    logError('copilot', `Cannot read workspaceStorage: ${workspaceStorageRoot}`, err);
    return [];
  }
  for (const wd of workspaceDirs) {
    const csDir = path.join(workspaceStorageRoot, wd.name, 'chatSessions');
    if (!fs.existsSync(csDir)) continue;
    try {
      for (const e of fs.readdirSync(csDir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.json')) out.push(path.join(csDir, e.name));
      }
    } catch (err) {
      logError('copilot', `Cannot read chatSessions dir ${csDir}`, err);
    }
  }
  return out;
}

function extractResponseText(response: unknown): string {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (!Array.isArray(response)) return '';
  const parts: string[] = [];
  for (const chunk of response as Array<Record<string, unknown>>) {
    const v = chunk['value'];
    if (typeof v === 'string') parts.push(v);
    else if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
      const inner = (v as Record<string, unknown>)['value'];
      if (typeof inner === 'string') parts.push(inner);
    }
  }
  return parts.join(' ');
}

// Copilot exposes a human-readable model label in `result.details`, e.g.
//   "GPT-5 mini • 1x", "Claude Sonnet 4.5", "GPT-4o".
// We map those to canonical IDs that the existing pricing regexes already match.
function canonicalModel(detailsRaw: string | undefined, modelId: string | undefined): string {
  const details = (detailsRaw ?? '').toLowerCase();
  const id      = (modelId    ?? '').toLowerCase();
  const blob    = details + ' ' + id;

  if (/claude.*opus.*4/.test(blob))              return 'claude-opus-4';
  if (/claude.*sonnet.*4/.test(blob))            return 'claude-sonnet-4';
  if (/claude.*haiku.*4/.test(blob))             return 'claude-haiku-4';
  if (/claude.*3\.7.*sonnet/.test(blob))         return 'claude-3-7-sonnet';
  if (/claude.*3\.5.*sonnet/.test(blob))         return 'claude-3-5-sonnet';
  if (/claude.*3\.5.*haiku/.test(blob))          return 'claude-3-5-haiku';
  if (/gpt-?5.*(mini|nano)/.test(blob))          return 'gpt-4.1-mini'; // closest priced equivalent
  if (/gpt-?5/.test(blob))                       return 'gpt-4.1';
  if (/gpt-?4\.1.*nano/.test(blob))              return 'gpt-4.1-nano';
  if (/gpt-?4\.1.*mini/.test(blob))              return 'gpt-4.1-mini';
  if (/gpt-?4\.1/.test(blob))                    return 'gpt-4.1';
  if (/gpt-?4o.*mini/.test(blob))                return 'gpt-4o-mini';
  if (/gpt-?4o/.test(blob))                      return 'gpt-4o';
  if (/o4-?mini/.test(blob))                     return 'o4-mini';
  if (/o3-?mini/.test(blob))                     return 'o3-mini';
  if (/o1/.test(blob))                           return 'o1';
  if (/gemini.*2\.5.*pro/.test(blob))            return 'gemini-2.5-pro';
  if (/gemini.*2\.5.*flash/.test(blob))          return 'gemini-2.5-flash';
  if (/gemini.*2\.0.*flash/.test(blob))          return 'gemini-2.0-flash';
  if (/gemini/.test(blob))                       return 'gemini-2.0-flash';

  // copilot/auto and other unknowns: keep raw so report shows it but pricing falls back
  if (detailsRaw)   return detailsRaw.replace(/\s*•.*$/, '').trim() || 'copilot-unknown';
  if (modelId)      return modelId;
  return 'copilot-unknown';
}

// Pull a project name from the first cwd or file path mentioned in renderedUserMessage,
// because Copilot only stores an opaque workspace hash on disk.
function inferProjectName(req: CopilotRequest | undefined, fallback: string): string {
  const meta = req?.result?.metadata;
  if (meta && typeof meta === 'object') {
    const rendered = (meta as Record<string, unknown>)['renderedUserMessage'];
    if (Array.isArray(rendered)) {
      for (const block of rendered as Array<Record<string, unknown>>) {
        const text = typeof block['text'] === 'string' ? (block['text'] as string) : '';
        const cwdMatch = text.match(/Cwd:\s*([^\r\n]+)/i);
        if (cwdMatch && cwdMatch[1]) {
          return path.basename(cwdMatch[1].trim()).slice(0, 20);
        }
        const fileMatch = text.match(/[A-Za-z]:[\\/](?:[^\s"'<>]+[\\/])+([^\s"'<>\\/]+)/);
        if (fileMatch) {
          // walk up to a sensible project root segment
          const parts = fileMatch[0].split(/[\\/]+/);
          // Heuristic: take 2 levels up from the filename
          const projIdx = Math.max(0, parts.length - 3);
          return (parts[projIdx] || fallback).slice(0, 20);
        }
      }
    }
  }
  return fallback.slice(0, 20);
}

function tokensFromText(text: string): number {
  if (!text) return 0;
  try {
    const n = countByTiktoken(text);
    return n > 0 ? n : estimateByChars(text);
  } catch { return estimateByChars(text); }
}

// ─── STATE.VSCDB FALLBACK ────────────────────────────────────────────────────
// VS Code 1.100+ no longer writes request data into chatSessions/*.json files.
// Non-empty sessions are only tracked in state.vscdb (workspace or global).
// This function reads chat.ChatSessionStore.index from a given state.vscdb and
// returns session records for any entry where isEmpty === false.

interface StateDbIndexEntry {
  sessionId: string;
  title?: string;
  lastMessageDate?: number;
  timing?: { created?: number; lastRequestStarted?: number; lastRequestEnded?: number };
  isEmpty?: boolean;
  initialLocation?: string;
}

function readCopilotSessionsFromStateDb(dbPath: string, defaultModel: string): SessionRecord[] {
  if (!fs.existsSync(dbPath)) return [];
  let Database: unknown = null;
  try { Database = _require('better-sqlite3'); } catch { return []; }
  if (!Database) return [];

  const out: SessionRecord[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new (Database as any)(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(`SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'`).get() as
        | { value: string } | undefined;
      if (!row) { db.close(); return []; }

      const idx = JSON.parse(row.value) as { entries?: Record<string, StateDbIndexEntry> };
      const entries = idx.entries ?? {};

      // Also try to read current model from same DB
      let model = defaultModel;
      try {
        const mRow = db.prepare(`SELECT value FROM ItemTable WHERE key = 'chat.currentLanguageModel.panel'`).get() as
          | { value: string } | undefined;
        if (mRow?.value) model = canonicalModel(undefined, mRow.value.replace(/^"|"$/g, ''));
      } catch { /* ignore */ }

      for (const [, entry] of Object.entries(entries)) {
        if (entry.isEmpty !== false) continue;

        const created  = entry.timing?.created ?? entry.lastMessageDate ?? 0;
        const endTs    = entry.timing?.lastRequestEnded ?? entry.lastMessageDate ?? created;
        const dateStr  = created ? new Date(created).toISOString().slice(0, 10) : '';

        out.push({
          tool:             'copilot',
          model,
          sessionId:        entry.sessionId.slice(0, 36),
          projectPath:      dbPath,
          projectName:      'copilot',
          inputTokens:      0,
          outputTokens:     0,
          cacheReadTokens:  0,
          cacheWriteTokens: 0,
          totalTokens:      0,
          costUSD:          0,
          tokenSource:      'estimate',
          sessionDate:      dateStr,
          sessionTimestamp: created,
          sessionEndTimestamp: endTs || undefined,
          turnCount:        1,
          userTurnCount:    1,
          firstPrompt:      entry.title || undefined,
          sentToServer:     0,
        });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logError('copilot', `readCopilotSessionsFromStateDb failed: ${dbPath}`, err);
  }
  return out;
}

// Collect all state.vscdb paths relevant to Copilot:
// 1. Global VS Code state.vscdb (stores global/panel sessions in VS Code 1.100+)
// 2. Each workspace's state.vscdb (stores workspace-scoped sessions)
function listStateDbs(workspaceStorageRoot: string): string[] {
  const dbs: string[] = [];
  // Global state.vscdb lives one level up from globalStorage/github.copilot-chat
  const globalStateDb = path.join(path.dirname(PATHS.copilotGlobalStorage), 'state.vscdb');
  if (fs.existsSync(globalStateDb)) dbs.push(globalStateDb);

  if (!fs.existsSync(workspaceStorageRoot)) return dbs;
  try {
    for (const wd of fs.readdirSync(workspaceStorageRoot, { withFileTypes: true })) {
      if (!wd.isDirectory()) continue;
      const dbPath = path.join(workspaceStorageRoot, wd.name, 'state.vscdb');
      if (fs.existsSync(dbPath)) dbs.push(dbPath);
    }
  } catch (err) {
    logError('copilot', `listStateDbs: cannot read workspaceStorage`, err);
  }
  return dbs;
}

export function loadCopilot(): AdapterResult {
  const root = PATHS.copilotWorkspaceStorage;
  if (!fs.existsSync(root) && !fs.existsSync(path.dirname(PATHS.copilotGlobalStorage))) return EMPTY_RESULT;

  const files = listChatSessionFiles(root);
  if (!files.length) return EMPTY_RESULT;

  const sessions: SessionRecord[] = [];
  let skipped = 0;
  let errors  = 0;

  for (const file of files) {
    try {
      const data = readJson(file);
      if (!data || !Array.isArray(data.requests) || data.requests.length === 0) {
        skipped++;
        continue;
      }

      // Confirm at least one request was actually GitHub Copilot Chat — otherwise this
      // file belongs to a different VS Code chat provider and should be ignored.
      const copilotRequests = data.requests.filter(r => {
        const ext = r?.agent?.extensionId?.value ?? '';
        return /github\.copilot/i.test(ext);
      });
      if (copilotRequests.length === 0) { skipped++; continue; }

      let inputTokens = 0;
      let outputTokens = 0;
      let modelDetails = '';
      let modelIdRaw = '';
      let firstPrompt = '';
      let firstTs = 0;
      let lastTs = 0;
      let turnCount = 0;

      for (const r of copilotRequests) {
        try {
          const userText = String(r.message?.text ?? '');
          const respText = extractResponseText(r.response);

          inputTokens  += tokensFromText(userText);
          outputTokens += tokensFromText(respText);

          if (!modelDetails && r.result?.details) modelDetails = r.result.details;
          if (!modelIdRaw   && r.modelId)         modelIdRaw   = r.modelId;
          if (!firstPrompt  && userText)          firstPrompt  = userText.slice(0, 120);

          const ts = Number(r.timestamp ?? 0);
          if (ts > 0) {
            if (!firstTs || ts < firstTs) firstTs = ts;
            if (ts > lastTs) lastTs = ts;
          }
          turnCount++;
        } catch (err) {
          logError('copilot', `Failed to parse request in ${file}`, err);
          errors++;
        }
      }

      if (!firstTs) firstTs = Number(data.creationDate ?? 0);
      if (!lastTs)  lastTs  = Number(data.lastMessageDate ?? firstTs);
      if (!firstTs) {
        try { firstTs = fs.statSync(file).mtimeMs; lastTs = firstTs; } catch { /* ignore */ }
      }

      const model = canonicalModel(modelDetails, modelIdRaw);
      const totalTokens = inputTokens + outputTokens;
      const costUSD = calcCost(model, inputTokens, outputTokens);

      const sessionId = String(data.sessionId ?? path.basename(file, '.json')).slice(0, 8);
      const workspaceHash = path.basename(path.dirname(path.dirname(file)));

      sessions.push({
        tool: 'copilot',
        model,
        sessionId,
        projectPath: file,
        projectName: inferProjectName(copilotRequests[0], workspaceHash),
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens,
        costUSD,
        tokenSource: 'tiktoken',
        sessionDate: firstTs ? new Date(firstTs).toISOString().slice(0, 10) : '',
        sessionTimestamp: firstTs,
        sessionEndTimestamp: lastTs || undefined,
        turnCount,
        userTurnCount: turnCount,
        firstPrompt: firstPrompt || undefined,
        sentToServer: 0,
      });
    } catch (err) {
      logError('copilot', `Failed to process ${file}`, err);
      errors++;
      skipped++;
    }
  }

  // ── FALLBACK: read sessions from state.vscdb (VS Code 1.100+) ───────────────
  // These cover sessions whose chatSessions/*.json file has an empty requests[].
  const seenIds = new Set(sessions.map(s => s.sessionId));
  const stateDbs = listStateDbs(root);
  for (const dbPath of stateDbs) {
    try {
      const dbSessions = readCopilotSessionsFromStateDb(dbPath, 'copilot/auto');
      for (const s of dbSessions) {
        if (!seenIds.has(s.sessionId)) {
          seenIds.add(s.sessionId);
          sessions.push(s);
        }
      }
    } catch (err) {
      logError('copilot', `state.vscdb scan failed: ${dbPath}`, err);
    }
  }

  return { sessions, stats: { processed: sessions.length, skipped, errors } };
}
