import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_DIR  = path.join(os.homedir(), '.aiops');
const LOG_FILE = path.join(LOG_DIR, 'error.log');
const MAX_LOG_BYTES = 1_000_000; // 1 MB — rotate beyond this

function ensureLogDir(): void {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function rotatIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch { /* file doesn't exist yet — fine */ }
}

export function logError(source: string, message: string, err?: unknown): void {
  try {
    ensureLogDir();
    rotatIfNeeded();
    const ts   = new Date().toISOString();
    const detail = err instanceof Error ? ` — ${err.message}` : (err ? ` — ${String(err)}` : '');
    const line = `[${ts}] [${source}] ${message}${detail}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* never throw from the logger */ }
}

export function readLastLines(n = 20): string[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

export function logFilePath(): string {
  return LOG_FILE;
}
