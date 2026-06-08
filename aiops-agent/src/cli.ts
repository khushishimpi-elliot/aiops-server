#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { program } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { runAllAdapters, ToolResult } from './adapters/index.js';
import { SessionRecord } from './core/types.js';
import { readLastLines, logFilePath } from './core/logger.js';
import { runAnalysis } from './core/analyst.js';
import { startServer } from './core/server.js';
import { PATHS } from './core/paths.js';
import { openDb, upsertSessions, getDailyTotals, getWeeklyTotals, getBudgets, setBudget, isAvailable as dbAvailable, dbPath, getRecentScans, getHistoricalSummary, getDbStats } from './core/db.js';
import { saveConfig, getMachineId, isEnrolled, loadConfig as _loadConfig } from './core/config.js';
import { syncToServer } from './core/syncer.js';
import { startDaemon, isDaemonAlive, stopDaemon, readDaemonPid, LOG_FILE as DAEMON_LOG } from './core/daemon.js';
import { install as installAutoStart, uninstall as uninstallAutoStart, isInstalled as isAutoStartInstalled } from './core/installer.js';

const VERSION = '1.0.0';

// Sync window covering the entire local history. Old days are safe to
// re-send: the server upserts by (date, tool, model, category).
const FULL_HISTORY_DAYS = 3650;

// ─── FORMAT HELPERS ───────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n <= 0) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtTokensFull(n: number): string {
  if (n <= 0) return '—';
  return n.toLocaleString('en-US');
}

function fmtCost(n: number): string {
  if (n <= 0) return '—';
  return '$' + n.toFixed(3);
}

function fmtDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function today(): string { return new Date().toISOString().slice(0, 10); }

function bar(pct: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round(pct / 100 * width)));
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
}

function divider(): void {
  console.log(chalk.gray('─────────────────────────────────────────────────────'));
}

function section(title: string): void {
  console.log();
  divider();
  console.log();
  console.log('  ' + chalk.bold.white(title));
  console.log();
}

function platformName(): string {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32')  return 'Windows';
  return 'Linux';
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function dayLabel(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function weekLabel(d: string): string {
  const dt = new Date(d);
  return `Week of ${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function monthLabel(d: string): string {
  return new Date(d + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ─── METRICS HELPERS ─────────────────────────────────────────────────────────

function topModel(sessions: SessionRecord[]): string {
  if (!sessions.length) return '—';
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    const m = s.model || 'unknown';
    counts[m] = (counts[m] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
}

function shortModel(m: string): string {
  if (!m || m === 'unknown') return '—';
  return m
    .replace(/^claude-/, '')
    .replace(/^google\//, '')
    .replace(/-latest$/, '')
    .replace(/-\d{3,}$/, '')   // strip trailing build numbers like -001, -002
    .slice(0, 22);
}

function classifyTask(
  prompt: string | undefined,
  tool?: string,
  turnCount?: number,
  projectName?: string,
): string {
  const p = (prompt || '').toLowerCase().trim();
  const proj = (projectName || '').toLowerCase();
  const t = (tool || '').toLowerCase();
  const turns = turnCount || 0;

  if (p.length > 3) {
    if (/\b(bug|fix|error|exception|crash|debug|broken|issue|fail|wrong|not work|undefined|null|traceback|stack trace|cannot|could not|doesn't work|doesn't compile|syntax error|type error|runtime|warning)\b/.test(p))
      return 'debugging';

    if (/\b(review|check this|look at this|feedback|suggest|improve|optimize|better way|best practice|is this correct|is this right|what do you think|any issues|code quality|clean up|cleanup|lgtm)\b/.test(p))
      return 'code_review';

    if (/\b(refactor|restructure|reorganize|rename|move|extract|simplify|rewrite|redesign|clean|decouple|modular|modularize|split|separate)\b/.test(p))
      return 'refactoring';

    if (/\b(test|spec|coverage|mock|unit|jest|pytest|assert|expect|integration|e2e|cypress|vitest|playwright|describe|it should|test case|test suite|tdd|bdd)\b/.test(p))
      return 'testing';

    if (/\b(document|readme|comment|docstring|jsdoc|wiki|changelog|docs|add docs|write docs|explain this code|what does this do|annotate|summarize)\b/.test(p))
      return 'documentation';

    if (/\b(config|setup|install|configure|settings|init|environment|env|deploy|docker|kubernetes|helm|ci|cd|pipeline|workflow|nginx|apache|database|db|connection|port|host|url|certificate|ssl|aws|gcp|azure|render|vercel)\b/.test(p))
      return 'configuration';

    if (/\b(architect|design|structure|pattern|approach|strategy|system design|how should|best approach|which approach|how to organize|folder structure|project structure|database schema|data model|api design|erd|uml)\b/.test(p))
      return 'architecture';

    if (/\b(what is|what are|how does|how do|explain|tell me|difference between|compare|pros and cons|when to use|which is better|learn|understand|overview|introduction|tutorial|help me understand|can you explain)\b/.test(p))
      return 'research';

    if (/\b(analyse|analyze|review|audit|assess|evaluate|performance|bottleneck|slow|memory leak|cpu usage|optimize|profil|metrics|monitoring|benchmark)\b/.test(p))
      return 'analysis';

    if (/\b(automate|automation|script|schedule|cron|workflow|pipeline|batch|process|scaffolding|boilerplate|generate)\b/.test(p))
      return 'automation';

    if (/\b(write|create|build|implement|add|make|new|function|class|component|module|feature|endpoint|api|route|model|schema|migration|service|controller|handler|hook|helper|utility|util|page|view|widget|button|form|table|chart|dashboard)\b/.test(p))
      return 'code_generation';
  }

  if (t === 'copilot')   return 'code_generation';
  if (t === 'cursor')    return 'code_generation';
  if (t === 'windsurf')  return 'code_generation';
  if (t === 'cline')     return 'code_generation';
  if (t === 'roo')       return 'code_generation';
  if (t === 'kilo')      return 'code_generation';
  if (t === 'codex')     return 'code_generation';
  if (t === 'gemini')    return 'research';
  if (t === 'pi')        return 'research';

  if (turns >= 50) return 'debugging';
  if (turns >= 20) return 'code_generation';
  if (turns >= 10) return 'analysis';
  if (turns >= 5)  return 'code_generation';
  if (turns >= 2)  return 'research';

  if (proj.includes('test'))    return 'testing';
  if (proj.includes('doc'))     return 'documentation';
  if (proj.includes('config'))  return 'configuration';
  if (proj.includes('setup'))   return 'configuration';
  if (proj.includes('deploy'))  return 'configuration';
  if (proj.includes('infra'))   return 'configuration';
  if (proj.includes('server'))  return 'code_generation';
  if (proj.includes('api'))     return 'code_generation';
  if (proj.includes('frontend'))return 'code_generation';
  if (proj.includes('backend')) return 'code_generation';
  if (proj.includes('aiops'))   return 'code_generation';
  if (proj.includes('dashboard'))return 'code_generation';

  return 'other';
}

function weekKey(date: string): 'W1' | 'W2' | 'W3' | 'W4' {
  const diffDays = Math.floor((Date.now() - new Date(date + 'T12:00:00Z').getTime()) / 86400000);
  if (diffDays < 7)  return 'W4';
  if (diffDays < 14) return 'W3';
  if (diffDays < 21) return 'W2';
  return 'W1';
}

function readinessScore(activeDays: number, avgTurns: number, categories: number, wowTrend: number, w1: number, abandonedPct: number): {
  total: number; engagement: number; depth: number; coverage: number; progression: number; friction: number;
} {
  const engagement =
    activeDays >= 20 ? 25 :
    activeDays >= 14 ? 18 :
    activeDays >= 7  ? 12 :
    activeDays >= 3  ? 6  : 2;

  const depth =
    avgTurns >= 15 ? 25 :
    avgTurns >= 10 ? 20 :
    avgTurns >= 5  ? 14 :
    avgTurns >= 2  ? 8  : 3;

  const coverage =
    categories >= 6 ? 20 :
    categories >= 4 ? 14 :
    categories >= 2 ? 8  : 3;

  const progression =
    w1 === 0      ? 8  :
    wowTrend > 50 ? 15 :
    wowTrend > 20 ? 12 :
    wowTrend > 0  ? 8  :
    wowTrend === 0? 5  : 2;

  const friction =
    abandonedPct < 10 ? 15 :
    abandonedPct < 20 ? 12 :
    abandonedPct < 35 ? 8  :
    abandonedPct < 50 ? 5  : 2;

  return { total: engagement + depth + coverage + progression + friction, engagement, depth, coverage, progression, friction };
}

// ─── EXTRA PATH DETECTION ────────────────────────────────────────────────────

interface ExtraToolInfo { label: string; pathKey: keyof typeof PATHS; }

const EXTRA_TOOLS: ExtraToolInfo[] = [
  { label: 'Claude Agent',       pathKey: 'claudeAgentSessions' },
  { label: 'Kiro',               pathKey: 'kiroAgent'            },
  { label: 'OpenCode',           pathKey: 'opencode'             },
  { label: 'OpenClaw',           pathKey: 'openclaw'             },
  { label: 'Goose',              pathKey: 'gooseDb'              },
  { label: 'Qwen',               pathKey: 'qwen'                 },
  { label: 'OMP',                pathKey: 'omp'                  },
  { label: 'Factory',            pathKey: 'factory'              },
];

// ─── SCAN COMMAND (full report) ───────────────────────────────────────────────

async function cmdScan(opts: { json?: boolean } = {}): Promise<void> {
  if (opts.json) {
    const report = runAnalysis();
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  openDb();
  const t0 = Date.now();
  const nowMs = Date.now();
  const cutoff28 = nowMs - 365 * 86400000; // Show all-time data to match server dashboard
  const todayStr = today();

  // 1. Run all adapters — deduplicate by (sessionId, tool) to match DB count
  const results = runAllAdapters();
  const _raw = results.flatMap(r => r.sessions);
  const _seen = new Set<string>();
  const allSessions = _raw.filter(s => {
    const key = `${s.sessionId}|${s.tool}`;
    if (_seen.has(key)) return false;
    _seen.add(key);
    return true;
  });

  // 2. Sessions in last 28 days
  const recent = allSessions.filter(s => !s.sessionTimestamp || s.sessionTimestamp >= cutoff28);

  if (allSessions.length === 0) {
    console.log();
    console.log(chalk.yellow('  No AI tool sessions found on this machine.'));
    console.log(chalk.gray('  Try using Claude Code, Gemini CLI, or Cursor first.'));
    console.log();
    return;
  }

  // ── ENGAGEMENT ──────────────────────────────────────────────────────────────
  const byWeek: Record<string, SessionRecord[]> = { W1: [], W2: [], W3: [], W4: [] };
  const activeDaysSet = new Set<string>();
  for (const s of recent) {
    if (s.sessionDate) {
      byWeek[weekKey(s.sessionDate)].push(s);
      activeDaysSet.add(s.sessionDate);
    }
  }
  const activeDays = activeDaysSet.size;
  const w1 = byWeek['W1'].length, w4 = byWeek['W4'].length;
  const wowTrend = w1 > 0 ? Math.round(((w4 - w1) / w1) * 100) : (w4 > 0 ? 100 : 0);

  // ── DEPTH ────────────────────────────────────────────────────────────────────
  const turns = recent.map(s => (s.userTurnCount ?? 0) + s.turnCount || s.turnCount);
  const avgTurns = turns.length ? Math.round((turns.reduce((a, b) => a + b, 0) / turns.length) * 10) / 10 : 0;
  const multiTurnRate = turns.length ? Math.round(turns.filter(t => t >= 5).length / turns.length * 100) : 0;
  const deepSessionRate = turns.length ? Math.round(turns.filter(t => t >= 10).length / turns.length * 100) : 0;
  const longestTurns = turns.length ? Math.max(...turns) : 0;
  const abandonedCount = turns.filter(t => t <= 2).length;
  const abandonedPct = turns.length ? Math.round(abandonedCount / turns.length * 100) : 0;

  // ── TASK CATEGORIES ──────────────────────────────────────────────────────────
  const catCounts: Record<string, number> = {};
  for (const s of recent) {
    const cat = classifyTask(
      s.firstPrompt,
      s.tool,
      s.turnCount,
      s.projectName,
    );
    catCounts[cat] = (catCounts[cat] ?? 0) + 1;
  }
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  const primaryUseCase = sortedCats[0]?.[0] ?? 'other';
  const distinctCats = Object.keys(catCounts).length;

  // ── TOKENS ───────────────────────────────────────────────────────────────────
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
  for (const s of recent) {
    totalInput      += s.inputTokens;
    totalOutput     += s.outputTokens;
    totalCacheRead  += s.cacheReadTokens;
    totalCacheWrite += s.cacheWriteTokens;
  }
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const totalCost   = recent.reduce((a, s) => a + s.costUSD, 0);

  // ── TIME BUCKETS ─────────────────────────────────────────────────────────────
  const cut7   = nowMs - 7  * 86400000;
  const cut30  = nowMs - 30 * 86400000;
  const cut365 = nowMs - 365 * 86400000;
  function bucket(sessions: SessionRecord[], from: number): SessionRecord[] {
    return sessions.filter(s => s.sessionTimestamp >= from);
  }
  const todaySessions = allSessions.filter(s => s.sessionDate === todayStr);
  const weekSessions  = bucket(allSessions, cut7);
  const monthSessions = bucket(allSessions, cut30);
  const yearSessions  = bucket(allSessions, cut365);
  function bucketStats(sess: SessionRecord[]) {
    const tok = sess.reduce((a, s) => a + s.totalTokens, 0);
    const cost = sess.reduce((a, s) => a + s.costUSD, 0);
    return { count: sess.length, tokens: tok, cost };
  }

  // ── MODELS ───────────────────────────────────────────────────────────────────
  const modelMap: Record<string, { count: number; cost: number; inputTokens: number; outputTokens: number; cacheTokens: number; hasEstimate: boolean }> = {};
  for (const s of recent) {
    const m = s.model || 'unknown';
    if (!modelMap[m]) modelMap[m] = { count: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, hasEstimate: false };
    modelMap[m].count++;
    modelMap[m].cost += s.costUSD;
    modelMap[m].inputTokens += s.inputTokens;
    modelMap[m].outputTokens += s.outputTokens;
    modelMap[m].cacheTokens += s.cacheReadTokens + s.cacheWriteTokens;
    if (s.tokenSource === 'estimate') modelMap[m].hasEstimate = true;
  }
  const sortedModels = Object.entries(modelMap).sort((a, b) => b[1].count - a[1].count);

  // ── PROJECTS ─────────────────────────────────────────────────────────────────
  const projMap: Record<string, { count: number; cost: number }> = {};
  for (const s of recent) {
    const p = s.projectName || 'unknown';
    if (!projMap[p]) projMap[p] = { count: 0, cost: 0 };
    projMap[p].count++;
    projMap[p].cost += s.costUSD;
  }
  const sortedProjects = Object.entries(projMap).sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);

  // ── READINESS ────────────────────────────────────────────────────────────────
  const rs = readinessScore(activeDays, avgTurns, distinctCats, wowTrend, w1, abandonedPct);

  // ── INSIGHTS ─────────────────────────────────────────────────────────────────
  const insights: Array<{ color: string; text: string }> = [];
  insights.push({ color: '🔵', text: `Primary use: ${primaryUseCase.replace(/_/g, ' ')} (${Math.round((catCounts[primaryUseCase] ?? 0) / (recent.length || 1) * 100)}% of sessions)` });
  if (abandonedPct >= 30) {
    insights.push({ color: '🟡', text: `${abandonedPct}% of sessions abandoned early — try longer prompts` });
  } else if (avgTurns < 5) {
    insights.push({ color: '🟡', text: `Average session depth is low (${avgTurns} turns) — explore multi-step workflows` });
  } else {
    insights.push({ color: '🟢', text: `Good session depth — avg ${avgTurns} turns per conversation` });
  }
  if (wowTrend > 10) {
    insights.push({ color: '🟢', text: `Usage growing week over week (+${wowTrend}%) — good adoption trend` });
  } else if (wowTrend < -10) {
    insights.push({ color: '🔴', text: `Usage declining week over week (${wowTrend}%) — check for friction` });
  } else if (distinctCats < 3) {
    insights.push({ color: '🟡', text: `Tool usage concentrated in few task types — try more use cases` });
  } else {
    insights.push({ color: '🔵', text: `Using AI for ${distinctCats} different task types — good diversity` });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // ══════════════════════════════════════════════════════════════
  // PRINT REPORT
  // ══════════════════════════════════════════════════════════════

  console.log();
  divider();
  console.log(`  ${chalk.bold.cyan('AIOps Agent')}  ${chalk.gray('v' + VERSION)}    ${chalk.white(dateStr)}    ${chalk.gray(platformName())}`);
  console.log(`  ${chalk.gray('Scanned in ' + elapsed + 's')}`);
  divider();

  // ── TOOLS DETECTED ───────────────────────────────────────────
  section('TOOLS DETECTED');

  const allToolCount   = results.reduce((a, r) => a + r.sessions.length, 0);
  const allToolCost    = results.reduce((a, r) => a + r.sessions.reduce((b, s) => b + s.costUSD, 0), 0);

  for (const r of results) {
    const count = r.sessions.length;
    const cost  = r.sessions.reduce((a, s) => a + s.costUSD, 0);
    const model = shortModel(topModel(r.sessions));
    if (r.installed || count > 0) {
      const sessionLabel = count === 1 ? '1 session ' : `${count} sessions`;
      console.log(
        `  ${chalk.green('✅')}  ${chalk.cyan(r.label.padEnd(16))} ${chalk.white(sessionLabel.padStart(12))}    ${chalk.yellow(fmtCost(cost).padStart(7))}    ${chalk.gray(model)}`
      );
    } else {
      console.log(`  ${chalk.red('❌')}  ${chalk.gray(r.label.padEnd(16))} ${chalk.gray('not installed')}`);
    }
  }

  // Extra tool detection (existence only)
  for (const et of EXTRA_TOOLS) {
    const p = PATHS[et.pathKey];
    if (p && fs.existsSync(p)) {
      console.log(`  ${chalk.green('✅')}  ${chalk.cyan(et.label.padEnd(16))} ${chalk.gray('detected')}`);
    }
  }

  console.log('  ' + chalk.gray('─'.repeat(51)));
  console.log(`      ${'Total'.padEnd(16)} ${String(allToolCount + ' sessions').padStart(12)}    ${chalk.bold.yellow(fmtCost(allToolCost).padStart(7))}`);

  // ── USAGE THIS MONTH ─────────────────────────────────────────
  section('USAGE BY PERIOD');

  const usageTable = new Table({
    head: [chalk.bold('Period'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });

  const { count: tc, tokens: tt, cost: tco } = bucketStats(todaySessions);
  const { count: wc, tokens: wt, cost: wco } = bucketStats(weekSessions);
  const { count: mc, tokens: mt, cost: mco } = bucketStats(monthSessions);
  const { count: yc, tokens: yt, cost: yco } = bucketStats(yearSessions);

  usageTable.push(
    [chalk.white('Today'),  tc || '—', fmtTokens(tt),  fmtCost(tco)],
    [chalk.white('Week'),   wc || '—', fmtTokens(wt),  fmtCost(wco)],
    [chalk.white('Month'),  mc || '—', fmtTokens(mt),  fmtCost(mco)],
    [chalk.white('Year'),   yc || '—', fmtTokens(yt),  fmtCost(yco)],
  );
  console.log(usageTable.toString());

  // ── TOKENS ───────────────────────────────────────────────────
  section('TOKENS');

  const tpad = 10;
  console.log(`  ${chalk.cyan('Input'.padEnd(14))}  ${chalk.white(fmtTokensFull(totalInput).padStart(tpad))}    ${chalk.gray('tokens sent to AI')}`);
  console.log(`  ${chalk.cyan('Output'.padEnd(14))}  ${chalk.white(fmtTokensFull(totalOutput).padStart(tpad))}    ${chalk.gray('tokens received from AI')}`);
  console.log(`  ${chalk.cyan('Cache'.padEnd(14))}  ${chalk.white(fmtTokensFull(totalCacheRead + totalCacheWrite).padStart(tpad))}    ${chalk.gray('tokens reused (saves money)')}`);
  console.log('  ' + chalk.gray('─'.repeat(49)));
  console.log(`  ${chalk.bold('Total').padEnd(14)}  ${chalk.bold.white(fmtTokensFull(totalTokens).padStart(tpad))}    ${chalk.gray('tokens total')}`);

  // ── WHAT YOU USE AI FOR ───────────────────────────────────────
  section('WHAT YOU USE AI FOR');

  for (const [cat, count] of sortedCats) {
    const pct = Math.round(count / (recent.length || 1) * 100);
    const label = cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).padEnd(18);
    const pctStr = (pct + '%').padStart(4);
    const countStr = chalk.gray(`${count} session${count === 1 ? '' : 's'}`);
    console.log(`  ${chalk.cyan(label)}  ${bar(pct)}  ${chalk.white(pctStr)}   ${countStr}`);
  }

  // ── MODELS USED ───────────────────────────────────────────────
  section('MODELS USED');

  for (const [model, { count, cost }] of sortedModels) {
    const pct = Math.round(count / (recent.length || 1) * 100);
    const sessionLabel = count === 1 ? '1 session ' : `${count} sessions`;
    console.log(
      `  ${chalk.cyan(shortModel(model).padEnd(24))}  ${chalk.white(sessionLabel.padStart(12))}    ${chalk.yellow(fmtCost(cost).padStart(7))}    ${chalk.gray(pct + '%')}`
    );
  }

  // ── MODEL COST BREAKDOWN ──────────────────────────────────────
  section('MODEL COST BREAKDOWN');

  const modelsSortedByCost = Object.entries(modelMap).sort((a, b) => b[1].cost - a[1].cost);
  let mbTotalInput = 0, mbTotalOutput = 0, mbTotalCache = 0, mbTotalCost = 0;
  for (const [, d] of modelsSortedByCost) {
    mbTotalInput  += d.inputTokens;
    mbTotalOutput += d.outputTokens;
    mbTotalCache  += d.cacheTokens;
    mbTotalCost   += d.cost;
  }
  const mbTotalTokensAll = mbTotalInput + mbTotalOutput + mbTotalCache;

  function fmtTokCol(n: number, est: boolean): string {
    return (est ? '~' : '') + n.toLocaleString('en-US');
  }
  function fmtCostCol(n: number, est: boolean): string {
    const s = '$' + n.toFixed(4);
    return est ? '~' + s : s;
  }

  const costBreakTable = new Table({
    head: [
      chalk.bold('Model'),
      chalk.bold('Input tokens'),
      chalk.bold('Output tokens'),
      chalk.bold('Cache tokens'),
      chalk.bold('Total tokens'),
      chalk.bold('Cost'),
      chalk.bold('Share'),
    ],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
  });

  for (const [model, d] of modelsSortedByCost) {
    const totalTok = d.inputTokens + d.outputTokens + d.cacheTokens;
    const sharePct = mbTotalCost > 0 ? (d.cost / mbTotalCost * 100) : 0;
    costBreakTable.push([
      chalk.cyan(model),
      fmtTokCol(d.inputTokens,  d.hasEstimate),
      fmtTokCol(d.outputTokens, d.hasEstimate),
      fmtTokCol(d.cacheTokens,  d.hasEstimate),
      fmtTokCol(totalTok,       d.hasEstimate),
      chalk.yellow(fmtCostCol(d.cost, d.hasEstimate)),
      sharePct.toFixed(1) + '%',
    ]);
  }

  costBreakTable.push([
    chalk.bold('TOTAL'),
    chalk.bold(mbTotalInput.toLocaleString('en-US')),
    chalk.bold(mbTotalOutput.toLocaleString('en-US')),
    chalk.bold(mbTotalCache.toLocaleString('en-US')),
    chalk.bold(mbTotalTokensAll.toLocaleString('en-US')),
    chalk.bold.yellow('$' + mbTotalCost.toFixed(4)),
    chalk.bold('100%'),
  ]);

  console.log(costBreakTable.toString());

  // ── TOP PROJECTS BY COST ──────────────────────────────────────
  if (sortedProjects.length > 0) {
    section('TOP PROJECTS BY COST');
    const maxCost = sortedProjects[0]?.[1].cost ?? 1;
    for (const [proj, { count, cost }] of sortedProjects) {
      const pct = Math.round(cost / (totalCost || 1) * 100);
      const sessionLabel = count === 1 ? '1 session ' : `${count} sessions`;
      console.log(
        `  ${chalk.cyan(proj.padEnd(20))}  ${chalk.yellow(fmtCost(cost).padStart(7))}    ${chalk.white(sessionLabel.padStart(12))}    ${chalk.gray(pct + '%')}`
      );
      void maxCost;
    }
  }

  // ── READINESS SCORE ───────────────────────────────────────────
  section('READINESS SCORE');

  const scoreBar = bar(rs.total, 26);
  console.log(`  ${chalk.bold.white(String(rs.total) + ' / 100')}   ${scoreBar}`);
  console.log();

  const scoreRows: Array<[string, number, number, string]> = [
    ['Engagement',   rs.engagement,  25, `${activeDays} active days`],
    ['Depth',        rs.depth,       25, `avg ${avgTurns} turns`],
    ['Coverage',     rs.coverage,    20, `${distinctCats} task types used`],
    ['Progression',  rs.progression, 15, w1 === 0 ? 'new user' : (wowTrend >= 0 ? 'usage growing' : 'usage declining')],
    ['Friction',     rs.friction,    15, `${abandonedPct}% abandoned`],
  ];
  for (const [label, score, max, note] of scoreRows) {
    const pct = Math.round(score / max * 100);
    console.log(`  ${chalk.cyan(label.padEnd(14))}  ${bar(pct, 13)}  ${chalk.white((score + '/' + max).padStart(6))}    ${chalk.gray(note)}`);
  }

  // ── PERSIST ──────────────────────────────────────────────────
  // Upsert all sessions into ~/.aiops/sessions.db so historical trending,
  // week-over-week comparisons, and budget tracking work across scans.
  console.log();
  divider();
  console.log();
  try {
    const persist = upsertSessions(allSessions);
    if (dbAvailable()) {
      console.log(`  ${chalk.bold.white('PERSISTED')}    ${chalk.gray(`${persist.inserted} new · ${persist.updated} updated · ${persist.seen} total in ${persist.durationMs}ms`)}`);

      // Budget alerts — only shown if user has configured limits
      const budgets = getBudgets();
      if (budgets.length) {
        console.log();
        for (const b of budgets) {
          const pct = Math.round(b.pctUsed);
          const colour = pct >= 100 ? chalk.red : pct >= 80 ? chalk.yellow : chalk.green;
          const label = b.period.charAt(0).toUpperCase() + b.period.slice(1);
          console.log(`  ${chalk.cyan('Budget · ' + label.padEnd(8))}  ${colour(fmtCost(b.spentUsd) + ' / ' + fmtCost(b.limitUsd))}  ${colour('(' + pct + '%)')}`);
        }
      }
    } else {
      console.log(`  ${chalk.bold.white('PERSISTED')}    ${chalk.yellow('DB unavailable')}  ${chalk.gray('· run: npm rebuild better-sqlite3')}`);
    }
  } catch (err) {
    void err; // logged inside db module
  }

  // ── FOOTER ───────────────────────────────────────────────────
  console.log();
  divider();

  // Save JSON report
  try {
    const report = buildJsonReport(results, recent, {
      activeDays, avgTurns, multiTurnRate, deepSessionRate, longestTurns,
      abandonedPct, distinctCats, primaryUseCase, wowTrend, w1,
      sortedCats, sortedModels, sortedProjects, rs,
      totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalTokens, totalCost,
    });
    const reportPath = path.join(process.cwd(), 'detection-report.json');
    const json = JSON.stringify(report, null, 2);
    fs.writeFileSync(reportPath, json, 'utf8');
    const kb = Math.round(json.length / 1024);
    console.log(`  ${chalk.gray('Report saved to')} ${chalk.cyan('detection-report.json')}  ${chalk.gray('(' + kb + ' KB)')}`);
  } catch {
    console.log(chalk.gray('  (Could not save detection-report.json)'));
  }

  console.log();
  divider();
  console.log();
}

function buildJsonReport(
  results: ToolResult[],
  recent: SessionRecord[],
  m: {
    activeDays: number; avgTurns: number; multiTurnRate: number; deepSessionRate: number;
    longestTurns: number; abandonedPct: number; distinctCats: number; primaryUseCase: string;
    wowTrend: number; w1: number;
    sortedCats: [string, number][]; sortedModels: [string, { count: number; cost: number }][];
    sortedProjects: [string, { count: number; cost: number }][];
    rs: { total: number; engagement: number; depth: number; coverage: number; progression: number; friction: number };
    totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheWrite: number;
    totalTokens: number; totalCost: number;
  }
): Record<string, unknown> {
  const byWeek: Record<string, number> = { W1: 0, W2: 0, W3: 0, W4: 0 };
  for (const s of recent) { if (s.sessionDate) byWeek[weekKey(s.sessionDate)]++; }

  const catBreakdown: Record<string, { count: number; pct: number }> = {};
  for (const [cat, count] of m.sortedCats) {
    catBreakdown[cat] = { count, pct: Math.round(count / (recent.length || 1) * 100) };
  }

  const toolsUsed: Record<string, number> = {};
  for (const r of results) { if (r.sessions.length) toolsUsed[r.label] = r.sessions.length; }

  const allDates = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const activeDaysSet = new Set(recent.map(s => s.sessionDate).filter(Boolean));
  const zeroSessionDays = allDates.filter(d => !activeDaysSet.has(d)).length;
  let longestGap = 0, cur = 0;
  for (const d of allDates.slice().reverse()) {
    if (!activeDaysSet.has(d)) { cur++; if (cur > longestGap) longestGap = cur; } else cur = 0;
  }

  return {
    report_generated: new Date().toISOString(),
    period: 'last_28_days',
    tools_detected: results.filter(r => r.sessions.length > 0).map(r => r.label),
    engagement: {
      total_sessions: recent.length,
      sessions_per_week: byWeek,
      active_days: m.activeDays,
      active_days_per_week: Math.round(m.activeDays / 4 * 10) / 10,
      total_user_prompts: recent.reduce((a, s) => a + (s.userTurnCount ?? 0), 0),
    },
    depth: {
      avg_turns_per_session: m.avgTurns,
      multi_turn_rate: m.multiTurnRate,
      deep_session_rate: m.deepSessionRate,
      longest_session_turns: m.longestTurns,
    },
    task_coverage: {
      task_category_breakdown: catBreakdown,
      primary_use_case: m.primaryUseCase,
      task_diversity_score: Math.round(m.distinctCats / 8 * 100),
    },
    progression: {
      week_over_week_trend: m.wowTrend,
      tools_used: toolsUsed,
      tool_diversity_count: Object.keys(toolsUsed).length,
    },
    friction: {
      abandoned_session_rate: m.abandonedPct,
      zero_session_days: zeroSessionDays,
      longest_gap_days: longestGap,
    },
    tokens: {
      input: m.totalInput,
      output: m.totalOutput,
      cache_read: m.totalCacheRead,
      cache_write: m.totalCacheWrite,
      total: m.totalTokens,
    },
    total_cost_usd: Math.round(m.totalCost * 1000) / 1000,
    readiness_score: m.rs.total,
    readiness_breakdown: {
      engagement: m.rs.engagement,
      depth: m.rs.depth,
      coverage: m.rs.coverage,
      progression: m.rs.progression,
      friction: m.rs.friction,
    },
    top_3_use_cases: m.sortedCats.slice(0, 3).map(([cat]) => cat),
    top_models: m.sortedModels.slice(0, 5).map(([model, { count, cost }]) => ({ model, sessions: count, cost_usd: Math.round(cost * 1000) / 1000 })),
    top_projects: m.sortedProjects.map(([project, { count, cost }]) => ({ project, sessions: count, cost_usd: Math.round(cost * 1000) / 1000 })),
  };
}

// ─── REPORT COMMAND ───────────────────────────────────────────────────────────

function cmdReport(opts: { w?: boolean; m?: boolean; y?: boolean }): void {
  const results = runAllAdapters();
  const allSessions = results.flatMap(r => r.sessions);
  if (opts.w) return reportWeekly(allSessions);
  if (opts.m) return reportMonthly(allSessions);
  if (opts.y) return reportYearly(allSessions);
  return reportToday(results);
}

function reportToday(results: ToolResult[]): void {
  const todayStr = today();
  const t = new Table({
    head: [chalk.bold('Tool'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });
  let totalSessions = 0, totalTokens = 0, totalCost = 0;
  for (const r of results) {
    const rows = r.sessions.filter(s => s.sessionDate === todayStr);
    if (!rows.length) continue;
    const tokens = rows.reduce((a, s) => a + s.totalTokens, 0);
    const cost   = rows.reduce((a, s) => a + s.costUSD, 0);
    totalSessions += rows.length; totalTokens += tokens; totalCost += cost;
    t.push([chalk.cyan(r.label), rows.length, fmtTokens(tokens), fmtCost(cost)]);
  }
  if (!totalSessions) t.push([chalk.gray('(no activity today)'), '—', '—', '—']);
  t.push([chalk.bold('Total'), chalk.bold(String(totalSessions || '—')), chalk.bold(fmtTokens(totalTokens)), chalk.bold.green(fmtCost(totalCost))]);
  console.log(chalk.bold.cyan('\n  Report — Today\n'));
  console.log(t.toString());
  console.log();
}

function reportWeekly(sessions: SessionRecord[]): void {
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    return d.toISOString().slice(0, 10);
  });
  const t = new Table({
    head: [chalk.bold('Day'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });
  let ts = 0, tt = 0, tc = 0;
  for (const day of last7) {
    const rows = sessions.filter(s => s.sessionDate === day);
    const tokens = rows.reduce((a, s) => a + s.totalTokens, 0);
    const cost   = rows.reduce((a, s) => a + s.costUSD, 0);
    ts += rows.length; tt += tokens; tc += cost;
    t.push([dayLabel(day), rows.length || '—', fmtTokens(tokens), fmtCost(cost)]);
  }
  t.push([chalk.bold('Total'), chalk.bold(String(ts || '—')), chalk.bold(fmtTokens(tt)), chalk.bold.green(fmtCost(tc))]);
  console.log(chalk.bold.cyan('\n  Report — Last 7 Days\n'));
  console.log(t.toString());
  console.log();
}

function reportMonthly(sessions: SessionRecord[]): void {
  const byWeek: Record<string, { sessions: number; tokens: number; cost: number }> = {};
  for (const s of sessions) {
    if (!s.sessionDate) continue;
    const d = new Date(s.sessionDate);
    const key = s.sessionDate.slice(0, 7) + '-W' + Math.floor(d.getDate() / 7);
    if (!byWeek[key]) byWeek[key] = { sessions: 0, tokens: 0, cost: 0 };
    byWeek[key].sessions++;
    byWeek[key].tokens += s.totalTokens;
    byWeek[key].cost   += s.costUSD;
  }
  const t = new Table({
    head: [chalk.bold('Week'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });
  let ts = 0, tt = 0, tc = 0;
  for (const [key, w] of Object.entries(byWeek).sort()) {
    ts += w.sessions; tt += w.tokens; tc += w.cost;
    const weekDate = key.replace(/-W\d$/, '') + '-' + String((parseInt(key.slice(-1)) * 7) + 1).padStart(2, '0');
    t.push([weekLabel(weekDate), w.sessions, fmtTokens(w.tokens), fmtCost(w.cost)]);
  }
  if (!ts) t.push([chalk.gray('(no data)'), '—', '—', '—']);
  t.push([chalk.bold('Total'), chalk.bold(String(ts || '—')), chalk.bold(fmtTokens(tt)), chalk.bold.green(fmtCost(tc))]);
  console.log(chalk.bold.cyan('\n  Report — Monthly\n'));
  console.log(t.toString());
  console.log();
}

function reportYearly(sessions: SessionRecord[]): void {
  const byMonth: Record<string, { sessions: number; tokens: number; cost: number }> = {};
  for (const s of sessions) {
    if (!s.sessionDate) continue;
    const mo = s.sessionDate.slice(0, 7);
    if (!byMonth[mo]) byMonth[mo] = { sessions: 0, tokens: 0, cost: 0 };
    byMonth[mo].sessions++;
    byMonth[mo].tokens += s.totalTokens;
    byMonth[mo].cost   += s.costUSD;
  }
  const t = new Table({
    head: [chalk.bold('Month'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });
  let ts = 0, tt = 0, tc = 0;
  for (const [mo, m] of Object.entries(byMonth).sort()) {
    ts += m.sessions; tt += m.tokens; tc += m.cost;
    t.push([monthLabel(mo), m.sessions, fmtTokens(m.tokens), fmtCost(m.cost)]);
  }
  if (!ts) t.push([chalk.gray('(no data)'), '—', '—', '—']);
  t.push([chalk.bold('Total'), chalk.bold(String(ts || '—')), chalk.bold(fmtTokens(tt)), chalk.bold.green(fmtCost(tc))]);
  console.log(chalk.bold.cyan('\n  Report — Yearly\n'));
  console.log(t.toString());
  console.log();
}

// ─── STATUS COMMAND ───────────────────────────────────────────────────────────

function cmdStatus(): void {
  const results = runAllAdapters();
  const allSessions = results.flatMap(r => r.sessions);
  const todayStr = today();
  const todaySessions = allSessions.filter(s => s.sessionDate === todayStr);
  const costToday = todaySessions.reduce((a, s) => a + s.costUSD, 0);
  const lastSession = allSessions.filter(s => s.sessionTimestamp > 0).sort((a, b) => b.sessionTimestamp - a.sessionTimestamp)[0];
  const dbOn = dbAvailable();
  const lastScan = dbOn ? getRecentScans(1)[0] : undefined;
  console.log();
  console.log(chalk.bold('Version       ') + VERSION);
  console.log(chalk.bold('Status        ') + chalk.green('running'));
  console.log(chalk.bold('OS            ') + process.platform + ' ' + os.release());
  console.log(chalk.bold('Total Sessions') + ' ' + (allSessions.length || '—'));
  console.log(chalk.bold('Cost Today    ') + (costToday > 0 ? chalk.green(fmtCost(costToday)) : '—'));
  console.log(chalk.bold('Last Session  ') + (lastSession ? fmtDate(lastSession.sessionTimestamp) : '—'));
  console.log(chalk.bold('Persistence   ') + (dbOn ? chalk.green('enabled') : chalk.yellow('unavailable — run: npm rebuild better-sqlite3')));
  if (dbOn) console.log(chalk.bold('DB Path       ') + chalk.gray(dbPath()));
  if (lastScan) console.log(chalk.bold('Last Scan     ') + fmtDate(lastScan.scannedAt) + chalk.gray(`  (${lastScan.sessionsNew} new)`));
  openDb();
  const dbStats = getDbStats();
  console.log(chalk.dim('  Database    ') + chalk.white('~/.aiops/sessions.db'));
  console.log(chalk.dim('  Stored      ') + chalk.white(dbStats.totalRows + ' sessions'));
  console.log(chalk.dim('  DB size     ') + chalk.white(dbStats.dbSizeKb + ' KB'));
  console.log(chalk.dim('  Oldest      ') + chalk.white(dbStats.oldestDate || 'no data'));

  const cfg = _loadConfig();
  console.log();
  if (cfg) {
    console.log(chalk.dim('  Server      ') + chalk.white(cfg.serverUrl));
    console.log(chalk.dim('  Enrolled    ') + chalk.white(cfg.enrolledAt?.slice(0, 10) || 'unknown'));
    console.log(chalk.dim('  Machine     ') + chalk.white(cfg.machineId));
  } else {
    console.log(chalk.dim('  Server      ') + chalk.yellow('not enrolled'));
    console.log(chalk.dim('  Run         ') + chalk.white('aiops enroll --server URL --token TOKEN'));
  }

  // Daemon status
  const daemonRunning  = isDaemonAlive();
  const autoStartOn    = isAutoStartInstalled();
  const daemonPid      = readDaemonPid();
  console.log();
  console.log(chalk.bold('Daemon        ') + (daemonRunning
    ? chalk.green(`running  (PID ${daemonPid})`)
    : chalk.yellow('stopped')));
  console.log(chalk.bold('Auto-start    ') + (autoStartOn
    ? chalk.green('enabled')
    : chalk.yellow('disabled — run: aiops install')));
  console.log();
}

// ─── TOKENS COMMAND ──────────────────────────────────────────────────────────

function cmdTokens(): void {
  const results = runAllAdapters();
  const sessions = results.flatMap(r => r.sessions);
  const t = new Table({
    head: [chalk.bold('Tool'), chalk.bold('Input'), chalk.bold('Output'), chalk.bold('Cache'), chalk.bold('Total')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'right'],
  });
  let ti = 0, to = 0, tc = 0, tt = 0;
  for (const r of results) {
    if (!r.sessions.length) continue;
    const inp  = r.sessions.reduce((a, s) => a + s.inputTokens, 0);
    const out  = r.sessions.reduce((a, s) => a + s.outputTokens, 0);
    const cache = r.sessions.reduce((a, s) => a + s.cacheReadTokens + s.cacheWriteTokens, 0);
    const total = r.sessions.reduce((a, s) => a + s.totalTokens, 0);
    ti += inp; to += out; tc += cache; tt += total;
    t.push([chalk.cyan(r.label), fmtTokens(inp), fmtTokens(out), fmtTokens(cache), fmtTokens(total)]);
  }
  t.push([chalk.bold('Total'), chalk.bold(fmtTokens(ti)), chalk.bold(fmtTokens(to)), chalk.bold(fmtTokens(tc)), chalk.bold(fmtTokens(tt))]);
  console.log(chalk.bold.cyan('\n  Token Breakdown\n'));
  console.log(t.toString());
  console.log();
}

// ─── COST COMMAND ────────────────────────────────────────────────────────────

function cmdCost(): void {
  const results = runAllAdapters();
  const t = new Table({
    head: [chalk.bold('Tool'), chalk.bold('Sessions'), chalk.bold('Cost'), chalk.bold('Avg/Session')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });
  let totalCost = 0, totalSessions = 0;
  for (const r of results) {
    if (!r.sessions.length) continue;
    const cost = r.sessions.reduce((a, s) => a + s.costUSD, 0);
    const avg  = cost / r.sessions.length;
    totalCost += cost; totalSessions += r.sessions.length;
    t.push([chalk.cyan(r.label), r.sessions.length, fmtCost(cost), fmtCost(avg)]);
  }
  const avgTotal = totalSessions ? totalCost / totalSessions : 0;
  t.push([chalk.bold('Total'), chalk.bold(String(totalSessions)), chalk.bold.green(fmtCost(totalCost)), chalk.bold(fmtCost(avgTotal))]);
  console.log(chalk.bold.cyan('\n  Cost Breakdown\n'));
  console.log(t.toString());
  console.log();
}

// ─── SESSIONS COMMAND ────────────────────────────────────────────────────────

function cmdSessions(): void {
  const results = runAllAdapters();
  const sessions = results.flatMap(r => r.sessions)
    .filter(s => s.sessionTimestamp > 0)
    .sort((a, b) => b.sessionTimestamp - a.sessionTimestamp)
    .slice(0, 15);
  const t = new Table({
    head: [chalk.bold('Date'), chalk.bold('Tool'), chalk.bold('Model'), chalk.bold('Turns'), chalk.bold('Tokens'), chalk.bold('Cost')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'left', 'left', 'right', 'right', 'right'],
  });
  for (const s of sessions) {
    t.push([
      s.sessionDate || '—',
      chalk.cyan(s.tool),
      chalk.gray(shortModel(s.model)),
      s.turnCount || '—',
      fmtTokens(s.totalTokens),
      fmtCost(s.costUSD),
    ]);
  }
  if (!sessions.length) t.push([chalk.gray('No sessions found'), '', '', '', '', '']);
  console.log(chalk.bold.cyan('\n  Recent Sessions\n'));
  console.log(t.toString());
  console.log();
}

// ─── SUMMARY COMMAND ─────────────────────────────────────────────────────────

async function cmdSummary(): Promise<void> { await cmdScan(); }

// ─── HISTORY COMMAND (uses persisted DB, not just current scan) ────────────────

function cmdHistory(opts: { weeks?: string; days?: string } = {}): void {
  if (!dbAvailable()) {
    console.log();
    console.log(chalk.yellow('  Persistence unavailable — run: npm rebuild better-sqlite3'));
    console.log(chalk.gray(`  Expected DB at: ${dbPath()}`));
    console.log();
    return;
  }

  if (opts.days) {
    const days = parseInt(opts.days, 10);
    if (!isNaN(days) && days > 0) return showDailyHistory(days);
  }
  const weeks = parseInt(opts.weeks ?? '8', 10);
  return showWeeklyHistory(isNaN(weeks) || weeks <= 0 ? 8 : weeks);
}

function showDailyHistory(days: number): void {
  const rows = getDailyTotals(days);
  const t = new Table({
    head: [chalk.bold('Date'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });
  let ts = 0, tt = 0, tc = 0;
  for (const r of rows) {
    ts += r.sessions; tt += r.tokens; tc += r.cost;
    t.push([dayLabel(r.date), r.sessions, fmtTokens(r.tokens), fmtCost(r.cost)]);
  }
  if (!rows.length) t.push([chalk.gray('(no persisted history yet — run aiops scan)'), '', '', '']);
  t.push([chalk.bold('Total'), chalk.bold(String(ts || '—')), chalk.bold(fmtTokens(tt)), chalk.bold.green(fmtCost(tc))]);
  console.log(chalk.bold.cyan(`\n  History — Last ${days} Days (persisted)\n`));
  console.log(t.toString());
  console.log();
}

function showWeeklyHistory(weeks: number): void {
  const rows = getWeeklyTotals(weeks);
  const t = new Table({
    head: [chalk.bold('Week starting'), chalk.bold('Sessions'), chalk.bold('Tokens'), chalk.bold('Cost'), chalk.bold('WoW Δ')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'right'],
  });
  let prevCost = 0;
  let ts = 0, tt = 0, tc = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    ts += r.sessions; tt += r.tokens; tc += r.cost;
    let delta = '—';
    if (i > 0 && prevCost > 0) {
      const pct = ((r.cost - prevCost) / prevCost) * 100;
      const sign = pct >= 0 ? '+' : '';
      const colour = pct >= 0 ? chalk.green : chalk.red;
      delta = colour(`${sign}${pct.toFixed(0)}%`);
    }
    t.push([r.weekStart, r.sessions, fmtTokens(r.tokens), fmtCost(r.cost), delta]);
    prevCost = r.cost;
  }
  if (!rows.length) t.push([chalk.gray('(no persisted history yet — run aiops scan)'), '', '', '', '']);
  t.push([chalk.bold('Total'), chalk.bold(String(ts || '—')), chalk.bold(fmtTokens(tt)), chalk.bold.green(fmtCost(tc)), '']);
  console.log(chalk.bold.cyan(`\n  History — Last ${weeks} Weeks (persisted)\n`));
  console.log(t.toString());
  console.log();
}

// ─── BUDGET COMMAND ──────────────────────────────────────────────────────────

function cmdBudget(opts: { set?: string; daily?: string; weekly?: string; monthly?: string } = {}): void {
  if (!dbAvailable()) {
    console.log(chalk.yellow('\n  Persistence unavailable — run: npm rebuild better-sqlite3\n'));
    return;
  }

  let updated = false;
  if (opts.daily)   { setBudget('daily',   parseFloat(opts.daily));   updated = true; }
  if (opts.weekly)  { setBudget('weekly',  parseFloat(opts.weekly));  updated = true; }
  if (opts.monthly) { setBudget('monthly', parseFloat(opts.monthly)); updated = true; }
  if (opts.set) {
    const m = opts.set.match(/^(daily|weekly|monthly)=([\d.]+)$/);
    if (m) { setBudget(m[1] as 'daily' | 'weekly' | 'monthly', parseFloat(m[2]!)); updated = true; }
    else   { console.log(chalk.red(`\n  Invalid --set value. Use --set daily=5 or --set monthly=200.\n`)); return; }
  }

  const budgets = getBudgets();
  console.log();
  if (updated) console.log(chalk.green('  Budget updated.\n'));

  if (!budgets.length) {
    console.log(chalk.gray('  No budgets configured.'));
    console.log(chalk.gray('  Set one with: aiops budget --daily 5 --weekly 25 --monthly 100\n'));
    return;
  }

  const t = new Table({
    head: [chalk.bold('Period'), chalk.bold('Limit'), chalk.bold('Spent'), chalk.bold('Used'), chalk.bold('Status')],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right', 'left'],
  });
  for (const b of budgets) {
    const pct = Math.round(b.pctUsed);
    const status = pct >= 100 ? chalk.red('OVER BUDGET') :
                   pct >= 80  ? chalk.yellow('approaching') :
                                chalk.green('on track');
    t.push([chalk.cyan(b.period), fmtCost(b.limitUsd), fmtCost(b.spentUsd), pct + '%', status]);
  }
  console.log(chalk.bold.cyan('  Budgets\n'));
  console.log(t.toString());
  console.log();
}

// ─── DAILY / WEEKLY / MONTHLY ────────────────────────────────────────────────

function cmdDaily():   void { cmdReport({}); }
function cmdWeekly():  void { cmdReport({ w: true }); }
function cmdMonthly(): void { cmdReport({ m: true }); }

// ─── LOGS COMMAND ────────────────────────────────────────────────────────────

function cmdLogs(): void {
  const lines = readLastLines(20);
  console.log();
  if (!lines.length) {
    console.log(chalk.green('  No errors logged.'));
    console.log(chalk.gray(`  Log file: ${logFilePath()}`));
  } else {
    console.log(chalk.bold.cyan('  Last error log entries\n'));
    for (const line of lines) console.log(chalk.gray('  ' + line));
    console.log();
    console.log(chalk.gray(`  Log file: ${logFilePath()}`));
  }
  console.log();
}

// ─── ANALYZE COMMAND ─────────────────────────────────────────────────────────

function cmdAnalyze(opts: { output?: string }): void {
  console.error(chalk.gray('Scanning AI tool session data...'));
  const report = runAnalysis();
  const json = JSON.stringify(report, null, 2);
  if (opts.output) {
    fs.writeFileSync(opts.output, json, 'utf8');
    console.error(chalk.green(`Report written to ${opts.output}`));
  } else {
    console.log(json);
  }
}

// ─── START COMMAND (master one-shot) ─────────────────────────────────────────

async function cmdStart(): Promise<void> {
  console.log();
  divider();
  console.log(`  ${chalk.bold.cyan('AIOps Start')}  ${chalk.gray('v' + VERSION)}    ${chalk.white(new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}`);
  divider();
  console.log();

  // ── Step 1: Check enrollment ──────────────────────────────────────────────
  const enrolled = isEnrolled();
  const config = _loadConfig();
  if (enrolled && config?.serverUrl) {
    console.log(chalk.green(`  ✅ Already enrolled with ${config.serverUrl}`));
    console.log();
  } else {
    console.log(chalk.yellow('  ⚠ Not enrolled yet.'));
    console.log(chalk.dim('  To connect to company server run:'));
    console.log(chalk.dim('  aiops enroll --server YOUR-SERVER-URL --token YOUR-TOKEN'));
    console.log();
    console.log(chalk.dim('  Continuing in local-only mode...'));
    console.log();
  }

  // ── Step 2: Scan ──────────────────────────────────────────────────────────
  let sessionCount = 0;
  try {
    console.log(chalk.white('  Scanning your machine for AI tool usage...'));
    console.log();
    await cmdScan();
    try {
      openDb();
      const stats = getDbStats();
      sessionCount = stats.totalRows;
    } catch { /* db may be unavailable */ }
    console.log(chalk.green(`  ✅ ${sessionCount} sessions saved to local database`));
    console.log();
  } catch (err) {
    console.log(chalk.yellow('  ⚠ Scan step failed: ' + (err as Error).message));
    console.log();
  }

  // ── Step 3: Sync to server ────────────────────────────────────────────────
  let syncOk = false;
  if (enrolled) {
    try {
      console.log(chalk.white('  Syncing data to company server...'));
      // Send the FULL local history (not just 28 days) so the server matches
      // the local session count — the server upserts cumulatively, so
      // re-sending old days is safe and idempotent.
      const result = await syncToServer(FULL_HISTORY_DAYS, false);
      if (result.success) {
        syncOk = true;
        console.log(chalk.green('  ✅ Data synced to server'));
      } else {
        console.log(chalk.yellow('  ⚠ Sync failed — data saved locally, will retry next time'));
      }
    } catch {
      console.log(chalk.yellow('  ⚠ Sync failed — data saved locally, will retry next time'));
    }
    console.log();
  } else {
    console.log(chalk.dim('  ℹ Running in local-only mode (not connected to server)'));
    console.log();
  }

  // ── Step 4: Show history ──────────────────────────────────────────────────
  try {
    console.log(chalk.white('  Loading history from local database...'));
    console.log();
    openDb();
    const summary = getHistoricalSummary(28);

    if (summary.totalSessions === 0) {
      console.log(chalk.yellow('  No history yet.'));
    } else {
      console.log(chalk.bold('  History — Last 28 Days\n'));

      const dayTable = new Table({ head: ['Date', 'Sessions', 'Tokens', 'Cost'], style: { head: ['dim'] } });
      for (const row of summary.byDay) {
        dayTable.push([row.date, String(row.sessions), fmtTokens(row.tokens), fmtCost(row.costUsd)]);
      }
      console.log(dayTable.toString());

      console.log(chalk.bold('\n  Week over Week\n'));
      const weekTable = new Table({ head: ['Week', 'Sessions', 'Tokens', 'Cost'], style: { head: ['dim'] } });
      for (const row of summary.byWeek) {
        weekTable.push([
          row.week,
          row.sessions > 0 ? String(row.sessions) : '—',
          row.tokens   > 0 ? fmtTokens(row.tokens) : '—',
          row.costUsd  > 0 ? fmtCost(row.costUsd)  : '—',
        ]);
      }
      console.log(weekTable.toString());

      console.log(chalk.bold('\n  By Tool\n'));
      const toolTable = new Table({ head: ['Tool', 'Sessions', 'Tokens', 'Cost'], style: { head: ['dim'] } });
      for (const row of summary.byTool) {
        toolTable.push([row.tool, String(row.sessions), fmtTokens(row.tokens), fmtCost(row.costUsd)]);
      }
      console.log(toolTable.toString());
    }
    console.log();
  } catch (err) {
    console.log(chalk.yellow('  ⚠ History step failed: ' + (err as Error).message));
    console.log();
  }

  // ── Step 5: Final status ──────────────────────────────────────────────────
  divider();
  console.log();
  console.log('    ' + chalk.bold.white('Done!'));
  console.log();
  console.log('    ' + chalk.dim('Local DB:   ') + chalk.white(sessionCount + ' sessions stored'));
  const serverLine = enrolled && config?.serverUrl
    ? (syncOk
        ? chalk.green(`✅ connected to ${config.serverUrl}`)
        : chalk.yellow('⚠ sync failed - check server'))
    : chalk.gray('not connected (local only)');
  console.log('    ' + chalk.dim('Server:     ') + serverLine);
  console.log('    ' + chalk.dim('Next step:  ') + chalk.white('run aiops start anytime to update'));
  console.log();
  divider();
  console.log();
}

// ─── WATCH COMMAND (continuous scan + sync) ──────────────────────────────────

async function watchTick(): Promise<void> {
  const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  try {
    openDb();
    const liveSessions = runAllAdapters().flatMap(r => r.sessions);
    if (liveSessions.length) upsertSessions(liveSessions);
    const total = dbAvailable() ? getDbStats().totalRows : liveSessions.length;

    if (isEnrolled()) {
      const result = await syncToServer(FULL_HISTORY_DAYS, false);
      if (result.success) {
        console.log(chalk.gray(`  [${ts}] `) + chalk.green('✓') + chalk.white(` ${total} sessions — synced ${result.aggregatesSent} aggregates (${result.daysIncluded} days)`));
      } else {
        console.log(chalk.gray(`  [${ts}] `) + chalk.yellow('⚠') + chalk.white(` ${total} sessions — sync failed: ${result.error ?? 'unknown'}`));
      }
    } else {
      console.log(chalk.gray(`  [${ts}] `) + chalk.white(`${total} sessions saved locally`) + chalk.dim(' (not enrolled — no sync)'));
    }
  } catch (err) {
    console.log(chalk.gray(`  [${ts}] `) + chalk.yellow('⚠ tick failed: ' + (err as Error).message));
  }
}

async function cmdWatch(opts: { interval?: string }): Promise<void> {
  const minutes = Math.max(1, parseInt(opts.interval ?? '5') || 5);
  console.log();
  console.log(`  ${chalk.bold.cyan('AIOps Watch')}  ${chalk.gray('v' + VERSION)}`);
  console.log(chalk.dim(`  Scanning + syncing every ${minutes} min. Press Ctrl+C to stop.`));
  console.log();

  await watchTick();
  setInterval(() => { void watchTick(); }, minutes * 60_000);
}

// ─── CLI SETUP ────────────────────────────────────────────────────────────────

program.name('aiops').version(VERSION).description('Monitor AI coding tool usage and costs');

program.command('start')
  .description('Scan, save and sync everything (recommended)')
  .action(() => cmdStart());

program.command('watch')
  .description('Keep scanning and syncing to the server continuously (real-time mode)')
  .option('-i, --interval <minutes>', 'minutes between scans', '5')
  .action((opts: { interval?: string }) => cmdWatch(opts));

program.command('scan')
  .description('Scan AI tools on this machine')
  .option('--json', 'Output machine-readable JSON instead of formatted report')
  .action((opts: { json?: boolean }) => cmdScan(opts));

program.command('summary').description('Alias for scan').action(cmdSummary);

program.command('report')
  .description('Show usage report (default: today)')
  .option('-w, --weekly',  'Weekly report')
  .option('-m, --monthly', 'Monthly report')
  .option('-y, --yearly',  'Yearly report')
  .action((opts: { weekly?: boolean; monthly?: boolean; yearly?: boolean }) => {
    cmdReport({ w: opts.weekly, m: opts.monthly, y: opts.yearly });
  });

program.command('tokens').description('Show token breakdown by tool').action(cmdTokens);
program.command('cost').description('Show cost breakdown by tool').action(cmdCost);
program.command('sessions').description('List recent sessions').action(cmdSessions);
program.command('daily').description('Today\'s usage').action(cmdDaily);
program.command('weekly').description('Last 7 days usage').action(cmdWeekly);
program.command('monthly').description('Monthly usage').action(cmdMonthly);
program.command('status').description('Show agent status').action(cmdStatus);
program.command('logs').description('Show error logs').action(cmdLogs);

program.command('analyze')
  .description('Run AI adoption analyst scan and output JSON report')
  .option('-o, --output <file>', 'Write JSON report to file')
  .action((opts: { output?: string }) => cmdAnalyze(opts));

program.command('history')
  .description('Show usage history')
  .option('--days <n>', 'number of days to show', '28')
  .action((opts: { days?: string }) => {
    openDb();
    if (!dbAvailable()) {
      console.log(chalk.yellow('\n  Persistence unavailable — run: npm rebuild better-sqlite3'));
      console.log(chalk.gray(`  Expected DB at: ${dbPath()}\n`));
      return;
    }
    const liveSessions = runAllAdapters().flatMap(r => r.sessions);
    if (liveSessions.length) upsertSessions(liveSessions);
    const days = parseInt(opts.days ?? '28') || 28;
    const summary = getHistoricalSummary(days);

    if (summary.totalSessions === 0) {
      console.log(chalk.yellow('\n  No history yet. Run aiops scan first.\n'));
      return;
    }

    console.log(chalk.bold(`\n  History — Last ${days} Days\n`));

    const dayTable = new Table({
      head: ['Date', 'Sessions', 'Tokens', 'Cost'],
      style: { head: ['dim'] },
    });
    for (const row of summary.byDay) {
      dayTable.push([row.date, String(row.sessions), fmtTokens(row.tokens), fmtCost(row.costUsd)]);
    }
    console.log(dayTable.toString());

    console.log(chalk.bold('\n  Week over Week\n'));
    const weekTable = new Table({
      head: ['Week', 'Sessions', 'Tokens', 'Cost'],
      style: { head: ['dim'] },
    });
    for (const row of summary.byWeek) {
      weekTable.push([
        row.week,
        row.sessions > 0 ? String(row.sessions) : '—',
        row.tokens   > 0 ? fmtTokens(row.tokens) : '—',
        row.costUsd  > 0 ? fmtCost(row.costUsd)  : '—',
      ]);
    }
    console.log(weekTable.toString());

    console.log(chalk.bold('\n  By Tool\n'));
    const toolTable = new Table({
      head: ['Tool', 'Sessions', 'Tokens', 'Cost'],
      style: { head: ['dim'] },
    });
    for (const row of summary.byTool) {
      toolTable.push([row.tool, String(row.sessions), fmtTokens(row.tokens), fmtCost(row.costUsd)]);
    }
    console.log(toolTable.toString());
    console.log();
  });

program.command('budget')
  .description('Configure or view spending budgets (uses persisted DB)')
  .option('--daily <usd>',   'Set daily budget in USD')
  .option('--weekly <usd>',  'Set weekly budget in USD')
  .option('--monthly <usd>', 'Set monthly budget in USD')
  .option('--set <kv>',      'Set via "period=usd" (e.g. --set monthly=100)')
  .action((opts: { daily?: string; weekly?: string; monthly?: string; set?: string }) => cmdBudget(opts));

program.command('serve')
  .description('Start local API server')
  .option('-p, --port <number>', 'Port to listen on (default: 3001)', '3001')
  .action((opts: { port?: string }) => {
    const port = parseInt(opts.port ?? '3001', 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number. Use a value between 1 and 65535.');
      process.exit(1);
    }
    startServer(port);
  });

program
  .command('enroll')
  .description('Connect to company server with your work email')
  .requiredOption('--server <url>', 'Company server URL')
  .option('--email <email>', 'Work email address (prompted if omitted)')
  .action(async (opts: { server: string; email?: string }) => {
    const { createInterface } = await import('readline');

    function prompt(question: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise(resolve => {
        rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
      });
    }

    const serverUrl = opts.server.replace(/\/$/, '');
    const machineId = getMachineId();
    const TIMEOUT_MS = 90_000;

    async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
      for (let i = 1; i <= retries; i++) {
        try {
          return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (e) {
          if (i === retries) throw e;
          console.log(chalk.dim(`  Server waking up... retrying (${i}/${retries - 1})`));
        }
      }
      throw new Error('unreachable');
    }

    console.log(chalk.bold('\n  Elliot AIOps — Device Enrollment\n'));

    // Step 1: get email
    const email = opts.email || await prompt('  Work email: ');
    if (!email.includes('@')) {
      console.error(chalk.red('  Invalid email address'));
      process.exit(1);
    }

    // Step 2: authenticate with email -> enrollment_token
    let enrollmentToken = '';
    try {
      const authRes = await fetchWithRetry(serverUrl + '/enroll/email-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!authRes.ok) {
        const err = await authRes.json().catch(() => ({})) as Record<string, unknown>;
        const msg = String(err['error'] ?? authRes.status);
        if (msg === 'domain_not_allowed') {
          console.error(chalk.red('  Your email domain is not registered. Contact your admin.'));
        } else {
          console.error(chalk.red('  Enrollment failed: ' + msg));
        }
        process.exit(1);
      }
      const body = await authRes.json() as { enrollment_token: string };
      enrollmentToken = body.enrollment_token;
    } catch (e) {
      console.error(chalk.red('  Server unreachable after 3 attempts: ' + String(e)));
      process.exit(1);
    }

    // Step 3: register device -> api_token
    let apiToken = '';
    try {
      const enrollRes = await fetchWithRetry(serverUrl + '/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollment_token: enrollmentToken,
          machine_id:       machineId,
          hostname:         os.hostname(),
          os:               process.platform,
        }),
      });
      if (!enrollRes.ok) {
        const err = await enrollRes.json().catch(() => ({})) as Record<string, unknown>;
        console.error(chalk.red('  Device registration failed: ' + String(err['error'] ?? enrollRes.status)));
        process.exit(1);
      }
      const body = await enrollRes.json() as { api_token: string };
      apiToken = body.api_token;
    } catch (e) {
      console.error(chalk.red('  Server error during enrollment: ' + String(e)));
      process.exit(1);
    }

    saveConfig({
      serverUrl,
      enrollmentToken: apiToken,
      machineId,
      enrolledAt: new Date().toISOString(),
    });

    console.log(chalk.green('\n  Enrolled successfully\n'));
    console.log(chalk.dim('  Server   ') + chalk.white(serverUrl));
    console.log(chalk.dim('  Machine  ') + chalk.white(machineId));
    console.log(chalk.dim('  Token    ') + chalk.white(apiToken.slice(0, 8) + '...'));
    console.log();
    console.log(chalk.dim('  Run aiops sync to send your data'));
    console.log();
  });
program
  .command('sync')
  .description('Send data to company server')
  .option('--days <n>', 'How many days of data to send (default: full history)', String(FULL_HISTORY_DAYS))
  .option('--dry-run', 'Preview what would be sent without sending')
  .action(async (opts: { days?: string; dryRun?: boolean }) => {
    if (!isEnrolled()) {
      console.log(chalk.yellow('\n  Not enrolled yet.'));
      console.log(chalk.dim('  Run: aiops enroll --server URL --token TOKEN\n'));
      return;
    }

    const days   = parseInt(opts.days ?? String(FULL_HISTORY_DAYS)) || FULL_HISTORY_DAYS;
    const dryRun = !!opts.dryRun;

    // Refresh the local DB with the latest live session data so sync is
    // always up-to-date without requiring a separate `aiops scan` first.
    openDb();
    const liveSessions = runAllAdapters().flatMap(r => r.sessions);
    if (liveSessions.length) upsertSessions(liveSessions);

    if (dryRun) {
      console.log(chalk.bold('\n  DRY RUN — nothing will be sent\n'));
    } else {
      console.log(chalk.bold('\n  Syncing to server...\n'));
    }

    const result = await syncToServer(days, dryRun);

    if (dryRun && result.preview) {
      console.log(chalk.dim(`  Would send ${result.preview.length} aggregate rows\n`));
      const t = new Table({
        head: ['Date', 'Tool', 'Model', 'Category', 'Sessions', 'Tokens', 'Cost'],
        style: { head: ['dim'] },
      });
      for (const row of result.preview.slice(0, 20)) {
        t.push([
          row.date,
          row.tool,
          row.model.slice(0, 20),
          row.category,
          String(row.sessions),
          fmtTokens(row.input_tokens + row.output_tokens),
          fmtCost(row.cost_usd),
        ]);
      }
      console.log(t.toString());
      console.log(chalk.dim('\n  Run without --dry-run to actually send\n'));
      return;
    }

    if (!result.success) {
      console.log(chalk.red('\n  ✗ Sync failed'));
      console.log(chalk.dim('  ' + result.error));
      console.log();
      return;
    }

    console.log(chalk.green('  ✅ Sync complete\n'));
    console.log(chalk.dim('  Sent        ') + result.aggregatesSent + ' aggregate rows');
    console.log(chalk.dim('  Days        ') + result.daysIncluded + ' days included');
    console.log(chalk.dim('  No prompts  ') + 'raw text never leaves your machine');
    console.log();
  });

// ─── UPDATE COMMAND (pull latest & reinstall) ────────────────────────────────

async function cmdUpdate(): Promise<void> {
  console.log();
  divider();
  console.log(`  ${chalk.bold.cyan('AIOps Update')}  ${chalk.gray('Pulling latest version...')}`);
  divider();
  console.log();

  try {
    const { execSync } = await import('child_process');

    // Try multiple sources to find the git repo
    let repoRoot: string | null = null;
    const candidates = [
      process.env.AIOPS_REPO,
      path.join(os.homedir(), 'Desktop', 'aiops-server', 'aiops-agent'),
      path.join(os.homedir(), 'projects', 'aiops-server', 'aiops-agent'),
      path.join(os.homedir(), 'src', 'aiops-server', 'aiops-agent'),
      path.join(os.homedir(), 'aiops-server', 'aiops-agent'),
      process.cwd(),
      process.argv[1] ? path.dirname(process.argv[1]) : undefined,
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (!fs.existsSync(candidate)) continue;

      let searchDir = candidate;
      for (let i = 0; i < 5; i++) {
        const pkgPath = path.join(searchDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
          if (pkg.name === 'aiops-agent') {
            repoRoot = searchDir;
            break;
          }
        }
        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
      }
      if (repoRoot) break;
    }

    if (!repoRoot) {
      console.log(chalk.yellow('  ⚠ Could not find aiops-agent repository'));
      console.log();
      console.log(chalk.gray('  Set the repository path with:'));
      console.log(chalk.white('    export AIOPS_REPO=/path/to/aiops-server/aiops-agent'));
      console.log();
      console.log(chalk.gray('  Then run: aiops update'));
      console.log();
      console.log(chalk.gray('  Or for npm installations, run: npm install -g aiops-agent@latest'));
      console.log();
      return;
    }

    const gitRoot = path.dirname(repoRoot);

    if (!fs.existsSync(path.join(gitRoot, '.git'))) {
      console.log(chalk.yellow('  ⚠ Not a git repository at: ' + gitRoot));
      console.log(chalk.gray('  Install from npm instead: npm install -g aiops-agent@latest'));
      console.log();
      return;
    }

    console.log(chalk.dim(`  Repository: ${repoRoot}`));
    console.log();

    console.log(chalk.white('  Pulling latest changes from main branch...'));
    try {
      execSync('git pull origin main', {
        cwd: gitRoot,
        stdio: 'pipe',
      });
      console.log(chalk.green('  ✅ Latest code pulled'));
    } catch (e) {
      console.log(chalk.yellow('  ⚠ Could not pull changes: ' + (e instanceof Error ? e.message : String(e))));
      console.log(chalk.gray('  You may be offline or have uncommitted changes'));
    }

    console.log(chalk.white('  Building the latest version...'));
    try {
      execSync('npm run build', {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      console.log(chalk.green('  ✅ Built successfully'));
    } catch (e) {
      console.log(chalk.red('  ✗ Build failed: ' + (e instanceof Error ? e.message : String(e))));
      console.log();
      divider();
      console.log();
      return;
    }

    console.log(chalk.white('  Installing globally...'));
    try {
      execSync('npm install -g . --force', {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      console.log(chalk.green('  ✅ Installed successfully'));
    } catch (e) {
      console.log(chalk.red('  ✗ Install failed: ' + (e instanceof Error ? e.message : String(e))));
      console.log();
      divider();
      console.log();
      return;
    }

    console.log();
    divider();
    console.log();
    console.log('  ' + chalk.bold.white('Update complete!'));
    console.log('  ' + chalk.dim('Run: aiops scan to verify'));
    console.log();
    divider();
    console.log();
  } catch (err) {
    console.log(chalk.red('  ✗ Update failed: ' + (err instanceof Error ? err.message : String(err))));
    console.log();
    divider();
    console.log();
  }
}

// ─── DAEMON COMMAND ──────────────────────────────────────────────────────────

program.command('daemon')
  .description('Run background sync daemon (normally started automatically by the OS)')
  .action(async () => {
    await startDaemon();
  });

// ─── INSTALL / UNINSTALL ─────────────────────────────────────────────────────

program.command('update')
  .description('Update aiops-agent to the latest version from git repository')
  .action(async () => {
    await cmdUpdate();
  });

program.command('install')
  .description('Register daemon to auto-start at login (Mac: launchd | Windows: Task Scheduler | Linux: systemd)')
  .action(async () => {
    console.log();
    divider();
    console.log(`  ${chalk.bold.cyan('AIOps Install')}  ${chalk.gray('Setting up auto-start...')}`);
    divider();
    console.log();

    // Stop any running daemon first so the new registration takes effect cleanly
    if (isDaemonAlive()) {
      console.log(chalk.dim('  Stopping existing daemon...'));
      stopDaemon();
      await new Promise(r => setTimeout(r, 800));
    }

    const result = installAutoStart();
    if (result.ok) {
      console.log(chalk.green(`  ✅ ${result.message}`));
      console.log();
      console.log(chalk.dim(`  Method:  ${result.method}`));
      console.log(chalk.dim(`  Trigger: on login + immediately`));
      console.log(chalk.dim(`  Sync:    ~2 min after each session ends, plus every 15 min`));
      console.log(chalk.dim(`  Logs:    ${DAEMON_LOG}`));
    } else {
      console.log(chalk.red(`  ✗ ${result.message}`));
    }
    console.log();
    divider();
    console.log();
  });

program.command('uninstall')
  .description('Remove auto-start registration and stop the daemon')
  .action(async () => {
    console.log();

    if (isDaemonAlive()) {
      console.log(chalk.dim('  Stopping daemon...'));
      stopDaemon();
      await new Promise(r => setTimeout(r, 800));
    }

    const result = uninstallAutoStart();
    if (result.ok) {
      console.log(chalk.green(`  ✅ ${result.message}`));
    } else {
      console.log(chalk.red(`  ✗ ${result.message}`));
    }
    console.log();
  });

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red('Error: ' + (err as Error).message));
  process.exit(1);
});
