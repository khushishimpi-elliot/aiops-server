import http from 'http';
import { runAllAdapters, ToolResult } from '../adapters/index.js';
import { SessionRecord } from './types.js';
import { watchAll } from './watcher.js';
import { logError } from './logger.js';

// Bump when the response shape changes so dashboards can detect version mismatches.
const SCHEMA_VERSION = 1;

// ─── CORS ────────────────────────────────────────────────────────────────────
// Allow any localhost / 127.0.0.1 origin (including any port) so dashboard
// dev servers on e.g. :3000 can freely call this API on :3001.
function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers['origin'] ?? '';
  const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ? origin
    : 'http://localhost:3000';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                          'Origin',
  };
}

// ─── DATA BUILDER ────────────────────────────────────────────────────────────

export interface ApiTool {
  id:            string;
  label:         string;
  installed:     boolean;
  session_count: number;
  total_cost_usd: number;
  total_tokens:   number;
  top_model:      string;
}

export interface ApiSession {
  tool:                string;
  model:               string;
  session_id:          string;
  project_name:        string;
  input_tokens:        number;
  output_tokens:       number;
  cache_read_tokens:   number;
  cache_write_tokens:  number;
  total_tokens:        number;
  cost_usd:            number;
  token_source:        string;
  session_date:        string;
  session_timestamp:   number;
  turn_count:          number;
  first_prompt?:       string;
}

export interface ApiData {
  schema_version: number;
  generated_at:   string;
  tools:          ApiTool[];
  sessions:       ApiSession[];
  summary: {
    total_sessions: number;
    total_tokens:   number;
    total_cost_usd: number;
    by_period: {
      today:  { sessions: number; tokens: number; cost_usd: number };
      week:   { sessions: number; tokens: number; cost_usd: number };
      month:  { sessions: number; tokens: number; cost_usd: number };
    };
  };
}

function topModel(sessions: SessionRecord[]): string {
  if (!sessions.length) return '';
  const counts: Record<string, number> = {};
  for (const s of sessions) counts[s.model] = (counts[s.model] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function periodStats(sessions: SessionRecord[], fromMs: number) {
  const rows = sessions.filter(s => s.sessionTimestamp >= fromMs);
  return {
    sessions: rows.length,
    tokens:   rows.reduce((a, s) => a + s.totalTokens, 0),
    cost_usd: Math.round(rows.reduce((a, s) => a + s.costUSD, 0) * 1000) / 1000,
  };
}

function buildApiData(): ApiData {
  const now    = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const results  = runAllAdapters();
  const allSessions = results.flatMap(r => r.sessions);

  const tools: ApiTool[] = results.map(r => ({
    id:             r.toolId,
    label:          r.label,
    installed:      r.installed,
    session_count:  r.sessions.length,
    total_cost_usd: Math.round(r.sessions.reduce((a, s) => a + s.costUSD, 0) * 1000) / 1000,
    total_tokens:   r.sessions.reduce((a, s) => a + s.totalTokens, 0),
    top_model:      topModel(r.sessions),
  }));

  const sessions: ApiSession[] = allSessions.map(s => ({
    tool:               s.tool,
    model:              s.model,
    session_id:         s.sessionId,
    project_name:       s.projectName,
    input_tokens:       s.inputTokens,
    output_tokens:      s.outputTokens,
    cache_read_tokens:  s.cacheReadTokens,
    cache_write_tokens: s.cacheWriteTokens,
    total_tokens:       s.totalTokens,
    cost_usd:           Math.round(s.costUSD * 1000000) / 1000000,
    token_source:       s.tokenSource,
    session_date:       s.sessionDate,
    session_timestamp:  s.sessionTimestamp,
    turn_count:         s.turnCount,
    ...(s.firstPrompt ? { first_prompt: s.firstPrompt } : {}),
  }));

  const todaySessions = allSessions.filter(s => s.sessionDate === todayStr);

  return {
    schema_version: SCHEMA_VERSION,
    generated_at:   new Date().toISOString(),
    tools,
    sessions,
    summary: {
      total_sessions: allSessions.length,
      total_tokens:   allSessions.reduce((a, s) => a + s.totalTokens, 0),
      total_cost_usd: Math.round(allSessions.reduce((a, s) => a + s.costUSD, 0) * 1000) / 1000,
      by_period: {
        today: { sessions: todaySessions.length, tokens: todaySessions.reduce((a,s)=>a+s.totalTokens,0), cost_usd: Math.round(todaySessions.reduce((a,s)=>a+s.costUSD,0)*1000)/1000 },
        week:  periodStats(allSessions, now - 7  * 86400000),
        month: periodStats(allSessions, now - 30 * 86400000),
      },
    },
  };
}

// ─── SSE CLIENT REGISTRY ────────────────────────────────────────────────────

type SseClient = { res: http.ServerResponse; timer: ReturnType<typeof setInterval> };
const sseClients = new Set<SseClient>();

function sendSseEvent(client: SseClient, event: string, data: unknown) {
  try {
    client.res.write(`data: ${JSON.stringify({ event, ...( data as object ) })}\n\n`);
  } catch {
    removeSseClient(client);
  }
}

function removeSseClient(client: SseClient) {
  clearInterval(client.timer);
  sseClients.delete(client);
}

function broadcastUpdate(filePath: string) {
  const payload = { timestamp: Date.now(), changed_file: filePath };
  for (const client of sseClients) {
    sendSseEvent(client, 'update', payload);
  }
}

// Start file watcher once (shared across all SSE clients)
let watcherStarted = false;
function ensureWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;
  try {
    watchAll(fp => broadcastUpdate(fp));
  } catch (err) {
    logError('server', 'Failed to start file watcher for SSE', err);
  }
}

// ─── REQUEST HANDLER ─────────────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const cors = corsHeaders(req);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = req.url?.split('?')[0] ?? '/';

  // Health check
  if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ ok: true, schema_version: SCHEMA_VERSION }));
    return;
  }

  // Main data snapshot
  if (url === '/api/data') {
    try {
      const data = buildApiData();
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(data));
    } catch (err) {
      logError('server', 'Error building API data', err);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
    return;
  }

  // Sessions only
  if (url === '/api/sessions') {
    try {
      const data = buildApiData();
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ schema_version: SCHEMA_VERSION, sessions: data.sessions }));
    } catch (err) {
      logError('server', 'Error building sessions response', err);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
    return;
  }

  // Tools only
  if (url === '/api/tools') {
    try {
      const data = buildApiData();
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ schema_version: SCHEMA_VERSION, tools: data.tools }));
    } catch (err) {
      logError('server', 'Error building tools response', err);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
    return;
  }

  // SSE live stream — fires when any session file changes
  if (url === '/api/stream') {
    ensureWatcher();

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      ...cors,
    });
    res.flushHeaders?.();

    // Send an initial snapshot event so the dashboard can render immediately
    try {
      const data = buildApiData();
      res.write(`data: ${JSON.stringify({ event: 'snapshot', ...data })}\n\n`);
    } catch { /* ignore */ }

    // Keepalive ping every 25s so proxies don't drop the connection
    const timer = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ event: 'ping', timestamp: Date.now() })}\n\n`); }
      catch { removeSseClient(client); }
    }, 25000);

    const client: SseClient = { res, timer };
    sseClients.add(client);

    req.on('close', () => removeSseClient(client));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
  res.end(JSON.stringify({ error: 'not_found', available: ['/health', '/api/data', '/api/sessions', '/api/tools', '/api/stream'] }));
}

// ─── SERVER LIFECYCLE ────────────────────────────────────────────────────────

export function startServer(port = 3001): http.Server {
  const server = http.createServer(handleRequest);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: aiops serve --port <other-port>`);
      process.exit(1);
    }
    logError('server', 'HTTP server error', err);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  aiops API server running at http://localhost:${port}`);
    console.log(`\n  Endpoints:`);
    console.log(`    GET  http://localhost:${port}/api/data       full snapshot`);
    console.log(`    GET  http://localhost:${port}/api/sessions   sessions array`);
    console.log(`    GET  http://localhost:${port}/api/tools      tool list`);
    console.log(`    GET  http://localhost:${port}/api/stream     SSE live updates`);
    console.log(`    GET  http://localhost:${port}/health         health check`);
    console.log(`\n  Press Ctrl+C to stop.\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    for (const client of sseClients) clearInterval(client.timer);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);

  return server;
}
