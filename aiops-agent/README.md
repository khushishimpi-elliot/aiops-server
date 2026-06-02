# AIOps Agent

**Monitor your AI coding tool usage and costs — completely offline, no API keys, no data sent anywhere by default.**

AIOps Agent is a command-line tool for developers and engineering teams who want to understand exactly how much they are spending on AI coding tools like Claude Code, Gemini CLI, Cursor, Windsurf, Cline, and others. It reads the session log files that these tools already save on your machine, counts tokens, calculates costs using official pricing, and prints a clean report in your terminal. Nothing leaves your machine unless you explicitly configure a company server. No AI is used anywhere inside this tool — it is entirely deterministic keyword matching and arithmetic.

---

## Table of Contents

1. [What It Does](#1-what-it-does)
2. [What It Tracks](#2-what-it-tracks)
3. [Requirements](#3-requirements)
4. [Installation and Setup](#4-installation-and-setup)
5. [How To Run](#5-how-to-run)
6. [Connecting to a Company Server](#6-connecting-to-a-company-server)
7. [Sample Output](#7-sample-output)
8. [Privacy and Security](#8-privacy-and-security)
9. [Troubleshooting](#9-troubleshooting)
10. [Project Structure](#10-project-structure)
11. [How It Works Technically](#11-how-it-works-technically)
12. [Future Roadmap](#12-future-roadmap)

---

## 1. What It Does

### What is AIOps Agent

AIOps Agent is a local CLI tool that scans your machine for AI coding tool activity, calculates token usage and costs, and shows you a complete usage report. It supports Claude Code, Gemini CLI, Cursor, Windsurf, Cline, Roo Code, Kilo Code, and more.

### What Problem It Solves

When a developer uses AI coding tools daily, costs add up quickly — often without anyone realising how much or on what. AIOps Agent gives developers and their managers a clear picture: which tools are being used, how heavily, what models, what it costs, and whether usage is growing or stagnating. This is useful for personal tracking, team budget reviews, and company-wide AI adoption reporting.

### How It Works

```
Developer uses AI tools (Claude Code, Cursor, Gemini CLI...)
                        ↓
     AI tools save session log files on disk automatically
                        ↓
      AIOps Agent reads those log files (read-only, never modifies)
                        ↓
         Counts tokens and calculates cost per model pricing
                        ↓
        Shows clean report in terminal + saves detection-report.json
                        ↓
  (Optional) Sends aggregate numbers to company server for team dashboards
```

---

## 2. What It Tracks

### AI Tools Detected

| Tool | Platform | Where Log Files Live | What Is Extracted |
|---|---|---|---|
| **Claude Code** | Mac / Linux / Windows | `~/.claude/projects/**/*.jsonl` | Token counts, model, cost, project name, turn count, first prompt |
| **Gemini CLI** | Mac / Linux / Windows | `~/.gemini/tmp/**/*.jsonl` | Token counts, model, cost, turn count |
| **Gemini Antigravity** | Mac / Linux | `~/.gemini/antigravity/conversations/*.pb` | File size → estimated token count |
| **Cursor** | Mac / Windows | `AppData/Cursor/User/globalStorage/state.vscdb` | Sessions from SQLite, model, turn count |
| **Windsurf** | Mac / Windows | `AppData/Windsurf/User/globalStorage/state.vscdb` | Sessions from SQLite, model, token counts |
| **Cline** | Mac / Linux / Windows | `AppData/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/` | Token counts, cost, model from ui_messages.json |
| **Roo Code** | Mac / Linux / Windows | `AppData/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/` | Same as Cline |
| **Kilo Code** | Mac / Linux / Windows | `AppData/Code/User/globalStorage/kilocode.kilo-code/tasks/` | Same as Cline |

The following tools are detected for presence (session data not yet parsed):

- Claude Agent, Codex, Kiro, OpenCode, OpenClaw, Goose, Qwen, Pi, OMP, Factory

### What Are Tokens

Every time you send a message to an AI model, the text is broken into small pieces called tokens. Roughly 4 characters equals 1 token. Models charge per million tokens. This tool counts both input tokens (what you send) and output tokens (what the AI replies), plus cache tokens (reused context that costs less).

**Example:** A typical 10-turn conversation with Claude Sonnet uses around 50,000–200,000 tokens, costing $0.10–$0.60.

### Token Count Sources

Tokens are read from one of three sources (shown as `~` prefix if estimated):

| Source | How | Accuracy |
|---|---|---|
| `log_file` | Read directly from the tool's session file | Exact |
| `tiktoken` | Counted using `gpt-tokenizer` library | ~2–5% error |
| `estimate` | Character count ÷ 4 | ~10–20% error |

### What the Readiness Score Means

The readiness score (0–100) measures how effectively a developer is adopting AI tools over the past 28 days. It is used in team reporting to identify who is getting value from AI tooling.

| Component | Weight | What It Measures |
|---|---|---|
| **Engagement** | 25 pts | How many days out of 28 the developer used AI tools |
| **Depth** | 25 pts | How long conversations go (average turns per session) |
| **Coverage** | 20 pts | How many different task categories the developer uses AI for |
| **Progression** | 15 pts | Whether usage is growing week over week |
| **Friction** | 15 pts | How few sessions were abandoned immediately (≤2 turns) |

A score of 70+ means the developer is using AI tools consistently and deeply. Below 40 suggests light or infrequent use.

### Task Categories

The tool classifies each session by reading the first user message and matching keywords. No AI is used — it is purely keyword matching.

| Category | Keywords Detected |
|---|---|
| `debugging` | fix, bug, error, issue, broken, crash, exception, debug, failing |
| `code_generation` | create, build, implement, add, generate, make, new |
| `analysis` | explain, what, how, why, understand, describe, analyse, analyze |
| `automation` | test, spec, coverage, mock, unit, jest, pytest |
| `configuration` | configure, setup, install, config, settings, init |
| `research` | research, find, search, look up |
| `writing` | document, readme, draft, write, docs |
| `other` | everything else |

### Pricing Coverage

Costs are calculated using official published pricing (USD per million tokens) for:

- **Anthropic:** Claude Opus 4, Sonnet 4, Haiku 4, and all Claude 3.x variants
- **Google:** Gemini 2.5 Pro/Flash, 2.0 Flash, 1.5 Pro/Flash, 1.0 Pro
- **OpenAI:** GPT-4.1, GPT-4o, GPT-4-turbo, GPT-3.5, o1, o3, o4-mini
- **DeepSeek, Mistral, Meta Llama, Qwen, Microsoft Phi, Cohere**

Unknown models fall back to a mid-range estimate of $1.00 input / $3.00 output per million tokens.

---

## 3. Requirements

| Requirement | Details |
|---|---|
| **Node.js** | Version 18.0.0 or higher — download from [nodejs.org](https://nodejs.org/) |
| **npm** | Included with Node.js — version 8+ |
| **Operating System** | macOS, Linux, or Windows 10/11 |
| **Disk Space** | ~50 MB for dependencies |
| **API Keys** | None required — completely offline |
| **Internet** | Not required for scanning — only needed for company server sync |
| **AI Tools** | At least one supported AI tool (Claude Code, Cursor, etc.) must have been used |

**Windows only:** To read Cursor and Windsurf data, `better-sqlite3` must compile. This requires Visual Studio C++ build tools or Python. See [Troubleshooting](#9-troubleshooting) if this fails — the tool works fine without it, just skipping those two tools.

---

## 4. Installation and Setup

### Mac / Linux — One Command

**Step 1** — Clone or download this project:
```bash
git clone <repo-url>
cd aiops-npm-v1
```

**Step 2** — Open a terminal in the project folder, then run:
```bash
bash setup.sh
```

That is it. The setup script checks your Node.js version, installs dependencies, compiles TypeScript, installs the `aiops` command globally, and runs a test scan.

---

### Windows — One Command

**Step 1** — Download and install Node.js from [nodejs.org](https://nodejs.org/) (LTS version recommended).

**Step 2** — Open **Command Prompt** or **PowerShell** (as Administrator is not required but helps with global install).

**Step 3** — Navigate to the project folder:
```bat
cd path\to\aiops-npm-v1
```

**Step 4** — Run setup:
```bat
setup.bat
```

That is it. The batch file fixes PowerShell execution policy issues, checks Node.js is installed, and runs the cross-platform setup script.

---

### Manual Setup (if setup scripts fail)

Use this if you prefer to run steps individually or if the automated setup encounters an error.

**Step 1** — Install dependencies:
```bash
npm install
```

**Step 2** — Build TypeScript to JavaScript:
```bash
npx tsc
```

**Step 3** — Install the `aiops` command globally:
```bash
npm install -g .
```

**Step 4** — Verify installation:
```bash
aiops --help
```

If you see the command list, installation succeeded.

---

### Running Without Global Install

If you cannot or do not want to install globally, run directly:
```bash
node dist/cli.js scan
node dist/cli.js --help
```

---

## 5. How To Run

### The Main Command

```bash
aiops scan
```

Run this first. It does everything:
- Scans your machine for all supported AI tools
- Reads all session data
- Counts tokens and calculates costs
- Shows a complete formatted report in the terminal
- Saves `detection-report.json` in the current folder

---

### All Available Commands

| Command | Description |
|---|---|
| `aiops scan` | **Full scan and report — run this first** |
| `aiops summary` | Alias for `aiops scan` |
| `aiops report` | Today's usage table by tool |
| `aiops report -w` | Last 7 days, broken down by day |
| `aiops report -m` | This month, broken down by week |
| `aiops report -y` | This year, broken down by month |
| `aiops tokens` | Token breakdown by tool (input / output / cache) |
| `aiops cost` | Cost breakdown by tool with average per session |
| `aiops sessions` | Last 15 sessions with date, model, turns, cost |
| `aiops daily` | Today's usage (same as `aiops report`) |
| `aiops weekly` | Last 7 days (same as `aiops report -w`) |
| `aiops monthly` | Monthly view (same as `aiops report -m`) |
| `aiops analyze` | Output full adoption analysis as JSON (for integrations) |
| `aiops analyze -o report.json` | Save JSON analysis to a file |
| `aiops serve` | Start a local HTTP API server on port 3001 |
| `aiops serve --port 4000` | Start the API server on a custom port |
| `aiops status` | Quick health check: version, session count, today's cost |
| `aiops logs` | View last 20 error log entries |
| `aiops --help` | Show all commands |
| `aiops scan --json` | Output the scan as machine-readable JSON |

---

### The Local HTTP API Server

`aiops serve` starts a lightweight HTTP API on `localhost:3001` that a dashboard or browser extension can query without running CLI commands.

| Endpoint | Method | Returns |
|---|---|---|
| `/health` | GET | `{ ok: true }` — confirm server is running |
| `/api/data` | GET | Full snapshot: tools, sessions, summary, period stats |
| `/api/sessions` | GET | Array of all session records |
| `/api/tools` | GET | Array of tool summaries |
| `/api/stream` | GET | Server-Sent Events — pushes live updates when session files change |

The server only listens on `127.0.0.1` — it cannot be reached from other machines. CORS is allowed for `localhost` origins on any port.

---

## 6. Connecting to a Company Server

AIOps Agent can forward aggregated usage data to a company backend so managers and team leads can see adoption across the team without collecting any content from developers.

### How It Works

The tool reads `AIOPS_SERVER_URL` from your environment. When that variable is set, it sends session records (numbers only — no prompts, no code) to that endpoint via HTTP POST. Up to 3 retries are attempted automatically if the request fails.

### Setup Steps

**Step 1** — Get the company server URL from your administrator.

**Step 2** — Set the environment variable in your shell profile:

**Mac / Linux** — add to `~/.zshrc` or `~/.bashrc`:
```bash
export AIOPS_SERVER_URL=https://your-company-server.com/api/sessions
```

**Windows** — add as a system environment variable:
```bat
setx AIOPS_SERVER_URL "https://your-company-server.com/api/sessions"
```

**Step 3** — Restart your terminal, then verify:
```bash
aiops status
```

**Step 4** — Run a scan — data is sent automatically after scanning:
```bash
aiops scan
```

**Step 5** — For dashboard integration, start the local API server:
```bash
aiops serve
```
Then point your dashboard at `http://localhost:3001/api/data`.

---

### What Is Sent (Numbers Only — Privacy Safe)

```
date
tool name (e.g. "claude", "cursor")
model name (e.g. "claude-sonnet-4-6")
task category (e.g. "debugging")
session count
token counts (input / output / cache)
cost in USD
readiness score
```

### What Is Never Sent

```
your actual prompts
AI responses
file contents
source code
project names or paths
personal data of any kind
```

---

## 7. Sample Output

Below is the full output of `aiops scan`:

```
─────────────────────────────────────────────────────
  AIOps Agent  v1.0.0    May 18, 2026    macOS
  Scanned in 0.1s
─────────────────────────────────────────────────────

─────────────────────────────────────────────────────

  TOOLS DETECTED

  ✅  Claude Code          26 sessions    $70.424    sonnet-4-6
  ✅  Gemini CLI            4 sessions     $0.014    gemini-antigravity
  ✅  Cursor                1 session           —    default
  ✅  Windsurf              0 sessions          —    —
  ✅  Cline                 2 sessions          —    gemini-2.0-flash
  ✅  Roo Code              1 session           —    —
  ✅  Kilo Code             0 sessions          —    —
  ✅  Codex              detected
  ✅  Pi                 detected
  ───────────────────────────────────────────────────
      Total              34 sessions    $70.438

─────────────────────────────────────────────────────

  USAGE THIS MONTH

  ┌────────┬──────────┬────────┬─────────┐
  │ Period │ Sessions │ Tokens │    Cost │
  ├────────┼──────────┼────────┼─────────┤
  │ Today  │        2 │   2.4M │  $1.595 │
  ├────────┼──────────┼────────┼─────────┤
  │ Week   │       29 │  85.6M │ $48.312 │
  ├────────┼──────────┼────────┼─────────┤
  │ Month  │       34 │ 111.5M │ $70.438 │
  ├────────┼──────────┼────────┼─────────┤
  │ Year   │       34 │ 111.5M │ $70.438 │
  └────────┴──────────┴────────┴─────────┘

─────────────────────────────────────────────────────

  TOKENS

  Input               57,095    tokens sent to AI
  Output           1,371,386    tokens received from AI
  Cache          110,035,721    tokens reused (saves money)
  ─────────────────────────────────────────────────
  Total          111,464,202    tokens total

─────────────────────────────────────────────────────

  WHAT YOU USE AI FOR

  Other               ███████████░░░░░   68%   23 sessions
  Analysis            ██░░░░░░░░░░░░░░   15%    5 sessions
  Code Generation     ██░░░░░░░░░░░░░░   12%    4 sessions
  Configuration       ░░░░░░░░░░░░░░░░    3%    1 session
  Debugging           ░░░░░░░░░░░░░░░░    3%    1 session

─────────────────────────────────────────────────────

  MODELS USED

  sonnet-4-6               22 sessions    $68.391    65%
  haiku-4-5                 4 sessions     $2.033    12%
  gemini-antigravity        3 sessions     $0.010     9%
  gemini-3-flash-preview    1 session      $0.004     3%

─────────────────────────────────────────────────────

  MODEL COST BREAKDOWN

  ┌─────────────────────────────┬──────────────┬───────────────┬──────────────┬──────────────┬──────────┬───────┐
  │ Model                       │ Input tokens │ Output tokens │ Cache tokens │ Total tokens │     Cost │ Share │
  ├─────────────────────────────┼──────────────┼───────────────┼──────────────┼──────────────┼──────────┼───────┤
  │ claude-sonnet-4-6           │       14,004 │     1,324,243 │  104,070,340 │  105,408,587 │ $68.3909 │ 97.1% │
  ├─────────────────────────────┼──────────────┼───────────────┼──────────────┼──────────────┼──────────┼───────┤
  │ claude-haiku-4-5-20251001   │        4,691 │        21,542 │    5,965,381 │    5,991,614 │  $2.0328 │  2.9% │
  ├─────────────────────────────┼──────────────┼───────────────┼──────────────┼──────────────┼──────────┼───────┤
  │ TOTAL                       │       57,095 │     1,371,386 │  110,035,721 │  111,464,202 │ $70.4375 │  100% │
  └─────────────────────────────┴──────────────┴───────────────┴──────────────┴──────────────┴──────────┴───────┘

─────────────────────────────────────────────────────

  TOP PROJECTS BY COST

  Aiops-npm              $18.356      3 sessions    26%
  AIOps-Insights-master  $17.977      2 sessions    26%
  claude-monitor-copy    $17.007      2 sessions    24%
  subagents               $7.649      7 sessions    11%

─────────────────────────────────────────────────────

  READINESS SCORE

  67 / 100   █████████████████░░░░░░░░░

  Engagement      ██████░░░░░░░   12/25    7 active days
  Depth           █████████████   25/25    avg 83.2 turns
  Coverage        █████████░░░░   14/20    5 task types used
  Progression     ███████░░░░░░    8/15    new user
  Friction        ███████░░░░░░    8/15    24% abandoned

─────────────────────────────────────────────────────
  Report saved to detection-report.json  (3 KB)

─────────────────────────────────────────────────────
```

> **Note:** Values marked with `~` are estimated. Exact values come directly from the tool's log files.

---

## 8. Privacy and Security

| Topic | Detail |
|---|---|
| **Data stays local by default** | All scanning and reporting happens on your machine. Nothing is sent anywhere unless you set `AIOPS_SERVER_URL`. |
| **Log files are read-only** | The tool never writes to, modifies, or deletes any AI tool log file. |
| **No AI used inside this tool** | Task classification uses keyword matching. Token counting uses a local library. No external AI calls are made. |
| **No API keys required** | The tool works entirely offline. |
| **Only aggregate numbers sent** | If a server is configured, only counts and costs are transmitted — never prompts, responses, or file contents. |
| **Local error log** | Errors are logged to `~/.aiops/error.log`. This file stays on your machine. |
| **SQLite databases opened read-only** | Cursor and Windsurf databases are opened with `{ readonly: true, fileMustExist: true }` — they cannot be corrupted. |

---

## 9. Troubleshooting

### `aiops` command not found

```bash
npm install -g .
```
Then close and reopen your terminal. If it still fails, try:
```bash
node dist/cli.js scan
```

---

### No sessions found

The tool found no AI tool data on this machine.

1. Make sure you have used Claude Code, Cursor, Gemini CLI, or another supported tool at least once.
2. Check the expected paths exist — for Claude Code: `~/.claude/projects/`
3. Run again:
```bash
aiops scan
```

---

### TypeScript build errors

```bash
# Check TypeScript is installed
npx tsc --version

# Reinstall dependencies
npm install

# Rebuild
npx tsc
```

---

### SQLite error on Windows (Cursor / Windsurf data missing)

Cursor and Windsurf store data in SQLite databases that require a compiled native module (`better-sqlite3`). If it failed to build:

```bash
npm install better-sqlite3 --build-from-source
```

If that fails, install Windows C++ build tools first:
```bash
npm install --global windows-build-tools
```
Then retry the above. The tool works fine without SQLite — it just skips Cursor and Windsurf.

---

### Permission denied on Mac (global install)

```bash
sudo npm install -g .
```

Or install to your home directory to avoid needing sudo:
```bash
npm config set prefix ~/.npm-global
npm install -g .
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

---

### Token counts show `~` (tilde) prefix

This means the tool's log files did not contain token counts (common for Windsurf free tier and older Cursor versions). The `~` means the number is estimated from text length. Results will still be useful for relative comparisons but may be off by 10–20%.

---

### Cannot connect to company server

1. Check `AIOPS_SERVER_URL` is set: `echo $AIOPS_SERVER_URL`
2. Confirm the URL is correct and the server is reachable
3. Check your internet connection
4. Try `aiops status` to see current session counts
5. Check error logs: `aiops logs`

---

### npm install fails entirely on Windows

If `npm install` fails because of the `postinstall` script (rebuilding `better-sqlite3`), run without scripts first:
```bash
npm install --ignore-scripts
npx tsc
npm install -g .
```
Cursor and Windsurf data will be skipped but everything else works.

---

## 10. Project Structure

```
aiops-npm-v1/
│
├── src/                          TypeScript source code (compiled to dist/)
│   │
│   ├── cli.ts                    All CLI commands: scan, report, tokens, cost,
│   │                             sessions, status, logs, analyze, serve, and more
│   │
│   ├── core/                     Core modules used by all adapters
│   │   ├── paths.ts              Resolves correct paths for each OS (Mac/Linux/Windows)
│   │   ├── pricing.ts            Token pricing for 30+ models ($/million tokens)
│   │   ├── tokenizer.ts          Token counting with gpt-tokenizer fallback
│   │   ├── analyst.ts            28-day adoption analysis engine (readiness score)
│   │   ├── server.ts             Local HTTP API server with SSE live updates
│   │   ├── watcher.ts            File watcher — detects new sessions in real time
│   │   ├── sender.ts             Sends aggregate data to company server (optional)
│   │   ├── storage.ts            In-memory session storage with batching
│   │   ├── logger.ts             Error logging to ~/.aiops/error.log
│   │   └── types.ts              TypeScript interfaces: SessionRecord, AdapterResult
│   │
│   ├── adapters/                 One adapter per AI tool — each reads that tool's data
│   │   ├── index.ts              Runs all adapters and aggregates results
│   │   ├── claude.ts             Reads Claude Code JSONL session files
│   │   ├── gemini.ts             Reads Gemini CLI JSONL files and .pb antigravity files
│   │   ├── cursor.ts             Reads Cursor SQLite database (requires better-sqlite3)
│   │   ├── windsurf.ts           Reads Windsurf SQLite database (requires better-sqlite3)
│   │   ├── cline.ts              Reads Cline, Roo Code, and Kilo Code task directories
│   │   ├── roo.ts                Thin wrapper — calls cline adapter with Roo paths
│   │   └── kilo.ts               Thin wrapper — calls cline adapter with Kilo paths
│   │
│   ├── reader.js                 Legacy: reads Claude JSONL files (used by claude-monitor)
│   ├── watcher.js                Legacy: watches Claude projects dir (used by claude-monitor)
│   ├── tokenizer.js              Legacy: counts tokens (used by claude-monitor)
│   ├── parser.js                 Legacy: parses Claude session format (used by claude-monitor)
│   └── pricing.js                Legacy: Claude-only pricing (used by claude-monitor)
│
├── bin/
│   └── claude-monitor.js         Standalone Claude-only monitor (legacy, pre-multitools)
│
├── dist/                         Compiled JavaScript output (generated by npx tsc)
│   ├── cli.js                    Compiled entry point
│   ├── core/                     Compiled core modules
│   └── adapters/                 Compiled adapters
│
├── setup.sh                      One-command setup for Mac and Linux
├── setup.bat                     One-command setup for Windows (Command Prompt)
├── setup.ps1                     PowerShell setup script (alternative Windows option)
├── setup.mjs                     Cross-platform Node.js setup logic (called by all above)
├── package.json                  Project config, dependencies, npm scripts
├── tsconfig.json                 TypeScript compiler settings (ES2022, NodeNext modules)
├── detection-report.json         Last scan result saved as JSON (auto-generated)
└── README.md                     This file
```

---

## 11. How It Works Technically

### Token Counting — Three Tiers

The tool tries each method in order and falls back to the next if the current one is unavailable.

**Tier 1 — Read from log file (preferred)**
- Claude Code, Gemini CLI, and Cline store token counts directly in their session files
- These numbers are exact — they come from the API response
- Displayed without any `~` prefix

**Tier 2 — gpt-tokenizer library (fallback)**
- When session files do not contain token counts, the `gpt-tokenizer` library is used
- It tokenises the conversation text locally — no network call
- Error margin: approximately 2–5%
- Displayed with `tiktoken` as the source

**Tier 3 — Character estimation (final fallback)**
- If the library fails to load or the text is unavailable, characters ÷ 4 is used
- Error margin: approximately 10–20%
- Displayed with `~` prefix

### Cost Calculation

```
cost = (input_tokens  / 1,000,000) × input_price_per_million
     + (output_tokens / 1,000,000) × output_price_per_million
     + (cache_read    / 1,000,000) × cache_read_price_per_million
     + (cache_write   / 1,000,000) × cache_write_price_per_million
```

Prices are hardcoded in `src/core/pricing.ts` using official published rates from Anthropic, Google, and OpenAI. Model names are matched with regex patterns — more specific patterns always take priority over general ones.

### Task Detection

```
1. Read the first user message from the session file
2. Convert to lowercase
3. Test against keyword regex patterns in order
4. Return the first matching category, or "other"
```

No AI model is called. No external service is contacted. The classification takes microseconds.

### Readiness Score Calculation

Each component has a fixed maximum and is calculated from the last 28 days of data:

```
Engagement  (max 25) — active_days mapped to bands: 3→2, 7→6, 14→12, 20→18, 28→25
Depth       (max 25) — avg_turns_per_session mapped: 2→3, 5→8, 10→14, 15→20, 20+→25
Coverage    (max 20) — distinct_categories mapped: 1→3, 2→8, 4→14, 6+→20
Progression (max 15) — week_over_week_trend: declining→2, flat→5, +20%→8, +50%→12, +50%+→15
Friction    (max 15) — abandoned_pct mapped: 50%+→2, 35%→5, 20%→8, 10%→12, <10%→15

Total = sum of all five components (0–100)
```

### How Adapters Work

Each adapter in `src/adapters/` follows the same pattern:

1. Check whether the tool's data directory or database file exists
2. If not found, return empty result immediately (no error)
3. Read the data (JSONL files or SQLite database)
4. Parse sessions into `SessionRecord` objects
5. Calculate costs using `calcCost()` from `pricing.ts`
6. Return the session array plus error stats

SQLite databases (Cursor, Windsurf) are always opened with `readonly: true` and `fileMustExist: true`, and are wrapped in try-catch so a locked database (common on Windows) is silently skipped rather than crashing the tool.

---

## 12. Future Roadmap

| Phase | Description | Status |
|---|---|---|
| **Phase 1** | Local CLI with multi-tool scanning and cost reporting | ✅ Complete |
| **Phase 2** | Company server backend (`aiops-sight`) — `enroll` and `sync` commands, authentication, team aggregation | 🔄 Planned |
| **Phase 3** | Company dashboard — Elliot-branded web UI for managers and team leads | 🔄 Planned |
| **Phase 4** | Docker deployment — one-command self-hosted server setup | 🔄 Planned |
| **Phase 5** | Additional tool support — GitHub Copilot, Kiro, Goose (full parsing), Factory, OpenCode | 🔄 Planned |

---

## Quick Reference

```bash
# First time — install and scan
bash setup.sh          # Mac / Linux
setup.bat              # Windows

# Daily use
aiops scan             # Full report
aiops report           # Today only
aiops report -w        # Last 7 days
aiops cost             # Cost by tool
aiops tokens           # Token breakdown
aiops sessions         # Recent sessions list
aiops status           # Quick health check

# Debugging
aiops logs             # View error log
node dist/cli.js scan  # Run without global install

# Dashboard integration
aiops serve            # Start API at http://localhost:3001
aiops analyze          # Output JSON analysis report
```
