#!/usr/bin/env node
/**
 * Cross-platform setup script for aiops-agent.
 * Works on Windows, macOS, and Linux — no bash required.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { platform, homedir } from 'os';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

// ── ANSI colours (disabled on Windows unless terminals support them) ──────────
const useColor = !IS_WIN || process.env['TERM'] === 'xterm-256color' || process.env['WT_SESSION'];
const c = {
  reset:  useColor ? '\x1b[0m'  : '',
  bold:   useColor ? '\x1b[1m'  : '',
  green:  useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red:    useColor ? '\x1b[31m' : '',
  cyan:   useColor ? '\x1b[36m' : '',
};

function ok(msg)   { console.log(`${c.green}✔${c.reset}  ${msg}`); }
function info(msg) { console.log(`${c.cyan}ℹ${c.reset}  ${msg}`); }
function warn(msg) { console.log(`${c.yellow}⚠${c.reset}  ${msg}`); }
function err(msg)  { console.log(`${c.red}✖${c.reset}  ${msg}`); }
function step(n, msg) { console.log(`\n${c.bold}Step ${n} — ${msg}${c.reset}`); }

// On Windows, prefix npm/npx commands with "cmd /c" so they always resolve
// to npm.cmd (not npm.ps1), bypassing PowerShell execution-policy errors.
function npmCmd(cmd) {
  return IS_WIN ? `cmd /c ${cmd}` : cmd;
}

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
    return true;
  } catch {
    return false;
  }
}

function runQuiet(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ── 1. Node.js version check ──────────────────────────────────────────────────
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 18) {
  err(`Node.js 18+ required. You have v${process.versions.node}.`);
  info('Download from: https://nodejs.org/');
  process.exit(1);
}
ok(`Node.js v${process.versions.node}`);

// ── 2. Install dependencies ───────────────────────────────────────────────────
step(1, 'Installing dependencies');
info('better-sqlite3 is optional — Cursor/Windsurf data requires it but the tool works without it.');

// On Windows check for build tools needed by better-sqlite3
if (IS_WIN) {
  const hasPy  = runQuiet('python --version') || runQuiet('python3 --version');
  const hasMsb = runQuiet('where msbuild 2>nul') || runQuiet('cl 2>nul') || runQuiet('where cl 2>nul');
  if (!hasPy || !hasMsb) {
    warn('Windows C++ build tools not detected.');
    warn('Cursor and Windsurf data will be skipped without them.');
    warn('To enable Cursor/Windsurf support, run ONE of these:');
    warn('');
    warn('  Option A (easiest):');
    warn('    npm install --global windows-build-tools');
    warn('');
    warn('  Option B (Visual Studio):');
    warn('    Install "Desktop development with C++" workload from visualstudio.com');
    warn('');
    warn('  Then re-run: node setup.mjs');
    warn('');
    warn('Continuing without Cursor/Windsurf support...');
  }
}

if (!run(npmCmd('npm install --ignore-scripts'))) {
  err('npm install failed.');
  info('Try: npm install --ignore-scripts');
  process.exit(1);
}

// Try to build better-sqlite3 — failure is non-fatal (Cursor/Windsurf skipped if missing)
run(npmCmd('npm rebuild better-sqlite3'), { stdio: 'pipe' });

ok('Dependencies installed');

// ── 3. Build TypeScript ───────────────────────────────────────────────────────
step(2, 'Building project');

if (!run(npmCmd('npm run build'))) {
  // tsc might already be in node_modules/.bin
  const tscPath = IS_WIN
    ? join('node_modules', '.bin', 'tsc.cmd')
    : join('node_modules', '.bin', 'tsc');

  if (existsSync(tscPath) && !run(`"${tscPath}"`)) {
    err('TypeScript build failed. Check the errors above and fix any type errors, then re-run setup.');
    process.exit(1);
  }
}
ok('Build complete → dist/');

// ── 4. Global install ─────────────────────────────────────────────────────────
step(3, 'Installing globally');

// Get the npm global bin directory
function getNpmGlobalBin() {
  try {
    const prefix = execSync(IS_WIN ? 'cmd /c npm config get prefix' : 'npm config get prefix', { stdio: 'pipe', encoding: 'utf8' }).trim();
    return IS_WIN ? prefix : join(prefix, 'bin');
  } catch { return null; }
}

// Add a directory to the Windows user PATH permanently (no admin needed)
function addToWindowsPath(dir) {
  try {
    const cur = execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\',\'User\')"', { stdio: 'pipe', encoding: 'utf8' }).trim();
    if (cur.toLowerCase().includes(dir.toLowerCase())) return true;
    const next = cur ? `${cur};${dir}` : dir;
    execSync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('PATH','${next}','User')"`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// Try plain first
let globalOk = run(npmCmd('npm install -g . --force'));

if (!globalOk && !IS_WIN) {
  warn('Permission denied. Retrying with sudo...');
  globalOk = run('sudo npm install -g . --force');
}

if (!globalOk) {
  const npmGlobal = join(homedir(), '.npm-global');
  warn('Global install failed. Falling back to user-local install.');
  try { mkdirSync(npmGlobal, { recursive: true }); } catch { /* already exists */ }
  run(`npm config set prefix "${npmGlobal}"`);
  globalOk = run(npmCmd('npm install -g . --force'));
}

if (!globalOk) {
  err('Could not install globally. Run the tool directly:');
  info('  node dist/cli.js scan');
  process.exit(0);
}

ok('Installed globally — aiops command is ready');

// ── 4b. Ensure npm global bin is in PATH (Windows) ───────────────────────────
if (IS_WIN) {
  const binDir = getNpmGlobalBin();
  if (binDir) {
    if (addToWindowsPath(binDir)) {
      ok(`Added to PATH: ${binDir}`);
      process.env['PATH'] = (process.env['PATH'] || '') + ';' + binDir;
      info('Open a new Command Prompt or PowerShell window to use the aiops command.');
    }
  }
}

// ── 5. Smoke test ─────────────────────────────────────────────────────────────
console.log('');
info('Running aiops scan...');
console.log('');

const scanResult = spawnSync('aiops', ['scan'], { stdio: 'inherit', shell: true });
if (scanResult.status !== 0) {
  // Try running from dist directly
  spawnSync('node', ['dist/cli.js', 'scan'], { stdio: 'inherit' });
}

console.log(`\n${c.green}${c.bold}Setup complete!${c.reset}`);
info("Run 'aiops --help' to see all commands.");
info("Run 'aiops scan' to see your full usage report.");
