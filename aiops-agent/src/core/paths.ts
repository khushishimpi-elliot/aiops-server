import os from 'os';
import path from 'path';

const HOME = os.homedir();

function appDataDir(): string {
  switch (process.platform) {
    case 'win32':
      if (process.env['APPDATA']) return process.env['APPDATA'];
      if (process.env['USERPROFILE']) return path.join(process.env['USERPROFILE'], 'AppData', 'Roaming');
      return path.join(HOME, 'AppData', 'Roaming');
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support');
    default:
      return path.join(HOME, '.config');
  }
}

const APP_DATA = appDataDir();

export const PATHS = {
  claude: path.join(HOME, '.claude', 'projects'),

  geminiTmp: process.platform === 'win32'
    ? path.join(
        process.env['APPDATA'] ||
        (process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], 'AppData', 'Roaming') : '') ||
        path.join(HOME, 'AppData', 'Roaming'),
        'gemini', 'tmp')
    : path.join(HOME, '.gemini', 'tmp'),

  cursorDb: path.join(APP_DATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),

  windsurfDb: path.join(APP_DATA, 'Windsurf', 'User', 'globalStorage', 'state.vscdb'),

  clineTasks: path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'),
  clineRoot:  path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),

  rooTasks: path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks'),
  rooRoot:  path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),

  kiloTasks: path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'),
  kiloRoot:  path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code'),

  copilotWorkspaceStorage: path.join(APP_DATA, 'Code', 'User', 'workspaceStorage'),
  copilotGlobalStorage:    path.join(APP_DATA, 'Code', 'User', 'globalStorage', 'github.copilot-chat'),

  claudeAgentSessions: path.join(APP_DATA, 'Claude', 'local-agent-mode-sessions'),
  codexSessions: path.join(HOME, '.codex', 'sessions'),
  kiroAgent: path.join(APP_DATA, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
  opencode: path.join(HOME, '.local', 'share', 'opencode'),
  openclaw: path.join(HOME, '.openclaw', 'agents'),
  gooseDb: path.join(HOME, '.local', 'share', 'goose', 'sessions', 'sessions.db'),
  geminiAntigravity: path.join(HOME, '.gemini', 'antigravity', 'conversations'),
  qwen: path.join(HOME, '.qwen', 'projects'),
  pi: path.join(HOME, '.pi', 'agent', 'sessions'),
  omp: path.join(HOME, '.omp', 'agent', 'sessions'),
  factory: path.join(HOME, '.factory', 'projects'),
};
