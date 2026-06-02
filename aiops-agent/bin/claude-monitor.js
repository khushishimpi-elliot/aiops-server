#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import os from 'os';
import path from 'path';

import { getAllSessionFiles, readSessionFile, getFileMtime } from '../src/reader.js';
import { watchSessions } from '../src/watcher.js';
import { parseSession } from '../src/parser.js';
import { countTokens } from '../src/tokenizer.js';
import { calculateCost } from '../src/pricing.js';

const VERSION = '1.0.0';

function msToDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtCost(n, estimated = false) {
  const s = `$${n.toFixed(4)}`;
  return estimated ? chalk.yellow(s + '~') : s;
}

function bar(fraction, width = 20) {
  const filled = Math.round(fraction * width);
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
}

async function loadSessions(days) {
  const files = getAllSessionFiles();
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const sessions = [];

  for (const file of files) {
    const mtime = getFileMtime(file);
    if (mtime < cutoff) continue;

    const rawLines = readSessionFile(file);
    if (!rawLines.length) continue;

    const { messages, model, firstTs, lastTs } = parseSession(rawLines);
    if (!messages.length) continue;

    const { inputTokens, outputTokens, source } = countTokens(messages);
    const { inputCost, outputCost, totalCost, estimated } = calculateCost(model, inputTokens, outputTokens);
    const turns = messages.filter(m => m.role === 'user').length;
    const sessionId = path.basename(file, '.jsonl').slice(0, 8);

    sessions.push({
      sessionId,
      model: model ?? 'unknown',
      turns,
      inputTokens,
      outputTokens,
      inputCost,
      outputCost,
      totalCost,
      estimated: estimated || source === 'estimated',
      date: mtime,
    });
  }

  sessions.sort((a, b) => b.date - a.date);
  return sessions;
}

function printSummary(sessions) {
  console.log();
  console.log(chalk.bold.cyan(`  Claude Monitor v${VERSION}`));
  console.log(chalk.gray(`  User: ${os.userInfo().username}@${os.hostname()}`));
  console.log();

  if (!sessions.length) {
    console.log(chalk.yellow('  No sessions found.'));
    return;
  }

  // Sessions table
  const table = new Table({
    head: [
      chalk.bold('Session'),
      chalk.bold('Model'),
      chalk.bold('Turns'),
      chalk.bold('Input tok'),
      chalk.bold('Output tok'),
      chalk.bold('Cost'),
      chalk.bold('Date'),
    ],
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'left'],
  });

  let totalIn = 0, totalOut = 0, totalCost = 0;

  for (const s of sessions) {
    totalIn   += s.inputTokens;
    totalOut  += s.outputTokens;
    totalCost += s.totalCost;

    table.push([
      chalk.cyan(s.sessionId),
      s.model.replace('claude-', '').slice(0, 18),
      s.turns,
      s.inputTokens.toLocaleString('en-US'),
      s.outputTokens.toLocaleString('en-US'),
      fmtCost(s.totalCost, s.estimated),
      msToDate(s.date),
    ]);
  }

  // Totals row
  table.push([
    chalk.bold('TOTAL'),
    '',
    sessions.reduce((a, s) => a + s.turns, 0),
    chalk.bold(totalIn.toLocaleString('en-US')),
    chalk.bold(totalOut.toLocaleString('en-US')),
    chalk.bold.green(`$${totalCost.toFixed(4)}`),
    '',
  ]);

  console.log(table.toString());

  // By-model breakdown
  const byModel = {};
  for (const s of sessions) {
    if (!byModel[s.model]) byModel[s.model] = { cost: 0, sessions: 0 };
    byModel[s.model].cost     += s.totalCost;
    byModel[s.model].sessions += 1;
  }

  console.log();
  console.log(chalk.bold('  Cost by model'));
  console.log();
  for (const [model, data] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
    const fraction = totalCost > 0 ? data.cost / totalCost : 0;
    const pct = (fraction * 100).toFixed(1).padStart(5);
    console.log(
      `  ${model.padEnd(28)} ${bar(fraction)}  ${pct}%  $${data.cost.toFixed(4)}  (${data.sessions} session${data.sessions !== 1 ? 's' : ''})`
    );
  }
  console.log();
  console.log(chalk.gray('  ~ = cost estimated (usage data not in session file)'));
  console.log();
}

async function watchSummary(opts) {
  let debounce = null;
  let rendering = false;

  async function render() {
    if (rendering) return;
    rendering = true;
    try {
      const sessions = await loadSessions(opts.days);
      console.clear();
      printSummary(sessions);
      const ts = new Date().toLocaleTimeString('en-US');
      console.log(chalk.gray(`  Watching ~/.claude/projects/ for changes...  Last updated: ${ts}  (Ctrl+C to exit)\n`));
    } finally {
      rendering = false;
    }
  }

  function scheduleRender() {
    clearTimeout(debounce);
    debounce = setTimeout(render, 500);
  }

  await render();
  watchSessions(scheduleRender);
}

function printSessionsList(sessions) {
  console.log();
  if (!sessions.length) {
    console.log(chalk.yellow('  No sessions found.'));
    return;
  }
  for (const s of sessions) {
    console.log(
      chalk.cyan(s.sessionId.padEnd(10)) +
      s.model.replace('claude-', '').padEnd(22) +
      `${s.turns} turns`.padEnd(10) +
      `${(s.inputTokens + s.outputTokens).toLocaleString('en-US')} tok`.padEnd(14) +
      fmtCost(s.totalCost, s.estimated).padEnd(12) +
      msToDate(s.date)
    );
  }
  console.log();
}

program
  .name('claude-monitor')
  .version(VERSION)
  .description('Monitor Claude Code session costs locally');

program
  .command('summary', { isDefault: true })
  .description('Show cost summary across all sessions')
  .option('-d, --days <n>', 'Only show sessions from the last N days', parseInt)
  .option('-w, --watch', 'Live-update as new sessions come in')
  .action(async (opts) => {
    if (opts.watch) {
      await watchSummary(opts);
    } else {
      const sessions = await loadSessions(opts.days);
      printSummary(sessions);
    }
  });

program
  .command('sessions')
  .description('Show one line per session')
  .option('-d, --days <n>', 'Only show sessions from the last N days', parseInt)
  .action(async (opts) => {
    const sessions = await loadSessions(opts.days);
    printSessionsList(sessions);
  });

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red('Error: ' + err.message));
  process.exit(1);
});
