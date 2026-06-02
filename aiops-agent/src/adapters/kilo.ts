import { AdapterResult } from '../core/types.js';
import { PATHS } from '../core/paths.js';
import { loadClineFamily } from './cline.js';

export function loadKilo(): AdapterResult {
  return loadClineFamily(PATHS.kiloTasks, 'kilo');
}
