import fs from 'fs';
import path from 'path';
import os from 'os';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

export function getAllSessionFiles() {
  if (!fs.existsSync(CLAUDE_DIR)) return [];

  const files = [];
  for (const projectHash of fs.readdirSync(CLAUDE_DIR)) {
    const projectDir = path.join(CLAUDE_DIR, projectHash);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const file of fs.readdirSync(projectDir)) {
      if (file.endsWith('.jsonl')) {
        // Normalize to forward slashes so paths are consistent on all platforms,
        // including when matched against chokidar-emitted paths.
        files.push(path.join(projectDir, file).replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

export function readSessionFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return lines;
}

export function getFileMtime(filePath) {
  return fs.statSync(filePath).mtimeMs;
}
