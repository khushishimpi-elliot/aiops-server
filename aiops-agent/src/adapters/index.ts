import fs from 'fs';
import { SessionRecord, AdapterResult, AdapterStats } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { logError } from '../core/logger.js';
import { loadClaude }    from './claude.js';
import { loadGemini }    from './gemini.js';
import { loadCursor }    from './cursor.js';
import { loadWindsurf }  from './windsurf.js';
import { loadCline }     from './cline.js';
import { loadRoo }       from './roo.js';
import { loadKilo }      from './kilo.js';
import { loadCodex }     from './codex.js';
import { loadPi }        from './pi.js';
import { loadCopilot }   from './copilot.js';

export interface ToolResult {
  toolId: string;
  label: string;
  installed: boolean;
  sessions: SessionRecord[];
  stats: AdapterStats;
}

const TOOL_LOADERS: Array<{ id: string; label: string; load: () => AdapterResult }> = [
  { id: 'claude',   label: 'Claude Code',    load: loadClaude   },
  { id: 'copilot',  label: 'GitHub Copilot', load: loadCopilot  },
  { id: 'gemini',   label: 'Gemini CLI',     load: loadGemini   },
  { id: 'cursor',   label: 'Cursor',         load: loadCursor   },
  { id: 'windsurf', label: 'Windsurf',       load: loadWindsurf },
  { id: 'cline',    label: 'Cline',          load: loadCline    },
  { id: 'roo',      label: 'Roo Code',       load: loadRoo      },
  { id: 'kilo',     label: 'Kilo Code',      load: loadKilo     },
  { id: 'codex',    label: 'Codex',          load: loadCodex    },
  { id: 'pi',       label: 'Pi',             load: loadPi       },
];

export function runAllAdapters(): ToolResult[] {
  const results: ToolResult[] = [];

  for (const t of TOOL_LOADERS) {
    let result: AdapterResult = { sessions: [], stats: { processed: 0, skipped: 0, errors: 0 } };
    try {
      result = t.load();
    } catch (err) {
      logError('adapters', `Adapter ${t.id} threw unexpectedly`, err);
    }

    const installed = result.sessions.length > 0 || pathExists(t.id);
    results.push({
      toolId: t.id,
      label: t.label,
      installed,
      sessions: result.sessions,
      stats: result.stats,
    });
  }

  return results;
}

export function getAllSessions(): SessionRecord[] {
  return runAllAdapters().flatMap(r => r.sessions);
}

function pathExists(id: string): boolean {
  try {
    switch (id) {
      case 'claude':   return fs.existsSync(PATHS.claude);
      case 'gemini':   return fs.existsSync(PATHS.geminiTmp);
      case 'cursor':   return fs.existsSync(PATHS.cursorDb);
      case 'windsurf': return fs.existsSync(PATHS.windsurfDb);
      case 'cline':    return fs.existsSync(PATHS.clineTasks) || fs.existsSync(PATHS.clineRoot);
      case 'roo':      return fs.existsSync(PATHS.rooTasks)  || fs.existsSync(PATHS.rooRoot);
      case 'kilo':     return fs.existsSync(PATHS.kiloTasks) || fs.existsSync(PATHS.kiloRoot);
      case 'codex':    return fs.existsSync(PATHS.codexSessions);
      case 'pi':       return fs.existsSync(PATHS.pi);
      case 'copilot':  return fs.existsSync(PATHS.copilotGlobalStorage) || fs.existsSync(PATHS.copilotWorkspaceStorage);
      default:         return false;
    }
  } catch { return false; }
}
