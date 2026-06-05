import fs from 'fs';
import path from 'path';
import os from 'os';
import { openDb, upsertSessions, getDbStats } from './db.js';
import { runAllAdapters } from '../adapters/index.js';
import { syncToServer } from './syncer.js';
import { watchAll } from './watcher.js';
import { logError } from './logger.js';
import { isEnrolled } from './config.js';
import { checkAndUpdate } from './updater.js';

const AIOPS_DIR  = path.join(os.homedir(), '.aiops');
const PID_FILE   = path.join(AIOPS_DIR, 'daemon.pid');
export const LOG_FILE = path.join(AIOPS_DIR, 'daemon.log');

// 2 min quiet period after last file change → sync (catches end-of-session)
const DEBOUNCE_MS  = 2 * 60 * 1000;
// 15 min periodic fallback → catches SQLite-based tools (Copilot, Cursor, Codex)
const INTERVAL_MS  = 15 * 60 * 1000;
// Rotate log when it exceeds 500 KB
const LOG_MAX_BYTES = 500 * 1024;
// Sync the entire local history every time. Syncing only a recent window left
// older dates frozen at whatever a past sync stored — the server upserts by
// (date, tool, model, category) so re-sending old days is cheap and keeps the
// dashboard exactly matching the local scan over every period.
const SYNC_DAYS = 3650;

export function daemonLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(AIOPS_DIR, { recursive: true });
    // Rotate if too large
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        const old = fs.readFileSync(LOG_FILE, 'utf8');
        fs.writeFileSync(LOG_FILE, old.slice(-Math.floor(LOG_MAX_BYTES / 2)));
      }
    } catch { /* file may not exist yet */ }
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* log failures are non-fatal */ }
}

function writePid(): void {
  try {
    fs.mkdirSync(AIOPS_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch { /* best-effort */ }
}

export function readDaemonPid(): number | null {
  try {
    const n = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return isNaN(n) ? null : n;
  } catch { return null; }
}

export function isDaemonAlive(): boolean {
  const pid = readDaemonPid();
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export function stopDaemon(): boolean {
  const pid = readDaemonPid();
  if (pid === null) return false;
  try { process.kill(pid, 'SIGTERM'); return true; }
  catch { return false; }
}

async function scanAndSync(reason: string): Promise<void> {
  daemonLog(`Scan triggered: ${reason}`);
  try {
    const sessions = runAllAdapters().flatMap(r => r.sessions);
    if (sessions.length) {
      openDb();
      upsertSessions(sessions);
      const stats = getDbStats();
      daemonLog(`Scanned: ${stats.totalRows} sessions in DB`);
    }
    if (isEnrolled()) {
      const result = await syncToServer(SYNC_DAYS, false);
      if (result.success) {
        daemonLog(`Sync OK — ${result.aggregatesSent} aggregates, ${result.daysIncluded} days`);
      } else {
        daemonLog(`Sync failed: ${result.error ?? 'unknown error'}`);
      }
    } else {
      daemonLog('Scan complete (not enrolled — local only)');
    }
  } catch (err) {
    logError('daemon', 'scanAndSync threw', err);
    daemonLog(`Error: ${(err as Error).message}`);
  }
}

async function autoUpdate(reason: string): Promise<void> {
  try {
    const r = await checkAndUpdate({ silent: true });
    if (r.updated) {
      daemonLog(`Self-update (${reason}): bundle replaced — restarting to apply`);
      // Re-exec so the new code takes effect immediately. The OS auto-start
      // entry will also relaunch us if this exit races, so either path works.
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      process.exit(0);
    } else if (r.reason && r.reason !== 'up to date') {
      daemonLog(`Self-update check (${reason}): ${r.reason}`);
    }
  } catch (err) {
    daemonLog(`Self-update check failed: ${(err as Error).message}`);
  }
}

export async function startDaemon(): Promise<never> {
  fs.mkdirSync(AIOPS_DIR, { recursive: true });

  if (isDaemonAlive()) {
    const existingPid = readDaemonPid();
    daemonLog(`Already running (PID ${existingPid}). Exiting.`);
    process.exit(0);
  }

  writePid();
  daemonLog(`Daemon started  PID=${process.pid}  node=${process.version}  platform=${process.platform}`);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleSync = (reason: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scanAndSync(reason), DEBOUNCE_MS);
  };

  // Self-update on startup, then once a day, so every machine tracks the
  // latest agent without anyone needing git access or a manual reinstall.
  await autoUpdate('startup');
  const updateId = setInterval(() => autoUpdate('daily'), 24 * 60 * 60 * 1000);

  // Run once on startup so the dashboard reflects the latest state immediately
  await scanAndSync('startup');

  // File watcher — event-driven triggers for Claude, Gemini, Cline, Roo, Kilo
  try {
    watchAll(fp => {
      const base = path.basename(fp);
      scheduleSync(`file changed: ${base}`);
    });
    daemonLog('File watcher running');
  } catch (err) {
    daemonLog(`File watcher unavailable: ${(err as Error).message}`);
  }

  // Periodic fallback — catches Copilot, Cursor, Codex (SQLite, not watchable)
  const intervalId = setInterval(() => scanAndSync('periodic'), INTERVAL_MS);
  daemonLog(`Periodic sync every ${INTERVAL_MS / 60_000} min`);

  // Graceful shutdown
  const cleanup = (sig: string) => {
    daemonLog(`${sig} received — stopping`);
    clearInterval(intervalId);
    clearInterval(updateId);
    if (debounceTimer) clearTimeout(debounceTimer);
    try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT',  () => cleanup('SIGINT'));

  daemonLog('Daemon ready — watching for AI tool activity');

  // Keep alive (file watcher + interval already do this, but be explicit)
  await new Promise<never>(() => { /* intentionally never resolves */ });
}
