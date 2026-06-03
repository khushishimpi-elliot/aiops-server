import os from 'os';
import { loadConfig, getMachineId } from './config.js';
import { computeDailyAggregates, DailyAggregate } from './aggregator.js';
import { logError } from './logger.js';

export interface SyncResult {
  success: boolean;
  aggregatesSent: number;
  daysIncluded: number;
  error?: string;
  dryRun: boolean;
  preview?: DailyAggregate[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function syncToServer(
  days: number,
  dryRun: boolean,
): Promise<SyncResult> {
  const config = loadConfig();

  if (!config) {
    return {
      success: false,
      aggregatesSent: 0,
      daysIncluded: 0,
      error: 'Not enrolled. Run: aiops enroll --server URL --token TOKEN',
      dryRun,
    };
  }

  const aggregates = computeDailyAggregates(days);

  if (!aggregates.length) {
    return {
      success: false,
      aggregatesSent: 0,
      daysIncluded: 0,
      error: 'No sessions found. Run aiops scan first.',
      dryRun,
    };
  }

  if (dryRun) {
    return {
      success: true,
      aggregatesSent: 0,
      daysIncluded: new Set(aggregates.map(a => a.date)).size,
      dryRun: true,
      preview: aggregates,
    };
  }

  const payload = {
    enrollment_token: config.enrollmentToken,
    machine_id:       config.machineId || getMachineId(),
    hostname:         os.hostname(),
    os:               process.platform,
    sent_at:          new Date().toISOString(),
    aggregates: aggregates.map(a => ({
      date:          a.date,
      tool:          a.tool,
      model:         a.model,
      category:      a.category,
      sessions:      a.sessions,
      total_turns:   a.total_turns,
      input_tokens:  a.input_tokens,
      output_tokens: a.output_tokens,
      cache_tokens:  a.cache_tokens,
      cost_usd:      a.cost_usd,
      active_day:    a.active_day,
    })),
  };

  const url = config.serverUrl.replace(/\/$/, '') + '/api/telemetry/daily-rollup';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-enrollment-token': config.enrollmentToken,
        },
        body:   JSON.stringify(payload),
        // Generous timeout: the server may be cold-starting (Render free tier
        // can take 30-60s to wake) and large rollups take a few seconds to
        // persist. A short timeout aborts mid-write and reports a false failure.
        signal: AbortSignal.timeout(60_000),
      });

      if (res.ok) {
        return {
          success:        true,
          aggregatesSent: aggregates.length,
          daysIncluded:   new Set(aggregates.map(a => a.date)).size,
          dryRun:         false,
        };
      }

      const errBody = await res.json().catch(() => ({} as Record<string, unknown>));
      logError('syncer', `HTTP ${res.status}: ${String((errBody as Record<string, unknown>)['error'] ?? 'unknown')}`);

      if (res.status === 401 || res.status === 403) {
        return {
          success:        false,
          aggregatesSent: 0,
          daysIncluded:   0,
          error:          'Invalid enrollment token. Re-run: aiops enroll --server URL --token TOKEN',
          dryRun:         false,
        };
      }

    } catch (err: unknown) {
      logError('syncer', `Attempt ${attempt}/3 failed`, err);
      if (attempt < 3) await sleep(2_000);
    }
  }

  return {
    success:        false,
    aggregatesSent: 0,
    daysIncluded:   0,
    error:          'Server unreachable after 3 attempts',
    dryRun:         false,
  };
}
