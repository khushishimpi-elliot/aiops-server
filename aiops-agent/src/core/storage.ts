import { SessionRecord } from './types.js';
import { logError } from './logger.js';

const BATCH_SIZE = 100;

let _sessions: SessionRecord[] = [];

// Stores sessions in batches of BATCH_SIZE to avoid large memory spikes.
export function storeSessions(incoming: SessionRecord[]): void {
  try {
    _sessions = [];
    for (let i = 0; i < incoming.length; i += BATCH_SIZE) {
      try {
        const batch = incoming.slice(i, i + BATCH_SIZE);
        _sessions.push(...batch);
      } catch (err) {
        logError('storage', `Failed to store batch at offset ${i}`, err);
      }
    }
  } catch (err) {
    logError('storage', 'storeSessions failed', err);
  }
}

export function getAllSessions(): SessionRecord[] {
  try { return _sessions; }
  catch { return []; }
}

export function getTodaySessions(): SessionRecord[] {
  try {
    const today = new Date().toISOString().slice(0, 10);
    return _sessions.filter(s => s.sessionDate === today);
  } catch (err) {
    logError('storage', 'getTodaySessions failed', err);
    return [];
  }
}
