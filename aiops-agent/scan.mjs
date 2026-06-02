#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createRequire } from 'module';

// Try to load better-sqlite3 (available after npm install, needs native build)
const _require = createRequire(import.meta.url);
let Database = null;
try { Database = _require('better-sqlite3'); } catch { /* optional — sqlite3 CLI used as fallback */ }

const HOME = os.homedir();
const NOW = Date.now();
const DAYS_28 = 28 * 86_400_000;
const DAYS_30 = 30 * 86_400_000;
const CUTOFF_28 = NOW - DAYS_28;
const CUTOFF_30 = NOW - DAYS_30;
const IS_WIN   = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const APPDATA  = process.env['APPDATA'] || process.env['LOCALAPPDATA'] || '';

// ─── PRICING ────────────────────────────────────────────────────────────────
const PRICING = [
  { pattern: /claude-opus-4/,       input: 5.00,   output: 25.00,  cacheRead: 0.50,  cacheWrite: 6.25  },
  { pattern: /claude-sonnet-4/,     input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  },
  { pattern: /claude-haiku-4/,      input: 1.00,   output: 5.00,   cacheRead: 0.10,  cacheWrite: 1.25  },
  { pattern: /claude-3-5-sonnet/,   input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  },
  { pattern: /claude-3-5-haiku/,    input: 0.80,   output: 4.00,   cacheRead: 0.08,  cacheWrite: 1.00  },
  { pattern: /claude-3-opus/,       input: 15.00,  output: 75.00,  cacheRead: 1.50,  cacheWrite: 18.75 },
  { pattern: /claude-3-sonnet/,     input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  },
  { pattern: /claude-3-haiku/,      input: 0.25,   output: 1.25,   cacheRead: 0.03,  cacheWrite: 0.30  },
  { pattern: /gemini-2\.0-flash/,   input: 0.075,  output: 0.30,   cacheRead: 0,     cacheWrite: 0     },
  { pattern: /gemini-1\.5-flash/,   input: 0.075,  output: 0.30,   cacheRead: 0,     cacheWrite: 0     },
  { pattern: /gemini-1\.5-pro/,     input: 1.25,   output: 5.00,   cacheRead: 0,     cacheWrite: 0     },
  { pattern: /gpt-4o/,              input: 2.50,   output: 10.00,  cacheRead: 0,     cacheWrite: 0     },
  { pattern: /gpt-4-turbo/,         input: 10.00,  output: 30.00,  cacheRead: 0,     cacheWrite: 0     },
];
const DEFAULT_PRICE = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 };

function getPrice(model) {
  if (!model) return DEFAULT_PRICE;
  const m = model.toLowerCase();
  for (const p of PRICING) if (p.pattern.test(m)) return p;
  return DEFAULT_PRICE;
}

function calcCost(model, inputTok, outputTok, cacheReadTok = 0, cacheWriteTok = 0) {
  const p = getPrice(model);
  return (inputTok / 1e6) * p.input
       + (outputTok / 1e6) * p.output
       + (cacheReadTok / 1e6) * p.cacheRead
       + (cacheWriteTok / 1e6) * p.cacheWrite;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function recentFiles(dir, cutoffMs) {
  if (!exists(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => path.join(dir, e.name))
      .filter(f => {
        try { return fs.statSync(f).mtimeMs >= cutoffMs; } catch { return false; }
      });
  } catch { return []; }
}

function walkDirs(dir, depth = 0) {
  if (!exists(dir) || depth > 4) return [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) files.push(full);
      else if (e.isDirectory() && depth < 4) files.push(...walkDirs(full, depth + 1));
    }
    return files;
  } catch { return []; }
}

function toDate(ts) {
  if (!ts) return null;
  try {
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function tsMs(ts) {
  if (!ts) return null;
  try {
    const n = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : Number(ts);
    return isNaN(n) ? new Date(ts).getTime() : n;
  } catch { return null; }
}

// ─── PATHS ──────────────────────────────────────────────────────────────────

// VSCode-family apps store user data in different places per OS
const VSCODE_GLOBAL = IS_WIN
  ? path.join(APPDATA, 'Code', 'User', 'globalStorage')
  : IS_LINUX
    ? path.join(HOME, '.config', 'Code', 'User', 'globalStorage')
    : path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');

const CURSOR_DATA = IS_WIN
  ? path.join(APPDATA, 'Cursor', 'User', 'globalStorage')
  : IS_LINUX
    ? path.join(HOME, '.config', 'Cursor', 'User', 'globalStorage')
    : path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');

const WINDSURF_DATA = IS_WIN
  ? path.join(APPDATA, 'Windsurf', 'User', 'globalStorage')
  : IS_LINUX
    ? path.join(HOME, '.config', 'Windsurf', 'User', 'globalStorage')
    : path.join(HOME, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage');

const PATHS = {
  // Claude Code stores sessions at ~/.claude on all platforms (not APPDATA on Windows)
  claude_code:  path.join(HOME, '.claude', 'projects'),
  gemini_cli:   IS_WIN ? path.join(APPDATA, 'gemini', 'tmp') : path.join(HOME, '.gemini', 'tmp'),
  codex:        path.join(HOME, '.codex', 'sessions'),
  pi_agent:     path.join(HOME, '.pi', 'agent', 'sessions'),
  omp:          path.join(HOME, '.omp', 'agent', 'sessions'),
  opencode:     IS_WIN ? path.join(APPDATA, 'opencode') : path.join(HOME, '.local', 'share', 'opencode'),
  openclaw:     path.join(HOME, '.openclaw', 'agents'),
  factory:      path.join(HOME, '.factory', 'projects'),
  qwen:         path.join(HOME, '.qwen', 'projects'),
  kimi:         path.join(HOME, '.kimi', 'sessions'),
  amp:          path.join(HOME, '.amp', 'sessions'),
  cline:        path.join(VSCODE_GLOBAL,   'saoudrizwan.claude-dev',      'tasks'),
  roo_code:     path.join(VSCODE_GLOBAL,   'rooveterinaryinc.roo-cline',  'tasks'),
  kilo_code:    path.join(VSCODE_GLOBAL,   'kilocode.kilo-code',          'tasks'),
  cursor_db:    path.join(CURSOR_DATA,     'state.vscdb'),
  windsurf_db:  path.join(WINDSURF_DATA,   'state.vscdb'),
  goose_db:     IS_WIN
    ? path.join(APPDATA, 'goose', 'sessions', 'sessions.db')
    : path.join(HOME, '.local', 'share', 'goose', 'sessions', 'sessions.db'),
};

// ─── PARSERS ─────────────────────────────────────────────────────────────────

// Claude encodes project paths by replacing / (and \ on Windows) with -
// e.g. -Users-shrushtikadam-Desktop-myapp → myapp
function decodeProjectPath(folderName) {
  const SKIP = new Set(['users', 'home', 'desktop', 'documents', 'projects', 'code',
    'dev', 'work', 'src', 'repos', 'c:', 'appdata', 'roaming', 'localappdata']);
  const parts = folderName.replace(/^-+/, '').split('-').filter(Boolean);
  const meaningful = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase();
    if (SKIP.has(p)) break;
    meaningful.unshift(parts[i]);
    if (meaningful.length >= 3) break;
  }
  return meaningful.join('-') || folderName.slice(0, 20);
}

function parseClaudeJsonl(file) {
  const lines = readJsonl(file);
  if (!lines.length) return null;

  let model = null, inputTokens = 0, outputTokens = 0;
  let cacheReadTokens = 0, cacheWriteTokens = 0, turns = 0;
  let firstTs = null, lastTs = null, tokenSource = 'log_file';
  let hasUsage = false;
  const contentParts = [];

  for (const e of lines) {
    const ts = tsMs(e.timestamp);
    if (ts) { if (!firstTs || ts < firstTs) firstTs = ts; if (!lastTs || ts > lastTs) lastTs = ts; }

    if (e.type === 'assistant') {
      turns++;
      const msg = e.message ?? e;
      if (!model && msg.model) model = msg.model;
      const u = msg.usage;
      if (u) {
        hasUsage = true;
        inputTokens      += u.input_tokens         ?? u.inputTokens         ?? 0;
        outputTokens     += u.output_tokens        ?? u.outputTokens        ?? 0;
        cacheReadTokens  += u.cache_read_input_tokens  ?? u.cacheReadTokens  ?? 0;
        cacheWriteTokens += u.cache_creation_input_tokens ?? u.cacheWriteTokens ?? 0;
      }
      // Collect text for estimation fallback
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b.type === 'text' && b.text) contentParts.push(b.text);
      } else if (typeof content === 'string') contentParts.push(content);
    } else if (e.type === 'user') {
      const msg = e.message ?? e;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b.type === 'text' && b.text) contentParts.push(b.text);
      } else if (typeof content === 'string') contentParts.push(content);
    }
  }

  // Rough token estimation if usage data missing (4 chars ≈ 1 token)
  if (!hasUsage && contentParts.length) {
    const totalChars = contentParts.join('').length;
    inputTokens  = Math.round(totalChars * 0.6 / 4);
    outputTokens = Math.round(totalChars * 0.4 / 4);
    tokenSource = 'estimate';
  }

  const sessionId = path.basename(file, '.jsonl');
  const projectFolder = path.basename(path.dirname(file));
  const projectPath = decodeProjectPath(projectFolder);

  return {
    tool: 'claude_code',
    sessionId: sessionId.slice(0, 8),
    model: model ?? 'unknown',
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUSD: calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
    sessionDate: toDate(lastTs ?? firstTs),
    turnCount: turns,
    firstTimestamp: firstTs ? new Date(firstTs).toISOString() : null,
    lastTimestamp:  lastTs  ? new Date(lastTs).toISOString()  : null,
    projectPath,
    tokenSource,
  };
}

function parseGenericJsonl(file, toolName) {
  const lines = readJsonl(file);
  if (!lines.length) return null;

  let model = null, inputTokens = 0, outputTokens = 0, turns = 0;
  let firstTs = null, lastTs = null, hasUsage = false;
  const contentParts = [];

  for (const e of lines) {
    const ts = tsMs(e.timestamp ?? e.created_at ?? e.ts);
    if (ts) { if (!firstTs || ts < firstTs) firstTs = ts; if (!lastTs || ts > lastTs) lastTs = ts; }
    if (!model) model = e.model ?? e.modelId ?? null;

    const role = e.role ?? e.type;
    if (role === 'assistant' || role === 'model') turns++;

    // Usage at various levels
    for (const u of [e.usage, e.usageMetadata, e.token_usage].filter(Boolean)) {
      hasUsage = true;
      inputTokens  += u.input_tokens  ?? u.inputTokens  ?? u.promptTokenCount    ?? 0;
      outputTokens += u.output_tokens ?? u.outputTokens ?? u.candidatesTokenCount ?? 0;
    }

    const content = e.content ?? e.text ?? e.parts?.[0]?.text ?? '';
    if (typeof content === 'string') contentParts.push(content);
  }

  if (!hasUsage && contentParts.length) {
    const totalChars = contentParts.join('').length;
    inputTokens  = Math.round(totalChars * 0.6 / 4);
    outputTokens = Math.round(totalChars * 0.4 / 4);
  }

  const sessionId = path.basename(file, path.extname(file));
  return {
    tool: toolName,
    sessionId: sessionId.slice(0, 8),
    model: model ?? 'unknown',
    inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    costUSD: calcCost(model, inputTokens, outputTokens),
    sessionDate: toDate(lastTs ?? firstTs),
    turnCount: turns,
    firstTimestamp: firstTs ? new Date(firstTs).toISOString() : null,
    lastTimestamp:  lastTs  ? new Date(lastTs).toISOString()  : null,
    projectPath: null,
    tokenSource: hasUsage ? 'log_file' : 'estimate',
  };
}

// Cline / Roo / Kilo — each task is a folder containing api_conversation_history.json
function parseClineTaskDir(taskDir, toolName) {
  const histFile = path.join(taskDir, 'api_conversation_history.json');
  const uiFile   = path.join(taskDir, 'ui_messages.json');
  const hist = readJson(histFile);
  if (!hist) return null;

  let model = null, inputTokens = 0, outputTokens = 0;
  let cacheReadTokens = 0, cacheWriteTokens = 0, turns = 0;
  let firstTs = null, lastTs = null, totalCost = null;

  for (const msg of (Array.isArray(hist) ? hist : [])) {
    const ts = tsMs(msg.ts ?? msg.timestamp);
    if (ts) { if (!firstTs || ts < firstTs) firstTs = ts; if (!lastTs || ts > lastTs) lastTs = ts; }
    if (!model) model = msg.model ?? null;
    if (msg.role === 'assistant') turns++;
    const u = msg.usage;
    if (u) {
      inputTokens      += u.input_tokens  ?? u.tokensIn  ?? 0;
      outputTokens     += u.output_tokens ?? u.tokensOut ?? 0;
      cacheReadTokens  += u.cache_read_input_tokens       ?? u.cacheReads  ?? 0;
      cacheWriteTokens += u.cache_creation_input_tokens   ?? u.cacheWrites ?? 0;
    }
  }

  // Try ui_messages for token/cost summary
  const ui = readJson(uiFile);
  if (Array.isArray(ui)) {
    for (const m of ui) {
      if (m.type === 'say' && m.say === 'api_req_finished' && m.text) {
        try {
          const parsed = JSON.parse(m.text);
          if (!model && parsed.model) model = parsed.model;
          if (parsed.tokensIn)   inputTokens  += parsed.tokensIn;
          if (parsed.tokensOut)  outputTokens += parsed.tokensOut;
          if (parsed.cacheReads) cacheReadTokens  += parsed.cacheReads;
          if (parsed.cacheWrites) cacheWriteTokens += parsed.cacheWrites;
          if (parsed.cost && !totalCost) totalCost = parsed.cost;
        } catch {}
      }
      // Also look for top-level token fields
      if (!model && m.model) model = m.model;
    }
  }

  const sessionId = path.basename(taskDir);
  const dirStat = (() => { try { return fs.statSync(taskDir).mtimeMs; } catch { return null; } })();
  const effectiveTs = lastTs ?? dirStat;

  return {
    tool: toolName,
    sessionId: sessionId.slice(0, 8),
    model: model ?? 'unknown',
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    costUSD: totalCost ?? calcCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
    sessionDate: toDate(effectiveTs),
    turnCount: turns,
    firstTimestamp: firstTs ? new Date(firstTs).toISOString() : null,
    lastTimestamp:  lastTs  ? new Date(lastTs).toISOString()  : null,
    projectPath: null,
    tokenSource: (inputTokens > 0 || outputTokens > 0) ? 'log_file' : 'estimate',
  };
}

// SQLite query — tries better-sqlite3 first (cross-platform), falls back to sqlite3 CLI
function querySqlite(dbPath, sql) {
  if (!exists(dbPath)) return [];

  // Prefer better-sqlite3 npm package (works on Windows/Linux/macOS, no CLI tool needed)
  if (Database) {
    let db = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      return db.prepare(sql).all();
    } catch { return []; }
    finally { try { if (db) db.close(); } catch { /* ignore */ } }
  }

  // Fallback: sqlite3 CLI (pre-installed on macOS, requires manual install on Windows/Linux)
  try {
    const result = execSync(
      `sqlite3 -json "${dbPath}" "${sql.replace(/"/g, '\\"')}"`,
      { timeout: 10000 }
    ).toString().trim();
    if (!result) return [];
    return JSON.parse(result);
  } catch { return []; }
}

function parseCursorDb(dbPath) {
  const sessions = [];
  try {
    // Get composer data entries
    const rows = querySqlite(dbPath, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
    for (const row of rows) {
      try {
        const data = JSON.parse(row.value);
        if (!data) continue;
        let inputTokens = 0, outputTokens = 0, model = null;
        let firstTs = null, lastTs = null, turns = 0;

        const bubbleIds = data.bubbleIds ?? data.allBubbleIds ?? [];
        for (const bid of bubbleIds) {
          const brows = querySqlite(dbPath, `SELECT value FROM cursorDiskKV WHERE key = 'bubbleData:${bid}'`);
          for (const br of brows) {
            try {
              const b = JSON.parse(br.value);
              if (!b) continue;
              const ts = tsMs(b.createdAt ?? b.timestamp);
              if (ts) { if (!firstTs || ts < firstTs) firstTs = ts; if (!lastTs || ts > lastTs) lastTs = ts; }
              if (!model && b.modelType) model = b.modelType;
              if (b.role === 'ai' || b.type === 1) turns++;
              const tc = b.tokenCount ?? b.tokens ?? {};
              inputTokens  += tc.inputTokens  ?? tc.input_tokens  ?? 0;
              outputTokens += tc.outputTokens ?? tc.output_tokens ?? 0;
            } catch {}
          }
        }

        const composerId = row.key.replace('composerData:', '');
        const ts = tsMs(data.createdAt ?? data.lastUpdatedAt);
        if (ts && (!firstTs || ts < firstTs)) firstTs = ts;

        sessions.push({
          tool: 'cursor',
          sessionId: composerId.slice(0, 8),
          model: model ?? 'unknown',
          inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: inputTokens + outputTokens,
          costUSD: calcCost(model, inputTokens, outputTokens),
          sessionDate: toDate(lastTs ?? firstTs ?? ts),
          turnCount: turns,
          firstTimestamp: firstTs ? new Date(firstTs).toISOString() : null,
          lastTimestamp:  lastTs  ? new Date(lastTs).toISOString()  : null,
          projectPath: null,
          tokenSource: (inputTokens > 0 || outputTokens > 0) ? 'log_file' : 'estimate',
        });
      } catch {}
    }
  } catch {}
  return sessions;
}

function parseWindsurfDb(dbPath) {
  const sessions = [];
  try {
    const rows = querySqlite(dbPath, "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'");
    for (const row of rows) {
      try {
        const index = JSON.parse(row.value);
        const sessionList = index?.sessions ?? index?.chatSessions ?? (Array.isArray(index) ? index : []);
        for (const s of sessionList) {
          const ts = tsMs(s.createdAt ?? s.lastUpdated ?? s.timestamp);
          sessions.push({
            tool: 'windsurf',
            sessionId: (s.id ?? s.sessionId ?? '').slice(0, 8),
            model: s.model ?? s.modelId ?? 'unknown',
            inputTokens:  s.inputTokens  ?? s.tokensIn  ?? 0,
            outputTokens: s.outputTokens ?? s.tokensOut ?? 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            totalTokens: (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
            costUSD: calcCost(s.model, s.inputTokens ?? 0, s.outputTokens ?? 0),
            sessionDate: toDate(ts),
            turnCount: s.turns ?? s.turnCount ?? 0,
            firstTimestamp: ts ? new Date(ts).toISOString() : null,
            lastTimestamp:  ts ? new Date(ts).toISOString() : null,
            projectPath: null,
            tokenSource: (s.inputTokens ?? 0) > 0 ? 'log_file' : 'estimate',
          });
        }
      } catch {}
    }
  } catch {}
  return sessions;
}

// ─── SCAN ────────────────────────────────────────────────────────────────────
const allSessions = [];
const detectedTools = new Set();
const notFoundTools = [];
const dataQualityNotes = [];

function scanJsonlDir(dir, toolName, parser) {
  if (!exists(dir)) { notFoundTools.push(toolName); return; }
  const files = walkDirs(dir)
    .filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
    .filter(f => { try { return fs.statSync(f).mtimeMs >= CUTOFF_30; } catch { return false; } });
  if (!files.length) { notFoundTools.push(toolName); return; }

  let found = 0;
  for (const f of files) {
    const s = parser(f);
    if (s) {
      allSessions.push(s);
      detectedTools.add(toolName);
      found++;
    }
  }
  if (!found) notFoundTools.push(toolName);
}

function scanClineDir(dir, toolName) {
  if (!exists(dir)) { notFoundTools.push(toolName); return; }
  let found = 0;
  try {
    const taskDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(dir, e.name))
      .filter(d => { try { return fs.statSync(d).mtimeMs >= CUTOFF_30; } catch { return false; } });

    for (const td of taskDirs) {
      const s = parseClineTaskDir(td, toolName);
      if (s) { allSessions.push(s); detectedTools.add(toolName); found++; }
    }
  } catch {}
  if (!found) notFoundTools.push(toolName);
}

// ─── CLAUDE CODE ─────────────────────────────────────────────────────────────
console.log('Scanning Claude Code...');
scanJsonlDir(PATHS.claude_code, 'claude_code', (f) => f.endsWith('.jsonl') ? parseClaudeJsonl(f) : null);

// ─── GENERIC JSONL TOOLS ─────────────────────────────────────────────────────
const jsonlTools = [
  ['gemini_cli', PATHS.gemini_cli],
  ['codex',      PATHS.codex],
  ['pi_agent',   PATHS.pi_agent],
  ['omp',        PATHS.omp],
  ['opencode',   PATHS.opencode],
  ['openclaw',   PATHS.openclaw],
  ['factory',    PATHS.factory],
  ['qwen',       PATHS.qwen],
  ['kimi',       PATHS.kimi],
  ['amp',        PATHS.amp],
];
for (const [name, dir] of jsonlTools) {
  console.log(`Scanning ${name}...`);
  scanJsonlDir(dir, name, (f) => parseGenericJsonl(f, name));
}

// ─── CLINE / ROO / KILO ──────────────────────────────────────────────────────
for (const [name, dir] of [['cline', PATHS.cline], ['roo_code', PATHS.roo_code], ['kilo_code', PATHS.kilo_code]]) {
  console.log(`Scanning ${name}...`);
  scanClineDir(dir, name);
}

// ─── CURSOR ──────────────────────────────────────────────────────────────────
console.log('Scanning Cursor...');
if (exists(PATHS.cursor_db)) {
  try {
    const cs = parseCursorDb(PATHS.cursor_db);
    if (cs.length) { cs.forEach(s => allSessions.push(s)); detectedTools.add('cursor'); }
    else notFoundTools.push('cursor');
  } catch (e) { notFoundTools.push('cursor'); dataQualityNotes.push('cursor db read error: ' + e.message); }
} else { notFoundTools.push('cursor'); }

// ─── WINDSURF ────────────────────────────────────────────────────────────────
console.log('Scanning Windsurf...');
if (exists(PATHS.windsurf_db)) {
  try {
    const ws = parseWindsurfDb(PATHS.windsurf_db);
    if (ws.length) { ws.forEach(s => allSessions.push(s)); detectedTools.add('windsurf'); }
    else notFoundTools.push('windsurf');
  } catch (e) { notFoundTools.push('windsurf'); dataQualityNotes.push('windsurf db read error: ' + e.message); }
} else { notFoundTools.push('windsurf'); }

// ─── METRICS ─────────────────────────────────────────────────────────────────
const inWindow = allSessions.filter(s => {
  if (!s.lastTimestamp) return false;
  return new Date(s.lastTimestamp).getTime() >= CUTOFF_28;
});

function weekOf(dateStr) {
  if (!dateStr) return null;
  const ms = new Date(dateStr).getTime();
  const daysAgo = (NOW - ms) / 86_400_000;
  if (daysAgo <= 7)  return 'W4';
  if (daysAgo <= 14) return 'W3';
  if (daysAgo <= 21) return 'W2';
  if (daysAgo <= 28) return 'W1';
  return null;
}

const weekCounts = { W1: 0, W2: 0, W3: 0, W4: 0 };
const activeDaySet = new Set();
let totalInputTok = 0, totalOutputTok = 0, totalCostUSD = 0;
let totalTurns = 0;
let multiTurn = 0, deepSession = 0, abandoned = 0;
const toolSessionCount = {};

for (const s of inWindow) {
  const w = weekOf(s.sessionDate);
  if (w) weekCounts[w]++;
  if (s.sessionDate) activeDaySet.add(s.sessionDate);
  totalInputTok  += s.inputTokens;
  totalOutputTok += s.outputTokens;
  totalCostUSD   += s.costUSD;
  totalTurns     += s.turnCount;
  if (s.turnCount >= 5)  multiTurn++;
  if (s.turnCount >= 10) deepSession++;
  if (s.turnCount <= 2)  abandoned++;
  toolSessionCount[s.tool] = (toolSessionCount[s.tool] ?? 0) + 1;
}

const N = inWindow.length;
const avgTurns = N ? (totalTurns / N) : 0;
const multiTurnRate  = N ? multiTurn  / N : 0;
const deepSessionRate = N ? deepSession / N : 0;
const abandonedRate  = N ? abandoned  / N : 0;

// Non-zero session days in 28-day window
const allDays = Array.from({ length: 28 }, (_, i) => {
  const d = new Date(NOW - i * 86_400_000);
  return d.toISOString().slice(0, 10);
});
const zeroSessionDays = allDays.filter(d => !activeDaySet.has(d)).length;

// Top model across all sessions
const modelCount = {};
for (const s of inWindow) modelCount[s.model] = (modelCount[s.model] ?? 0) + s.turnCount;
const topModel = Object.entries(modelCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

// Top 3 tools
const top3Tools = Object.entries(toolSessionCount)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([tool, count]) => ({ tool, sessions: count }));

// Readiness score
const W1 = weekCounts.W1, W4 = weekCounts.W4;
const engagementScore  = Math.min(25, (activeDaySet.size / 28) * 25);
const depthScore       = Math.min(25, (avgTurns / 20) * 25);
const coverageScore    = Math.min(20, (detectedTools.size / 5) * 20);
const progressionScore = Math.min(15, W1 > 0 ? (W4 / W1) * 15 : (W4 > 0 ? 15 : 0));
const frictionScore    = 15 * (1 - abandonedRate);
const readinessScore   = Math.round(engagementScore + depthScore + coverageScore + progressionScore + frictionScore);

// Data quality
const estimatedCount = inWindow.filter(s => s.tokenSource === 'estimate').length;
if (estimatedCount > 0) dataQualityNotes.push(`${estimatedCount} sessions used token estimation (no usage data in file)`);
const unknownModel = inWindow.filter(s => s.model === 'unknown').length;
if (unknownModel > 0) dataQualityNotes.push(`${unknownModel} sessions had unknown model (default pricing applied)`);

// ─── REPORT ──────────────────────────────────────────────────────────────────
const report = {
  report_generated: new Date().toISOString(),
  machine_os: process.platform,
  period: 'last_28_days',
  tools_detected: [...detectedTools],
  tools_not_found: notFoundTools,
  sessions: allSessions,
  engagement: {
    total_sessions: N,
    sessions_per_week: weekCounts,
    active_days: activeDaySet.size,
    active_day_list: [...activeDaySet].sort(),
    total_tokens: totalInputTok + totalOutputTok,
    total_input_tokens: totalInputTok,
    total_output_tokens: totalOutputTok,
    total_cost_usd: parseFloat(totalCostUSD.toFixed(6)),
  },
  depth: {
    avg_turns_per_session: parseFloat(avgTurns.toFixed(2)),
    multi_turn_rate: parseFloat(multiTurnRate.toFixed(4)),
    deep_session_rate: parseFloat(deepSessionRate.toFixed(4)),
  },
  task_coverage: {
    tools_used: Object.entries(toolSessionCount).map(([tool, sessions]) => ({ tool, sessions })),
    tool_diversity_count: detectedTools.size,
    top_model: topModel,
  },
  friction: {
    abandoned_session_rate: parseFloat(abandonedRate.toFixed(4)),
    zero_session_days: zeroSessionDays,
  },
  readiness_score: readinessScore,
  readiness_breakdown: {
    engagement: parseFloat(engagementScore.toFixed(2)),
    depth: parseFloat(depthScore.toFixed(2)),
    coverage: parseFloat(coverageScore.toFixed(2)),
    progression: parseFloat(progressionScore.toFixed(2)),
    friction: parseFloat(frictionScore.toFixed(2)),
  },
  top_3_tools: top3Tools,
  data_quality_notes: dataQualityNotes,
};

fs.writeFileSync(
  path.join(process.cwd(), 'detection-report.json'),
  JSON.stringify(report, null, 2)
);

// ─── TERMINAL SUMMARY ────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', gray: '\x1b[90m', red: '\x1b[31m', blue: '\x1b[34m',
};

console.log();
console.log(`${c.bold}${c.cyan}━━━  AI Tool Usage Report  ━━━${c.reset}`);
console.log(`${c.gray}Generated: ${report.report_generated}${c.reset}`);
console.log(`${c.gray}OS: ${process.platform}  |  Period: last 28 days${c.reset}`);
console.log();

console.log(`${c.bold}Tools Detected (${detectedTools.size})${c.reset}`);
for (const t of detectedTools) {
  const cnt = toolSessionCount[t] ?? 0;
  console.log(`  ${c.green}✓${c.reset} ${t.padEnd(20)} ${cnt} session${cnt !== 1 ? 's' : ''} in window`);
}
if (notFoundTools.length) {
  console.log(`${c.gray}Not found: ${notFoundTools.join(', ')}${c.reset}`);
}

console.log();
console.log(`${c.bold}Engagement (last 28 days)${c.reset}`);
console.log(`  Sessions    : ${N}`);
console.log(`  Active days : ${activeDaySet.size} / 28`);
console.log(`  Weekly      : W1=${weekCounts.W1}  W2=${weekCounts.W2}  W3=${weekCounts.W3}  W4=${weekCounts.W4}`);
console.log(`  Total tokens: ${(totalInputTok + totalOutputTok).toLocaleString()}`);
console.log(`  Total cost  : $${totalCostUSD.toFixed(4)}`);

console.log();
console.log(`${c.bold}Depth${c.reset}`);
console.log(`  Avg turns/session : ${avgTurns.toFixed(1)}`);
console.log(`  Multi-turn (≥5)   : ${(multiTurnRate * 100).toFixed(1)}%`);
console.log(`  Deep session (≥10): ${(deepSessionRate * 100).toFixed(1)}%`);

console.log();
console.log(`${c.bold}Friction${c.reset}`);
console.log(`  Abandoned (≤2 turns): ${(abandonedRate * 100).toFixed(1)}%`);
console.log(`  Zero-session days   : ${zeroSessionDays}`);

console.log();
console.log(`${c.bold}Top model: ${c.cyan}${topModel}${c.reset}`);

console.log();
const bar = (score, max, width = 30) => {
  const filled = Math.round((score / max) * width);
  return `${c.green}${'█'.repeat(filled)}${c.gray}${'░'.repeat(width - filled)}${c.reset}`;
};
console.log(`${c.bold}Readiness Score: ${c.cyan}${readinessScore}${c.reset}${c.bold} / 100${c.reset}`);
console.log(`  ${bar(readinessScore, 100)}`);
console.log(`  Engagement  ${bar(engagementScore,  25, 12)}  ${engagementScore.toFixed(1)}/25`);
console.log(`  Depth       ${bar(depthScore,       25, 12)}  ${depthScore.toFixed(1)}/25`);
console.log(`  Coverage    ${bar(coverageScore,    20, 12)}  ${coverageScore.toFixed(1)}/20`);
console.log(`  Progression ${bar(progressionScore, 15, 12)}  ${progressionScore.toFixed(1)}/15`);
console.log(`  Friction    ${bar(frictionScore,    15, 12)}  ${frictionScore.toFixed(1)}/15`);

if (dataQualityNotes.length) {
  console.log();
  console.log(`${c.yellow}Data quality notes:${c.reset}`);
  for (const n of dataQualityNotes) console.log(`  ${c.yellow}⚠${c.reset}  ${n}`);
}

console.log();
console.log(`${c.green}✓ Saved to detection-report.json${c.reset}`);
console.log();
