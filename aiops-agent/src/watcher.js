import chokidar from 'chokidar';
import { CLAUDE_DIR } from './reader.js';

export function watchSessions(onChange) {
  // Chokidar glob patterns require forward slashes on all platforms.
  const pattern = CLAUDE_DIR.replace(/\\/g, '/') + '/**/*.jsonl';

  chokidar
    .watch(pattern, { ignoreInitial: true, persistent: true })
    .on('all', (_event, filePath) => {
      // Chokidar emits forward-slash paths everywhere; split on '/' not path.sep.
      const parts = filePath.replace(/\\/g, '/').split('/');
      const filename = parts[parts.length - 1];
      if (filename && !filename.endsWith('.jsonl')) return;
      onChange(filePath);
    });
}
