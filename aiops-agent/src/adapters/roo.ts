import { AdapterResult } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { loadClineFamily } from './cline.js';

export function loadRoo(): AdapterResult {
  return loadClineFamily(PATHS.rooTasks, 'roo');
}
