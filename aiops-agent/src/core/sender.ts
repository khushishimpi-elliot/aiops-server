import { SessionRecord } from './types.js';
import { logError } from './logger.js';

const RETRY_COUNT    = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Sends a session record to the configured server endpoint.
// Returns true if sent successfully, false otherwise.
// Never throws — always logs failures silently.
export async function sendSession(session: SessionRecord): Promise<boolean> {
  // No server endpoint is configured yet — skip gracefully.
  // Wire AIOPS_SERVER_URL env var when a backend is ready.
  const endpoint = process.env['AIOPS_SERVER_URL'];
  if (!endpoint) return false;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      logError('sender', `HTTP ${res.status} on attempt ${attempt} for session ${session.sessionId}`);
    } catch (err) {
      logError('sender', `Attempt ${attempt}/${RETRY_COUNT} failed for session ${session.sessionId}`, err);
    }

    if (attempt < RETRY_COUNT) await sleep(RETRY_DELAY_MS);
  }

  // All retries exhausted — sentToServer stays 0
  return false;
}

export async function sendBatch(sessions: SessionRecord[]): Promise<void> {
  for (const s of sessions) {
    if (s.sentToServer === 0) {
      await sendSession(s);
      // Note: we do not mutate sentToServer here — persistence layer owns that flag
    }
  }
}
