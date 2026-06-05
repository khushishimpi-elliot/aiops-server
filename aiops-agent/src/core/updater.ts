import fs from 'fs';
import crypto from 'crypto';
import { loadConfig } from './config.js';
import { logError } from './logger.js';

export interface UpdateResult {
  checked: boolean;
  updated: boolean;
  reason?: string;
  localHash?: string;
  remoteHash?: string;
}

// The running bundle: the bin shim invokes `node <path>/cli.cjs`, so argv[1]
// is the bundle we replace. Falls back to __filename when bundled as CJS.
function bundlePath(): string {
  return process.argv[1] || __filename;
}

function sha256File(file: string): string {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Compare the local bundle to the server's and replace it if they differ.
 * Safe to call repeatedly; only writes when the hash actually changed.
 */
export async function checkAndUpdate(opts: { silent?: boolean } = {}): Promise<UpdateResult> {
  const config = loadConfig();
  if (!config?.serverUrl) {
    return { checked: false, updated: false, reason: 'not enrolled' };
  }

  const base = config.serverUrl.replace(/\/$/, '');
  const target = bundlePath();

  let remoteHash: string;
  try {
    const res = await fetch(`${base}/download/manifest`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { checked: true, updated: false, reason: `manifest HTTP ${res.status}` };
    }
    const manifest = await res.json() as { sha256?: string };
    if (!manifest.sha256) {
      return { checked: true, updated: false, reason: 'manifest missing sha256' };
    }
    remoteHash = manifest.sha256;
  } catch (err) {
    if (!opts.silent) logError('updater', 'manifest fetch failed', err);
    return { checked: false, updated: false, reason: 'server unreachable' };
  }

  let localHash: string;
  try {
    localHash = sha256File(target);
  } catch (err) {
    return { checked: true, updated: false, reason: 'cannot read local bundle' };
  }

  if (localHash === remoteHash) {
    return { checked: true, updated: false, reason: 'up to date', localHash, remoteHash };
  }

  // Download the new bundle to a temp file, verify, then atomically swap.
  try {
    const res = await fetch(`${base}/download/cli.cjs`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      return { checked: true, updated: false, reason: `download HTTP ${res.status}` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const gotHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (gotHash !== remoteHash) {
      return { checked: true, updated: false, reason: 'downloaded bundle hash mismatch' };
    }

    const tmp = `${target}.new`;
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    fs.renameSync(tmp, target);   // overwrite — node already closed the handle
    if (process.platform !== 'win32') {
      try { fs.chmodSync(target, 0o755); } catch { /* best effort */ }
    }
    return { checked: true, updated: true, localHash, remoteHash };
  } catch (err) {
    if (!opts.silent) logError('updater', 'bundle download/write failed', err);
    return { checked: true, updated: false, reason: 'download failed' };
  }
}
