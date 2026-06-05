# AIOps Agent CLI - Complete Documentation

## Overview

The AIOps Agent is a cross-platform CLI tool that monitors AI coding tool usage and costs on your machine. It scans for sessions from multiple AI tools (Claude Code, Cursor, Gemini, Cline, etc.), calculates token usage and costs, and optionally syncs aggregated data to a company server.

**Version:** 1.0.0  
**Entry Point:** `src/cli.ts` (bundled to `dist/cli.cjs`)  
**Runtime:** Node.js 18+

---

## High-Level Architecture

```
┌─ CLI Commands (program setup)
│
├─ Adapters (runAllAdapters)
│  └─ Scans AI tool session logs → SessionRecord[]
│
├─ Database (optional, SQLite)
│  └─ Persists sessions for historical trending
│
├─ Sync Module
│  └─ Aggregates & sends to company server
│
└─ Daemon (background process)
   └─ Auto-sync every 15min + post-session
```

---

## Core Commands

### 1. **`aiops start`** - Full initialization (recommended)
Runs a complete setup: scan → persist → sync → show history.
- **Flow:**
  1. Check enrollment status
  2. Scan for AI tool sessions
  3. Persist to local SQLite DB
  4. Sync to server (if enrolled)
  5. Display 28-day history with tables

### 2. **`aiops watch [--interval]`** - Continuous monitoring
Background monitoring with periodic scans and syncs.
- **Default:** scans every 5 minutes
- **Output:** Timestamp + session count + sync status
- **Enrollment:** Works locally if not enrolled

### 3. **`aiops scan [--json]`** - Full detection & report
Deep machine scan producing a comprehensive report.
- **Output:** Formatted terminal report (or JSON with `--json`)
- **Includes:**
  - Tools detected (with installation status)
  - Usage by period (today/week/month/year)
  - Token breakdown (input/output/cache)
  - Task categorization (debug, code generation, analysis, etc.)
  - Model usage and cost breakdown
  - Top projects by cost
  - **Readiness Score** (engagement, depth, coverage, progression, friction)
  - Insights (e.g., "usage growing +23%", "30% abandoned")
- **Saves:** `detection-report.json` with structured metrics

### 4. **`aiops report [-w|-m|-y]`** - Quick usage reports
- `report` (default) → today's usage by tool
- `-w` → last 7 days by day
- `-m` → monthly by week
- `-y` → yearly by month

### 5. **`aiops status`** - System health check
Displays:
- Version, OS, uptime
- Total sessions found
- Cost today
- Last session timestamp
- DB availability & stats
- Enrollment status
- Daemon status & auto-start setting

### 6. **`aiops tokens`** - Token breakdown by tool
Table of input/output/cache tokens per tool + total.

### 7. **`aiops cost`** - Cost breakdown by tool
Cost + average cost per session per tool.

### 8. **`aiops sessions`** - Recent sessions (last 15)
Shows: date, tool, model, turns, tokens, cost per session.

### 9. **`aiops daily|weekly|monthly`** - Shorthand reports
Aliases for quick period reports.

### 10. **`aiops logs`** - Error log viewer
Shows last 20 error entries; useful for debugging.

### 11. **`aiops history [--days N]`** - Persisted history
Requires SQLite DB. Shows:
- **Daily table:** sessions/tokens/cost by date
- **Weekly table:** week-over-week trending with % change
- **By-tool table:** sessions/tokens/cost per tool

### 12. **`aiops budget [--set|--daily|--weekly|--monthly]`** - Budget management
Set spending limits and see current usage vs. limits.
- Example: `aiops budget --daily 5 --weekly 25 --monthly 200`
- Alerts on scan if over 80%

### 13. **`aiops analyze [-o file]`** - AI adoption analyst
Runs `runAnalysis()` → outputs structured JSON (to file or stdout).

### 14. **`aiops serve [-p PORT]`** - Local API server
Starts HTTP server (default port 3001) for programmatic access.

### 15. **`aiops enroll [--server URL] [--email]`** - Server enrollment
Device registration with email auth.
- Fetches enrollment token
- Registers machine ID
- Saves API token to config

### 16. **`aiops sync [--days N] [--dry-run]`** - Manual data sync
Sends aggregated session data to company server.
- `--dry-run`: preview without sending
- `--days N`: how many days to include (default: full history = 3650 days)

### 17. **`aiops daemon`** - Background sync process
Runs as background daemon; typically auto-started by OS.

### 18. **`aiops install`** - Auto-start registration
Registers daemon to start at login (launchd/systemd/Task Scheduler).

### 19. **`aiops uninstall`** - Remove auto-start
Removes daemon registration and stops running daemon.

---

## Data Model

### `SessionRecord` Type
```typescript
{
  tool: string;                    // "Claude Code", "Cursor", "Gemini", etc.
  model: string;                   // e.g., "claude-opus-4.1-20250514"
  sessionDate: string;             // YYYY-MM-DD
  sessionTimestamp: number;        // Unix ms
  turnCount: number;               // total turns (user + assistant)
  userTurnCount?: number;          // user turns only
  inputTokens: number;             // tokens sent to AI
  outputTokens: number;            // tokens received from AI
  cacheReadTokens: number;         // cache reuse tokens
  cacheWriteTokens: number;        // cache write tokens
  totalTokens: number;             // sum of above
  costUSD: number;                 // computed cost
  firstPrompt?: string;            // first user prompt (used for classification)
  projectName?: string;            // inferred project
  tokenSource?: 'exact'|'estimate';// is cost estimated?
}
```

### Cost Calculation
- Pulled from per-model pricing (via adapters)
- Based on input/output/cache tokens
- Estimates when exact data unavailable
- Persisted to SQLite for trending

---

## Format Helpers

### Token Formatting
- `fmtTokens(n)` → short form (1.2K, 45M, or —)
- `fmtTokensFull(n)` → full with commas (1,234,567)
- `fmtCost(n)` → currency (e.g., $0.045, —)

### Date Formatting
- `dayLabel(d)` → "Mon, Jun 4"
- `weekLabel(d)` → "Week of Jun 2"
- `monthLabel(d)` → "June 2025"
- `fmtDate(ts)` → "Jun 4, 12:34 PM"

### Visual Formatting
- `bar(pct, width)` → progress bar in cyan/gray
- `divider()` → dashed separator
- `section(title)` → formatted section header

---

## Metric Computation

### Task Classification (`classifyTask`)
Regex-based keyword matching on first prompt:
- **debugging** → "fix", "bug", "error", "crash", etc.
- **code_generation** → "write", "create", "build", "implement"
- **analysis** → "explain", "what", "how", "why", "understand"
- **automation** → "test", "spec", "coverage", "mock", "jest"
- **configuration** → "configure", "setup", "install", "settings"
- **research** → "research", "find", "search", "lookup"
- **writing** → "document", "readme", "draft"
- **other** → default

### Readiness Score (0-100)
Composite metric based on:
- **Engagement (0-25):** active days in last 28 (threshold: 3/7/14/20 days)
- **Depth (0-25):** avg turns per session (threshold: 2/5/10/15 turns)
- **Coverage (0-20):** distinct task categories (threshold: 2/4/6)
- **Progression (0-15):** week-over-week growth trend
- **Friction (0-15):** abandoned session rate (< 10%/20%/35%/50%)

---

## Database Schema

SQLite at `~/.aiops/sessions.db`:
```sql
-- Persists flattened sessions for historical trending
-- Upserted on each scan by (date, tool, model, category)
-- Supports week-over-week, monthly, and yearly aggregates
```

### Key DB Functions (imported from `core/db.js`)
- `openDb()` — initialize connection
- `upsertSessions(records)` — persist + dedupe
- `getDailyTotals(days)` → {date, sessions, tokens, cost}[]
- `getWeeklyTotals(weeks)` → {weekStart, sessions, tokens, cost}[]
- `getHistoricalSummary(days)` → detailed breakdown by day/week/tool
- `getBudgets()` → active budget limits
- `setBudget(period, limit)` — set daily/weekly/monthly limits
- `getRecentScans(n)` → last N scans with new session counts
- `getDbStats()` → {totalRows, dbSizeKb, oldestDate}

---

## Server Sync Module

### Enrollment Flow
1. User runs `aiops enroll --server URL --email user@company.com`
2. POST to `/enroll/email-auth` → get enrollment token
3. POST to `/api/enroll` with machine ID → get API token
4. Config saved to `~/.aiops/config.json`

### Sync Strategy
- **Aggregated:** sessions grouped by (date, tool, model, category)
- **Idempotent:** full history re-sent (server upserts by key)
- **Safe:** raw prompts never leave device; only aggregate counts
- **Retry:** 3 retry attempts with exponential backoff; graceful degradation if server unavailable

### Sync Function (from `core/syncer.js`)
```typescript
await syncToServer(days, dryRun)
// Returns: {success, aggregatesSent, daysIncluded, error?, preview?}
```

---

## Daemon & Auto-Start

### Daemon Process
- Background sync every 15 minutes
- Triggered immediately post-session (via file watch)
- Runs continuously; auto-restarts on reboot

### Installation Methods
- **macOS:** launchd plist → `~/Library/LaunchAgents/`
- **Windows:** Task Scheduler with same user context
- **Linux:** systemd user service → `~/.config/systemd/user/`

### Log File
Daemon output at: `$HOME/.aiops/daemon.log`

---

## Key Features

### 1. Cross-Tool Support
Detects sessions from:
- Claude Code (web, CLI, IDE extensions)
- Cursor
- Gemini CLI
- Cline
- Windsurf
- OpenCode, OpenClaw, Goose, Qwen, OMP, Factory (if installed)

### 2. Multi-Model Pricing
Handles dynamic pricing for:
- Claude (opus, sonnet, haiku)
- Gemini (2.0, 1.5, 1.0)
- Other models (extensible)

### 3. Prompt Caching Support
Tracks cache read/write tokens separately; distinguishes cache efficiency.

### 4. Task Attribution
Classifies work by keyword matching (not ML); supports custom tagging.

### 5. Platform Detection
Reports OS (macOS, Windows, Linux) with OS version.

### 6. Offline-First
Works entirely local; server sync is optional.

### 7. Budget Alerts
Configurable daily/weekly/monthly spending limits with visual thresholds (green/yellow/red).

---

## JSON Report Format

`detection-report.json` includes:
```json
{
  "report_generated": "ISO 8601 timestamp",
  "period": "last_28_days",
  "tools_detected": ["Claude Code", "Cursor"],
  "engagement": {
    "total_sessions": 42,
    "sessions_per_week": {"W1": 15, "W2": 12, ...},
    "active_days": 18,
    "active_days_per_week": 4.5,
    "total_user_prompts": 89
  },
  "depth": {
    "avg_turns_per_session": 7.2,
    "multi_turn_rate": 68,
    "deep_session_rate": 42,
    "longest_session_turns": 31
  },
  "task_coverage": {
    "task_category_breakdown": {"debugging": {count: 18, pct: 43}, ...},
    "primary_use_case": "debugging",
    "task_diversity_score": 75
  },
  "tokens": {
    "input": 234567,
    "output": 156789,
    "cache_read": 45000,
    "cache_write": 12000,
    "total": 448356
  },
  "total_cost_usd": 15.234,
  "readiness_score": 72,
  "readiness_breakdown": {...},
  "top_3_use_cases": ["debugging", "code_generation", "analysis"],
  "top_models": [{model: "claude-opus-4.1", sessions: 25, cost_usd: 8.50}, ...],
  "top_projects": [{project: "myapp", sessions: 18, cost_usd: 5.20}, ...]
}
```

---

## Configuration

### Config File
Location: `~/.aiops/config.json`
```json
{
  "serverUrl": "https://company-aiops.example.com",
  "enrollmentToken": "token-xxx",
  "machineId": "unique-machine-id",
  "enrolledAt": "2025-06-04T12:00:00Z"
}
```

### Environment-Aware Paths
Uses `core/paths.js` to locate log files for:
- Claude Code
- Cursor
- Gemini CLI
- Cline
- Windsurf
- Custom tools (OpenCode, OpenClaw, etc.)

---

## Error Handling

### Graceful Degradation
- **No tools found** → prints helpful message (not an error)
- **DB unavailable** → shows warning; continue with live scan
- **Server sync fails** → saves locally; retries next scan
- **Invalid email/enrollment** → clear error + usage hint
- **Bad port number** → validation + exit(1)

### Logging
- Errors logged to `~/.aiops/error.log`
- `readLastLines(20)` shown in `aiops logs` command
- Daemon logs to `~/.aiops/daemon.log`

---

## Constants & Tuning

```typescript
const VERSION = '1.0.0';
const FULL_HISTORY_DAYS = 3650;  // ~10 years; safe for re-send on sync

// Readiness scoring thresholds (tunable)
const ENGAGEMENT_TIERS = [3, 7, 14, 20];  // active days
const DEPTH_TIERS = [2, 5, 10, 15];       // avg turns
const COVERAGE_TIERS = [2, 4, 6];         // distinct categories
```

---

## Usage Examples

```bash
# Start monitoring (one-shot + history)
aiops start

# Continuous background sync (5-minute intervals)
aiops watch

# Full scan report (formatted)
aiops scan

# JSON report
aiops scan --json

# Weekly usage
aiops report -w

# Budget management
aiops budget --monthly 100

# Enroll with company server
aiops enroll --server https://mycompany.aiops.ai --email user@company.com

# Sync data to server
aiops sync

# View persisted history (from DB)
aiops history --days 90

# Enable auto-start (daemon)
aiops install

# Check system status
aiops status
```

---

## Performance Notes

- **Scan time:** typically 0.5–2s (depends on log file sizes)
- **DB operations:** SQLite with WAL; fast inserts
- **Memory footprint:** ~30–50 MB during scan
- **Network:** sync is async; doesn't block local commands
- **Polling:** 5-minute default; adjustable via `--interval`

---

## Future Extensions

Potential areas for enhancement:
- Real-time metrics dashboard (via `aiops serve`)
- ML-based task classification (current: regex)
- Cost optimization suggestions (carbon footprint, model alternatives)
- Audit trail (who used what when)
- Team-level aggregation (enterprise)
