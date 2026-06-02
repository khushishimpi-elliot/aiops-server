import chokidar from 'chokidar';
import fs from 'fs';
import { PATHS } from './paths.js';
import { logError } from './logger.js';

export function watchAll(onChange: (filePath: string) => void): void {
  const patterns: string[] = [];

  // Watch a path if it exists; fall back to a parent path so new sessions are
  // picked up even if the exact subdirectory didn't exist when we started.
  const add = (primary: string, fallback: string | null, glob: string) => {
    try {
      if (fs.existsSync(primary)) {
        patterns.push(primary.replace(/\\/g, '/') + glob);
      } else if (fallback && fs.existsSync(fallback)) {
        patterns.push(fallback.replace(/\\/g, '/') + glob);
      }
    } catch (err) {
      logError('watcher', `existsSync failed for ${primary}`, err);
    }
  };

  add(PATHS.claude,               null,             '/**/*.jsonl');
  add(PATHS.geminiTmp,            null,             '/**/*.jsonl');
  add(PATHS.geminiAntigravity,    null,             '/**/*.pb');
  add(PATHS.clineTasks,           PATHS.clineRoot,  '/**/*.json');
  add(PATHS.rooTasks,             PATHS.rooRoot,    '/**/*.json');
  add(PATHS.kiloTasks,            PATHS.kiloRoot,   '/**/*.json');

  if (!patterns.length) return;

  try {
    chokidar
      .watch(patterns, {
        ignoreInitial: true,
        persistent: true,
        // Follow new subdirectories so sessions created after startup are watched
        ignorePermissionErrors: true,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      })
      .on('all', (_event, filePath) => {
        try { onChange(filePath); }
        catch (err) { logError('watcher', `onChange callback failed for ${filePath}`, err); }
      })
      .on('error', err => logError('watcher', 'chokidar error', err));
  } catch (err) {
    logError('watcher', 'Failed to start file watcher', err);
  }
}
