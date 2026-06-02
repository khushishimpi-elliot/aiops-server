import fs from 'fs';
import path from 'path';
import os from 'os';
import { logError } from './logger.js';

const AIOPS_DIR   = path.join(os.homedir(), '.aiops');
const CONFIG_PATH = path.join(AIOPS_DIR, 'config.json');

export interface AiopsConfig {
  serverUrl: string;
  enrollmentToken: string;
  machineId: string;
  enrolledAt: string;
  developerName?: string;
}

export function getMachineId(): string {
  return os.hostname() + '-' + process.platform;
}

export function loadConfig(): AiopsConfig | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as AiopsConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AiopsConfig): void {
  try {
    fs.mkdirSync(AIOPS_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    logError('config', 'Failed to save config', err);
  }
}

export function isEnrolled(): boolean {
  const c = loadConfig();
  return !!(c?.serverUrl && c?.enrollmentToken);
}
