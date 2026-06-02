#!/usr/bin/env node
// detect.js — AI tool usage detector
// Packages: better-sqlite3, chalk, cli-table3

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
import chalk from 'chalk';
import Table from 'cli-table3';

const HOME = os.homedir();

function appDataDir() {
  switch (process.platform) {
    case 'win32':
      return process.env['APPDATA'] || path.join(HOME, 'AppData', 'Roaming');
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support');
    default:
      return path.join(HOME, '.config');
  }
}

const APP_DATA = appDataDir();

// ─── PATHS ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    id: 'claude_code',
    label: 'Claude Code',
    path: path.join(HOME, '.claude', 'projects'),
    type: 'jsonl_dir',
  },
  {
    id: 'gemini_cli',
    label: 'Gemini CLI',
    path: process.platform === 'win32'
      ? path.join(APP_DATA, 'gemini', 'tmp')
      : path.join(HOME, '.gemini', 'tmp'),
    type: 'jsonl_dir',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    path: path.join(APP_DATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    type: 'sqlite',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    path: path.join(APP_DATA, 'Windsurf', 'User', 'globalStorage', 'state.vscdb'),
    type: 'sqlite',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    path: path.join(HOME, '.codex', 'sessions'),
    type: 'jsonl_dir',
  },
  {
    id: 'pi_agent',
    label: 'Pi Agent',
    path: path.join(HOME, '.pi', 'agent', 'sessions'),
    type: 'jsonl_dir',
  },
  {
    id: 'cline',
    label: 'Cline',
    path: path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    type: 'cline_dir',
  },
  {
    id: 'roo_code',
    label: 'Roo Code',
    path: path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),
    type: 'cline_dir',
  },
];

// ─── PRICING ──────────────────────────────────────────────────────────────────
const PRICING = [
  { match: /claude-opus-4/,     input: 5.00,   output: 25.00  },
  { match: /claude-sonnet-4/,   input: 3.00,   output: 15.00  },
  { match: /claude-haiku-4/,    input: 1.00,   output:  5.00  },
  { match: /claude-3-5-sonnet/, input: 3.00,   output: 15.00  },
  { match: /claude-3-5-haiku/,  input: 0.80,   output:  4.00  },
  { match: /claude-3-opus/,     input: 15.00,  output: 75.00  },
  { match: /claude-3-haiku/,    input: 0.25,   output:  1.25  },
  { match: /gemini-2\.0-flash/, input: 0.075,  output:  0.30  },
  { match: /gemini-1\.5-flash/, input: 0.075,  output:  0.30  },
  { match: /gemini-1\.5-pro/,   input: 1.25,   output:  5.00  },
  { match: /gpt-4o/,            input: 2.50,   output: 10.00  },
  { match: /gpt-4-turbo/,       input: 10.00,  output: 30.00  },
];
const DEFAULT_PRICE = { input: 3.00, output: 15.00 };

function getPrice(model = '') {
  const m = (model ?? '').toLowerCase();
  for (const p of PRICING) if (p.match.test(m)) return p;
  return DEFAULT_PRICE;
}

function calcCost(model, inputTok, outputTok) {
  const p = getPrice(model);
  return (inputTok / 1e6) * p.input + (outputTok / 1e6) * p.output;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function pathExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function walkJsonl(dir) {
  const out = [];
  if (!pathExists(dir)) return out;
  function recurse(d, depth = 0) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) recurse(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
      }
    } catch {}
  }
  recurse(dir);
  return out;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function toIso(ts) {
  if (!ts) return null;
  try {
    const n = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : Number(ts);
    return new Date(isNaN(n) ? ts : n).toISOString();
  } catch { return null; }
}

function toDate(ts) {
  const iso = toIso(ts);
  return iso ? iso.slice(0, 10) : null;
}

function fmt(n) { return n.toLocaleString('en-US'); }

// ─── PARSERS ──────────────────────────────────────────────────────────────────

function parseClaudeJsonl(file) {
  const lines = readJsonl(file);
  if (!lines.length) return null;

  let model = null, inputTok = 0, outputTok = 0, cacheRead = 0, cacheWrite = 0;
  let turns = 0, firstTs = null, lastTs = null, hasUsage = false;
  const textParts = [];

  for (const e of lines) {
    const ts = toIso(e.timestamp);
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs  || ts > lastTs)  lastTs  = ts;
    }
    if (e.type === 'assistant') {
      turns++;
      const msg = e.message ?? e;
      if (!model && msg.model) model = msg.model;
      const u = msg.usage;
      if (u) {
        hasUsage = true;
        inputTok    += u.input_tokens                ?? u.inputTokens    ?? 0;
        outputTok   += u.output_tokens               ?? u.outputTokens   ?? 0;
        cacheRead   += u.cache_read_input_tokens     ?? 0;
        cacheWrite  += u.cache_creation_input_tokens ?? 0;
      }
      const c = msg.content;
      if (Array.isArray(c)) c.forEach(b => b.type === 'text' && textParts.push(b.text ?? ''));
      else if (typeof c === 'string') textParts.push(c);
    } else if (e.type === 'user') {
      const c = (e.message ?? e).content;
      if (Array.isArray(c)) c.forEach(b => b.type === 'text' && textParts.push(b.text ?? ''));
      else if (typeof c === 'string') textParts.push(c);
    }
  }

  // Estimation fallback when no usage metadata
  if (!hasUsage && textParts.length) {
    const chars = textParts.join('').length;
    inputTok  = Math.round(chars * 0.6 / 4);
    outputTok = Math.round(chars * 0.4 / 4);
  }

  return {
    sessionId: path.basename(file, '.jsonl').slice(0, 8),
    model: model ?? 'unknown',
    inputTokens: inputTok, outputTokens: outputTok,
    cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    turns, date: toDate(lastTs ?? firstTs),
    costUSD: calcCost(model, inputTok, outputTok),
    tokenSource: hasUsage ? 'log_file' : 'estimate',
  };
}

function parseGenericJsonl(file, toolId) {
  const lines = readJsonl(file);
  if (!lines.length) return null;

  let model = null, inputTok = 0, outputTok = 0, turns = 0;
  let firstTs = null, lastTs = null, hasUsage = false;
  const textParts = [];

  for (const e of lines) {
    const ts = toIso(e.timestamp ?? e.created_at ?? e.ts);
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs  || ts > lastTs)  lastTs  = ts;
    }
    if (!model) model = e.model ?? e.modelId ?? null;

    const role = e.role ?? e.type;
    if (role === 'assistant' || role === 'model') turns++;

    for (const u of [e.usage, e.usageMetadata, e.token_usage].filter(Boolean)) {
      hasUsage = true;
      inputTok  += u.input_tokens ?? u.inputTokens  ?? u.promptTokenCount    ?? 0;
      outputTok += u.output_tokens ?? u.outputTokens ?? u.candidatesTokenCount ?? 0;
    }

    const text = e.content ?? e.text ?? e.parts?.[0]?.text ?? '';
    if (typeof text === 'string') textParts.push(text);
  }

  if (!hasUsage && textParts.length) {
    const chars = textParts.join('').length;
    inputTok  = Math.round(chars * 0.6 / 4);
    outputTok = Math.round(chars * 0.4 / 4);
  }

  return {
    sessionId: path.basename(file, path.extname(file)).slice(0, 8),
    model: model ?? 'unknown',
    inputTokens: inputTok, outputTokens: outputTok,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    turns, date: toDate(lastTs ?? firstTs),
    costUSD: calcCost(model, inputTok, outputTok),
    tokenSource: hasUsage ? 'log_file' : 'estimate',
  };
}

function parseClineDir(dir) {
  const sessions = [];
  if (!pathExists(dir)) return sessions;
  const tasksDir = path.join(dir, 'tasks');
  const base = pathExists(tasksDir) ? tasksDir : dir;

  let taskDirs = [];
  try {
    taskDirs = fs.readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(base, e.name));
  } catch { return sessions; }

  for (const td of taskDirs) {
    const hist = readJson(path.join(td, 'api_conversation_history.json'));
    if (!hist || !Array.isArray(hist)) continue;

    let model = null, inputTok = 0, outputTok = 0, cacheRead = 0, cacheWrite = 0, turns = 0;
    let firstTs = null, lastTs = null;

    for (const msg of hist) {
      const ts = toIso(msg.ts ?? msg.timestamp);
      if (ts) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (!lastTs  || ts > lastTs)  lastTs  = ts;
      }
      if (!model) model = msg.model ?? null;
      if (msg.role === 'assistant') turns++;
      const u = msg.usage;
      if (u) {
        inputTok    += u.input_tokens                ?? u.tokensIn    ?? 0;
        outputTok   += u.output_tokens               ?? u.tokensOut   ?? 0;
        cacheRead   += u.cache_read_input_tokens     ?? u.cacheReads  ?? 0;
        cacheWrite  += u.cache_creation_input_tokens ?? u.cacheWrites ?? 0;
      }
    }

    // Supplement from ui_messages
    const ui = readJson(path.join(td, 'ui_messages.json'));
    if (Array.isArray(ui)) {
      for (const m of ui) {
        if (!model && m.model) model = m.model;
        if (m.type === 'say' && m.say === 'api_req_finished' && m.text) {
          try {
            const p = JSON.parse(m.text);
            if (!model && p.model) model = p.model;
          } catch {}
        }
      }
    }

    const mtime = (() => { try { return fs.statSync(td).mtimeMs; } catch { return null; } })();
    sessions.push({
      sessionId: path.basename(td).slice(0, 8),
      model: model ?? 'unknown',
      inputTokens: inputTok, outputTokens: outputTok,
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      turns, date: toDate(lastTs ?? mtime),
      costUSD: calcCost(model, inputTok, outputTok),
      tokenSource: (inputTok + outputTok) > 0 ? 'log_file' : 'estimate',
    });
  }
  return sessions;
}

function parseSqliteDb(dbPath, toolId) {
  const sessions = [];
  if (!pathExists(dbPath)) return sessions;

  let db;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return sessions; }

  try {
    if (toolId === 'cursor') {
      // Check table exists
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      if (!tables.includes('cursorDiskKV')) return sessions;

      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
      for (const row of rows) {
        try {
          const data = JSON.parse(row.value);
          if (!data) continue;
          let inputTok = 0, outputTok = 0, model = null, turns = 0;
          let firstTs = null, lastTs = null;

          const bubbleIds = data.bubbleIds ?? data.allBubbleIds ?? [];
          for (const bid of bubbleIds) {
            try {
              const br = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`bubbleData:${bid}`);
              if (!br) continue;
              const b = JSON.parse(br.value);
              if (!b) continue;
              const ts = toIso(b.createdAt ?? b.timestamp);
              if (ts) {
                if (!firstTs || ts < firstTs) firstTs = ts;
                if (!lastTs  || ts > lastTs)  lastTs  = ts;
              }
              if (!model && b.modelType) model = b.modelType;
              if (b.role === 'ai' || b.type === 1) turns++;
              const tc = b.tokenCount ?? b.tokens ?? {};
              inputTok  += tc.inputTokens  ?? tc.input_tokens  ?? 0;
              outputTok += tc.outputTokens ?? tc.output_tokens ?? 0;
            } catch {}
          }

          const composerId = row.key.replace('composerData:', '');
          sessions.push({
            sessionId: composerId.slice(0, 8),
            model: model ?? 'unknown',
            inputTokens: inputTok, outputTokens: outputTok,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            turns, date: toDate(lastTs ?? firstTs ?? data.createdAt),
            costUSD: calcCost(model, inputTok, outputTok),
            tokenSource: (inputTok + outputTok) > 0 ? 'log_file' : 'estimate',
          });
        } catch {}
      }
    } else if (toolId === 'windsurf') {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      if (!tables.includes('ItemTable')) return sessions;

      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get();
      if (!row) return sessions;

      const index = JSON.parse(row.value);
      const list = index?.sessions ?? index?.chatSessions ?? (Array.isArray(index) ? index : []);
      for (const s of list) {
        const ts = toIso(s.createdAt ?? s.lastUpdated ?? s.timestamp);
        sessions.push({
          sessionId: (s.id ?? s.sessionId ?? '').slice(0, 8),
          model: s.model ?? s.modelId ?? 'unknown',
          inputTokens:  s.inputTokens  ?? s.tokensIn  ?? 0,
          outputTokens: s.outputTokens ?? s.tokensOut ?? 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          turns: s.turns ?? s.turnCount ?? 0,
          date: toDate(ts),
          costUSD: calcCost(s.model, s.inputTokens ?? 0, s.outputTokens ?? 0),
          tokenSource: (s.inputTokens ?? 0) > 0 ? 'log_file' : 'estimate',
        });
      }
    }
  } catch {}
  finally { try { db.close(); } catch {} }

  return sessions;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const CMD = process.argv[2] ?? null;
const KNOWN_CMDS = ['scan','tokens','cost','summary','sessions','daily','weekly','monthly'];
const NOW = Date.now();
const CUTOFF_28 = NOW - 28 * 86_400_000;

const results = [];  // { tool, label, installed, sessions: [] }

if (!CMD || CMD === 'scan') console.log(chalk.bold.cyan('\n  Scanning for AI coding tools...\n'));

for (const tool of TOOLS) {
  const installed = pathExists(tool.path);
  const entry = { tool: tool.id, label: tool.label, path: tool.path, installed, sessions: [] };

  if (!installed) {
    if (!CMD || CMD === 'scan') console.log(chalk.gray(`  ✗  ${tool.label.padEnd(18)} not installed`));
    results.push(entry);
    continue;
  }

  try {
    if (tool.type === 'jsonl_dir') {
      const files = walkJsonl(tool.path);
      for (const f of files) {
        const s = tool.id === 'claude_code' ? parseClaudeJsonl(f) : parseGenericJsonl(f, tool.id);
        if (s) entry.sessions.push(s);
      }
    } else if (tool.type === 'cline_dir') {
      entry.sessions = parseClineDir(tool.path);
    } else if (tool.type === 'sqlite') {
      entry.sessions = parseSqliteDb(tool.path, tool.id);
    }
    if (!CMD || CMD === 'scan') console.log(chalk.green(`  ✓  ${tool.label.padEnd(18)} found — ${entry.sessions.length} session(s)`));
  } catch (err) {
    if (!CMD || CMD === 'scan') console.log(chalk.yellow(`  ⚠  ${tool.label.padEnd(18)} found but error reading: ${err.message}`));
  }

  results.push(entry);
}

// ─── AGGREGATE DATA (always computed — used by all commands) ─────────────────

let grandInput = 0, grandOutput = 0, grandCost = 0, grandSessions = 0;
const installedTools = [];

for (const r of results) {
  if (!r.installed) continue;
  installedTools.push(r.tool);
  const recent = r.sessions.filter(s => !s.date || new Date(s.date).getTime() >= CUTOFF_28);
  grandInput    += recent.reduce((a, s) => a + s.inputTokens,  0);
  grandOutput   += recent.reduce((a, s) => a + s.outputTokens, 0);
  grandCost     += recent.reduce((a, s) => a + s.costUSD, 0);
  grandSessions += recent.length;
}

// ─── SUMMARY TABLE ────────────────────────────────────────────────────────────
if (!CMD || CMD === 'summary') {
  console.log(chalk.bold.cyan('\n  Summary\n'));

  const table = new Table({
    head: [
      chalk.bold('Tool'),
      chalk.bold('Status'),
      chalk.bold('Sessions'),
      chalk.bold('Input tok'),
      chalk.bold('Output tok'),
      chalk.bold('Cost (USD)'),
    ],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
  });

  for (const r of results) {
    if (!r.installed) {
      table.push([chalk.gray(r.label), chalk.gray('not installed'), '-', '-', '-', '-']);
      continue;
    }
    const recent = r.sessions.filter(s => !s.date || new Date(s.date).getTime() >= CUTOFF_28);
    const tIn   = recent.reduce((a, s) => a + s.inputTokens,  0);
    const tOut  = recent.reduce((a, s) => a + s.outputTokens, 0);
    const tCost = recent.reduce((a, s) => a + s.costUSD, 0);
    table.push([
      chalk.cyan(r.label), chalk.green('installed'),
      recent.length, fmt(tIn), fmt(tOut), chalk.green(`$${tCost.toFixed(4)}`),
    ]);
  }

  table.push([
    chalk.bold('TOTAL'), '',
    chalk.bold(grandSessions),
    chalk.bold(fmt(grandInput)),
    chalk.bold(fmt(grandOutput)),
    chalk.bold.green(`$${grandCost.toFixed(4)}`),
  ]);

  console.log(table.toString());
}

// ─── READINESS SCORE ─────────────────────────────────────────────────────────

// Gather all sessions in window across all tools
const allRecent = results.flatMap(r =>
  r.sessions.filter(s => !s.date || new Date(s.date).getTime() >= CUTOFF_28)
);

const N = allRecent.length;
const activeDaySet = new Set(allRecent.map(s => s.date).filter(Boolean));
const turns = allRecent.map(s => s.turns);
const avgTurns = N ? turns.reduce((a, b) => a + b, 0) / N : 0;
const multiTurnRate = N ? allRecent.filter(s => s.turns >= 5).length / N : 0;
const abandonedRate = N ? allRecent.filter(s => s.turns <= 2).length / N : 0;

function weekOf(dateStr) {
  const daysAgo = (NOW - new Date(dateStr).getTime()) / 86_400_000;
  if (daysAgo <=  7) return 'W4';
  if (daysAgo <= 14) return 'W3';
  if (daysAgo <= 21) return 'W2';
  if (daysAgo <= 28) return 'W1';
  return null;
}
const weekCounts = { W1: 0, W2: 0, W3: 0, W4: 0 };
for (const s of allRecent) { const w = weekOf(s.date ?? ''); if (w) weekCounts[w]++; }

const engScore   = Math.min(25, (activeDaySet.size / 28) * 25);
const depthScore = Math.min(25, (avgTurns / 20) * 25);
const covScore   = Math.min(20, (installedTools.length / 5) * 20);
const progScore  = Math.min(15, weekCounts.W1 > 0 ? (weekCounts.W4 / weekCounts.W1) * 15 : (weekCounts.W4 > 0 ? 15 : 0));
const fricScore  = 15 * (1 - abandonedRate);
const readiness  = Math.round(engScore + depthScore + covScore + progScore + fricScore);

function scoreBar(val, max, width = 20) {
  const filled = Math.round((val / max) * width);
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
}

if (!CMD || CMD === 'summary') {
  console.log(chalk.bold('\n  Readiness Score\n'));
  console.log(`  ${chalk.bold.cyan(readiness)} / 100   ${scoreBar(readiness, 100, 30)}\n`);
  console.log(`  Engagement   ${scoreBar(engScore,   25)} ${engScore.toFixed(1).padStart(4)}/25   (${activeDaySet.size} active days)`);
  console.log(`  Depth        ${scoreBar(depthScore, 25)} ${depthScore.toFixed(1).padStart(4)}/25   (avg ${avgTurns.toFixed(1)} turns/session)`);
  console.log(`  Coverage     ${scoreBar(covScore,   20)} ${covScore.toFixed(1).padStart(4)}/20   (${installedTools.length} tools found)`);
  console.log(`  Progression  ${scoreBar(progScore,  15)} ${progScore.toFixed(1).padStart(4)}/15   (W1=${weekCounts.W1} → W4=${weekCounts.W4})`);
  console.log(`  Friction     ${scoreBar(fricScore,  15)} ${fricScore.toFixed(1).padStart(4)}/15   (${(abandonedRate*100).toFixed(0)}% abandoned)`);
  console.log();
}

// ─── SAVE JSON ────────────────────────────────────────────────────────────────

const report = {
  report_generated: new Date().toISOString(),
  machine_os: process.platform,
  period: 'last_28_days',
  tools_detected: installedTools,
  tools_not_found: results.filter(r => !r.installed).map(r => r.tool),
  sessions: results.flatMap(r =>
    r.sessions.map(s => ({ tool: r.tool, ...s }))
  ),
  engagement: {
    total_sessions: N,
    sessions_per_week: weekCounts,
    active_days: activeDaySet.size,
    total_tokens: grandInput + grandOutput,
    total_cost_usd: parseFloat(grandCost.toFixed(6)),
  },
  depth: {
    avg_turns_per_session: parseFloat(avgTurns.toFixed(2)),
    multi_turn_rate: parseFloat(multiTurnRate.toFixed(4)),
  },
  task_coverage: {
    tools_used: installedTools,
    tool_diversity_count: installedTools.length,
  },
  friction: {
    abandoned_session_rate: parseFloat(abandonedRate.toFixed(4)),
  },
  readiness_score: readiness,
  readiness_breakdown: {
    engagement:  parseFloat(engScore.toFixed(2)),
    depth:       parseFloat(depthScore.toFixed(2)),
    coverage:    parseFloat(covScore.toFixed(2)),
    progression: parseFloat(progScore.toFixed(2)),
    friction:    parseFloat(fricScore.toFixed(2)),
  },
};

const outFile = path.join(process.cwd(), 'detection-report.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
if (!CMD || CMD === 'summary') console.log(chalk.green(`  ✓ Saved to detection-report.json\n`));

// ─── NEW COMMANDS ─────────────────────────────────────────────────────────────

const allSessions = results.flatMap(r => r.sessions.map(s => ({ ...s, tool: r.tool, label: r.label })));
const recentSessions = allSessions.filter(s => !s.date || new Date(s.date).getTime() >= CUTOFF_28);

function hdr(title) {
  console.log(chalk.bold.cyan(`\n  ${title}\n`));
}

// ── scan ──────────────────────────────────────────────────────────────────────
if (CMD === 'scan') {
  const t = new Table({
    head: [chalk.bold('Tool'), chalk.bold('Path'), chalk.bold('Status'), chalk.bold('Sessions')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'left', 'left', 'right'],
  });
  for (const r of results) {
    const statusCell = r.installed ? chalk.green('found') : chalk.gray('not installed');
    const shortPath = r.path.replace(HOME, '~');
    t.push([
      r.installed ? chalk.cyan(r.label) : chalk.gray(r.label),
      chalk.gray(shortPath),
      statusCell,
      r.installed ? r.sessions.length : '-',
    ]);
  }
  hdr('Tool Detection Scan');
  console.log(t.toString());
  console.log(chalk.gray(`  ${installedTools.length} of ${results.length} tools installed\n`));
}

// ── tokens ────────────────────────────────────────────────────────────────────
if (CMD === 'tokens') {
  hdr('Token Usage — Last 28 Days');
  const t = new Table({
    head: [chalk.bold('Tool'), chalk.bold('Sessions'), chalk.bold('Input'), chalk.bold('Output'), chalk.bold('Cache read'), chalk.bold('Cache write'), chalk.bold('Total')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
  });
  let tI = 0, tO = 0, tCR = 0, tCW = 0;
  for (const r of results) {
    if (!r.installed) continue;
    const rs = r.sessions.filter(s => !s.date || new Date(s.date).getTime() >= CUTOFF_28);
    if (!rs.length) continue;
    const inp = rs.reduce((a, s) => a + s.inputTokens,  0);
    const out = rs.reduce((a, s) => a + s.outputTokens, 0);
    const cr  = rs.reduce((a, s) => a + s.cacheReadTokens,  0);
    const cw  = rs.reduce((a, s) => a + s.cacheWriteTokens, 0);
    tI += inp; tO += out; tCR += cr; tCW += cw;
    t.push([chalk.cyan(r.label), rs.length, fmt(inp), fmt(out), fmt(cr), fmt(cw), chalk.bold(fmt(inp+out+cr+cw))]);
  }
  t.push([chalk.bold('TOTAL'), chalk.bold(grandSessions), chalk.bold(fmt(tI)), chalk.bold(fmt(tO)),
          chalk.bold(fmt(tCR)), chalk.bold(fmt(tCW)), chalk.bold.green(fmt(tI+tO+tCR+tCW))]);
  console.log(t.toString());
  console.log(chalk.gray(`  Input $3.00/M · Output $15.00/M (default pricing)\n`));
}

// ── cost ──────────────────────────────────────────────────────────────────────
if (CMD === 'cost') {
  hdr('Cost Breakdown — Last 28 Days');
  const t = new Table({
    head: [chalk.bold('Tool'), chalk.bold('Sessions'), chalk.bold('Input cost'), chalk.bold('Output cost'), chalk.bold('Total cost'), chalk.bold('% of total')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
  });
  const rows = [];
  for (const r of results) {
    if (!r.installed) continue;
    const rs = r.sessions.filter(s => !s.date || new Date(s.date).getTime() >= CUTOFF_28);
    if (!rs.length) continue;
    const inp = rs.reduce((a, s) => a + s.inputTokens,  0);
    const out = rs.reduce((a, s) => a + s.outputTokens, 0);
    const p = getPrice(rs.find(s => s.model !== 'unknown')?.model);
    const ic = (inp / 1e6) * p.input;
    const oc = (out / 1e6) * p.output;
    rows.push({ label: r.label, sessions: rs.length, ic, oc, total: ic + oc });
  }
  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    const pct = grandCost > 0 ? ((row.total / grandCost) * 100).toFixed(1) : '0.0';
    t.push([chalk.cyan(row.label), row.sessions, `$${row.ic.toFixed(4)}`, `$${row.oc.toFixed(4)}`,
            chalk.green(`$${row.total.toFixed(4)}`), `${pct}%`]);
  }
  t.push([chalk.bold('TOTAL'), chalk.bold(grandSessions), '', '',
          chalk.bold.green(`$${grandCost.toFixed(4)}`), '100%']);
  console.log(t.toString());
  console.log();
}

// ── sessions ──────────────────────────────────────────────────────────────────
if (CMD === 'sessions') {
  hdr('All Sessions — Last 28 Days');
  const t = new Table({
    head: [chalk.bold('Tool'), chalk.bold('Session ID'), chalk.bold('Model'), chalk.bold('Turns'),
           chalk.bold('Tokens'), chalk.bold('Cost'), chalk.bold('Date')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'left', 'left', 'right', 'right', 'right', 'left'],
  });
  const sorted = [...recentSessions].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  for (const s of sorted) {
    t.push([
      chalk.cyan((s.label ?? s.tool).slice(0, 12)),
      chalk.gray(s.sessionId),
      (s.model ?? 'unknown').replace('claude-', '').slice(0, 16),
      s.turns,
      fmt(s.inputTokens + s.outputTokens),
      `$${s.costUSD.toFixed(4)}`,
      s.date ?? '—',
    ]);
  }
  console.log(t.toString());
  console.log(chalk.gray(`  ${recentSessions.length} sessions total\n`));
}

// ── daily ─────────────────────────────────────────────────────────────────────
if (CMD === 'daily') {
  hdr('Daily Usage — Last 28 Days');
  const byDay = {};
  for (const s of recentSessions) {
    const d = s.date ?? 'unknown';
    if (!byDay[d]) byDay[d] = { sessions: 0, tokens: 0, cost: 0 };
    byDay[d].sessions++;
    byDay[d].tokens += s.inputTokens + s.outputTokens;
    byDay[d].cost   += s.costUSD;
  }
  const t = new Table({
    head: [chalk.bold('Date'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost'), chalk.bold('Activity')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'left'],
  });
  const maxSess = Math.max(...Object.values(byDay).map(d => d.sessions), 1);
  const days = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(NOW - (27 - i) * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  for (const day of days) {
    const d = byDay[day];
    if (!d) { t.push([chalk.gray(day), chalk.gray('0'), chalk.gray('0'), chalk.gray('$0.0000'), chalk.gray('·')]); continue; }
    const bar = chalk.green('█'.repeat(Math.round((d.sessions / maxSess) * 15))) + '  ' + chalk.cyan(`${d.sessions} session${d.sessions !== 1 ? 's' : ''}`);
    t.push([day, d.sessions, fmt(d.tokens), chalk.green(`$${d.cost.toFixed(4)}`), bar]);
  }
  console.log(t.toString());
  console.log();
}

// ── weekly ────────────────────────────────────────────────────────────────────
if (CMD === 'weekly') {
  hdr('Weekly Usage — Last 28 Days');
  const weeks = {
    'W1 (oldest)': { sessions: 0, tokens: 0, cost: 0, days: new Set() },
    'W2':          { sessions: 0, tokens: 0, cost: 0, days: new Set() },
    'W3':          { sessions: 0, tokens: 0, cost: 0, days: new Set() },
    'W4 (latest)': { sessions: 0, tokens: 0, cost: 0, days: new Set() },
  };
  const wLabel = (d) => {
    const daysAgo = (NOW - new Date(d).getTime()) / 86_400_000;
    if (daysAgo <= 7)  return 'W4 (latest)';
    if (daysAgo <= 14) return 'W3';
    if (daysAgo <= 21) return 'W2';
    return 'W1 (oldest)';
  };
  for (const s of recentSessions) {
    if (!s.date) continue;
    const wk = wLabel(s.date);
    weeks[wk].sessions++;
    weeks[wk].tokens += s.inputTokens + s.outputTokens;
    weeks[wk].cost   += s.costUSD;
    weeks[wk].days.add(s.date);
  }
  const t = new Table({
    head: [chalk.bold('Week'), chalk.bold('Sessions'), chalk.bold('Active days'), chalk.bold('Tokens'), chalk.bold('Cost'), chalk.bold('Trend')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'left'],
  });
  const maxW = Math.max(...Object.values(weeks).map(w => w.sessions), 1);
  for (const [label, w] of Object.entries(weeks)) {
    const bar = chalk.green('█'.repeat(Math.round((w.sessions / maxW) * 20)));
    t.push([label, w.sessions, w.days.size, fmt(w.tokens), chalk.green(`$${w.cost.toFixed(4)}`), bar]);
  }
  console.log(t.toString());
  console.log();
}

// ── monthly ───────────────────────────────────────────────────────────────────
if (CMD === 'monthly') {
  hdr('Monthly Usage');
  const byMonth = {};
  for (const s of allSessions) {
    if (!s.date) continue;
    const mo = s.date.slice(0, 7);
    if (!byMonth[mo]) byMonth[mo] = { sessions: 0, tokens: 0, cost: 0, days: new Set() };
    byMonth[mo].sessions++;
    byMonth[mo].tokens += s.inputTokens + s.outputTokens;
    byMonth[mo].cost   += s.costUSD;
    byMonth[mo].days.add(s.date);
  }
  const t = new Table({
    head: [chalk.bold('Month'), chalk.bold('Sessions'), chalk.bold('Active days'), chalk.bold('Tokens'), chalk.bold('Cost'), chalk.bold('Activity')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'left'],
  });
  const maxM = Math.max(...Object.values(byMonth).map(m => m.sessions), 1);
  for (const [mo, m] of Object.entries(byMonth).sort()) {
    const bar = chalk.green('█'.repeat(Math.round((m.sessions / maxM) * 20)));
    t.push([mo, m.sessions, m.days.size, fmt(m.tokens), chalk.green(`$${m.cost.toFixed(4)}`), bar]);
  }
  console.log(t.toString());
  console.log();
}

// ── unknown command ────────────────────────────────────────────────────────────
if (CMD && !KNOWN_CMDS.includes(CMD)) {
  console.log(chalk.red(`\n  Unknown command: ${CMD}\n`));
  console.log(chalk.gray('  Available commands:'));
  for (const c of KNOWN_CMDS) console.log(chalk.gray(`    node detect.js ${c}`));
  console.log();
}
