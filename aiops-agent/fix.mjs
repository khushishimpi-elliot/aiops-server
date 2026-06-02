#!/usr/bin/env node
/**
 * fix.mjs — AIOps self-repair script for Windows (also works on macOS/Linux)
 * Run this whenever something breaks:  node fix.mjs
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { execSync, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const IS_WIN = process.platform === 'win32';
const HOME   = os.homedir();
const HERE   = path.dirname(fileURLToPath(import.meta.url));

// Prefix npm/npx with "cmd /c" on Windows to bypass PowerShell execution policy
const npm = IS_WIN ? 'cmd /c npm' : 'npm';

// ── COLOURS ──────────────────────────────────────────────────────────────────
const useColor = !IS_WIN || process.env['WT_SESSION'] || process.env['TERM_PROGRAM'];
const C = {
  reset:  useColor ? '\x1b[0m'  : '',
  bold:   useColor ? '\x1b[1m'  : '',
  green:  useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red:    useColor ? '\x1b[31m' : '',
  cyan:   useColor ? '\x1b[36m' : '',
  gray:   useColor ? '\x1b[90m' : '',
};

let passed = 0, fixed = 0, failed = 0;

function ok(msg)    { passed++; console.log(`${C.green}  ✔  ${C.reset}${msg}`); }
function fix(msg)   { fixed++;  console.log(`${C.yellow}  ⚙  ${C.reset}${msg}`); }
function fail(msg)  { failed++; console.log(`${C.red}  ✖  ${C.reset}${msg}`); }
function info(msg)  {           console.log(`${C.cyan}  ℹ  ${C.reset}${msg}`); }
function head(msg)  {           console.log(`\n${C.bold}${msg}${C.reset}`); }
function divider()  {           console.log(C.gray + '  ' + '─'.repeat(54) + C.reset); }

function run(cmd, opts = {}) {
  try { execSync(cmd, { stdio: 'pipe', ...opts }); return true; }
  catch { return false; }
}

function runOut(cmd) {
  try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log();
divider();
console.log(`  ${C.bold}${C.cyan}AIOps Fix & Repair${C.reset}   ${C.gray}Windows diagnostic tool${C.reset}`);
divider();

// ── CHECK 1: Node.js version ─────────────────────────────────────────────────
head('1 / 8  Node.js version');

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 18) {
  ok(`Node.js v${process.versions.node} — OK`);
} else {
  fail(`Node.js v${process.versions.node} is too old. Need v18 or higher.`);
  info('Download the latest LTS from: https://nodejs.org/');
  info('After installing, re-run:  node fix.mjs');
  process.exit(1);
}

// ── CHECK 2: package.json present ────────────────────────────────────────────
head('2 / 8  Project files');

const pkgPath = path.join(HERE, 'package.json');
if (!fs.existsSync(pkgPath)) {
  fail('package.json not found. Are you running this from the aiops folder?');
  info(`Current folder: ${HERE}`);
  info('Run:  cd path\\to\\aiops-npm   then   node fix.mjs');
  process.exit(1);
}
ok('package.json found');

// ── CHECK 3: node_modules ─────────────────────────────────────────────────────
head('3 / 8  Dependencies (node_modules)');

const nmPath = path.join(HERE, 'node_modules');
if (!fs.existsSync(nmPath)) {
  fix('node_modules missing — running npm install...');
  if (run(`${npm} install --ignore-scripts`, { cwd: HERE })) {
    ok('npm install succeeded');
  } else {
    fail('npm install failed.');
    info('Try manually:  npm install --ignore-scripts');
    info('If it fails with EACCES, open terminal as Administrator and retry.');
  }
} else {
  // Check required packages exist
  const required = ['chalk', 'cli-table3', 'commander'];
  const missing  = required.filter(p => !fs.existsSync(path.join(nmPath, p)));
  if (missing.length) {
    fix(`Missing packages: ${missing.join(', ')} — re-running npm install...`);
    run(`${npm} install --ignore-scripts`, { cwd: HERE });
  }
  ok('node_modules present');
}

// ── CHECK 4: better-sqlite3 (Cursor / Windsurf support) ──────────────────────
head('4 / 8  better-sqlite3  (needed for Cursor & Windsurf)');

const sqlitePath = path.join(nmPath, 'better-sqlite3');
if (!fs.existsSync(sqlitePath)) {
  fix('better-sqlite3 not found — trying to install...');
  const ok1 = run(`${npm} install better-sqlite3`, { cwd: HERE });
  if (!ok1) {
    fail('Could not install better-sqlite3.');
    info('This means Cursor and Windsurf data will be skipped — everything else still works.');
    info('');
    info('To enable Cursor/Windsurf support, install C++ build tools:');
    info('  Option A:  npm install -g windows-build-tools   (run as Administrator)');
    info('  Option B:  Install Visual Studio → "Desktop development with C++"');
    info('             from https://visualstudio.microsoft.com/');
    info('');
    info('After installing build tools, run:  node fix.mjs');
  } else {
    ok('better-sqlite3 installed');
  }
} else {
  // Try to actually load it (confirms native .node file compiled correctly)
  const _require = createRequire(import.meta.url);
  let loadOk = false;
  try { _require('better-sqlite3'); loadOk = true; } catch { /* native module broken */ }

  if (loadOk) {
    ok('better-sqlite3 loaded successfully — Cursor & Windsurf supported');
  } else {
    fix('better-sqlite3 exists but its native module is broken — rebuilding...');
    const rebuilt = run(`${npm} rebuild better-sqlite3`, { cwd: HERE, stdio: 'pipe' });
    if (rebuilt) {
      ok('better-sqlite3 rebuilt successfully');
    } else {
      fail('better-sqlite3 rebuild failed — Cursor/Windsurf data will be skipped.');
      info('Install C++ build tools (see Option A or B above) then re-run this script.');
    }
  }
}

// ── CHECK 5: TypeScript build ─────────────────────────────────────────────────
head('5 / 8  TypeScript build  (dist/cli.js)');

const distCli = path.join(HERE, 'dist', 'cli.js');
const srcCli  = path.join(HERE, 'src', 'cli.ts');

let needsBuild = false;

if (!fs.existsSync(distCli)) {
  fix('dist/cli.js is missing — building...');
  needsBuild = true;
} else if (fs.existsSync(srcCli)) {
  const srcMtime  = fs.statSync(srcCli).mtimeMs;
  const distMtime = fs.statSync(distCli).mtimeMs;
  if (srcMtime > distMtime) {
    fix('Source is newer than dist — rebuilding...');
    needsBuild = true;
  } else {
    ok('dist/cli.js is up to date');
  }
}

// Also verify the MODEL COST BREAKDOWN feature is present
if (fs.existsSync(distCli)) {
  const content = fs.readFileSync(distCli, 'utf8');
  if (!content.includes('MODEL COST BREAKDOWN')) {
    fix('dist/cli.js is missing the MODEL COST BREAKDOWN feature — rebuilding...');
    needsBuild = true;
  }
}

if (needsBuild) {
  const tscLocal = path.join(HERE, 'node_modules', '.bin', IS_WIN ? 'tsc.cmd' : 'tsc');
  const tscCmd   = fs.existsSync(tscLocal) ? `"${tscLocal}"` : 'npx tsc';
  const built    = run(`${tscCmd} --project "${path.join(HERE, 'tsconfig.json')}"`, { cwd: HERE });
  if (built && fs.existsSync(distCli)) {
    ok('Build succeeded — dist/cli.js created');
  } else {
    fail('TypeScript build failed.');
    info('Run manually to see errors:  npx tsc');
    info('Common causes: wrong Node.js version, missing src/ files.');
  }
}

// Final check: MODEL COST BREAKDOWN must exist in dist
if (fs.existsSync(distCli)) {
  const content = fs.readFileSync(distCli, 'utf8');
  if (content.includes('MODEL COST BREAKDOWN')) {
    ok('MODEL COST BREAKDOWN feature confirmed in dist/cli.js');
  } else {
    fail('MODEL COST BREAKDOWN is still missing from dist/cli.js.');
    info('The src/cli.ts you received may be an older version.');
    info('Ask for the updated src/cli.ts or the updated dist/cli.js.');
  }
}

// ── CHECK 6: Claude sessions path ─────────────────────────────────────────────
head('6 / 8  Claude Code sessions');

const claudePath = path.join(HOME, '.claude', 'projects');
if (fs.existsSync(claudePath)) {
  try {
    const entries = fs.readdirSync(claudePath);
    ok(`Found Claude sessions folder with ${entries.length} project(s)  →  ${claudePath}`);
  } catch {
    fail(`Claude sessions folder exists but cannot be read: ${claudePath}`);
    info('Try running the terminal as your normal user (not Administrator).');
  }
} else {
  info(`No Claude Code sessions found at ${claudePath}`);
  info("That's normal if Claude Code hasn't been used on this PC yet.");
}

// ── CHECK 7: Global aiops command ────────────────────────────────────────────
head('7 / 8  Global  aiops  command');

const aiopsVersion = runOut(IS_WIN ? 'aiops --version 2>nul' : 'aiops --version 2>/dev/null');
if (aiopsVersion) {
  ok(`aiops command found  (v${aiopsVersion})`);
} else {
  fix('"aiops" not found globally — installing...');
  let globalOk = run(`${npm} install -g . --force`, { cwd: HERE });

  if (!globalOk && !IS_WIN) {
    fix('Retrying with sudo...');
    globalOk = run('sudo npm install -g . --force', { cwd: HERE });
  }

  if (globalOk) {
    ok('Global install succeeded — "aiops" command is ready');
  } else {
    fail('Global install failed.');
    info('You can still run the tool directly:');
    info(`  node "${distCli}" scan`);
    info('');
    info('To fix the global install, open terminal as Administrator and run:');
    info('  npm install -g . --force');
  }
}

// ── CHECK 8: Quick smoke test ─────────────────────────────────────────────────
head('8 / 8  Smoke test');

info('Running: node dist/cli.js scan ...');
console.log();

const result = spawnSync('node', [distCli, 'scan'], {
  stdio: 'inherit',
  cwd: HERE,
  shell: false,
});

console.log();
if (result.status === 0) {
  ok('Scan completed successfully');
} else {
  fail(`Scan exited with code ${result.status}`);
  info('Check the output above for the error.');
  info(`Error log is saved to: ${path.join(HOME, '.aiops', 'error.log')}`);
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log();
divider();
console.log(`  ${C.bold}Results:${C.reset}  ${C.green}${passed} passed${C.reset}   ${C.yellow}${fixed} fixed${C.reset}   ${C.red}${failed} failed${C.reset}`);
divider();

if (failed === 0) {
  console.log(`\n  ${C.green}${C.bold}Everything looks good!${C.reset}`);
  console.log(`  Run ${C.cyan}aiops scan${C.reset} or ${C.cyan}node dist/cli.js scan${C.reset} to use the tool.\n`);
} else {
  console.log(`\n  ${C.yellow}${C.bold}${failed} issue(s) need attention — see the messages above.${C.reset}`);
  console.log(`  After fixing them, run ${C.cyan}node fix.mjs${C.reset} again to re-check.\n`);
}
