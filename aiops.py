"""
Elliot Systems AIOps Client
Single script for enrollment, telemetry reporting, and scheduler setup.

Commands:
    python aiops.py enroll   [--server URL] [--tool claude_code|cursor]
    python aiops.py report   [--date YYYY-MM-DD]
    python aiops.py setup    [--time HH:MM]
    python aiops.py remove
    python aiops.py status
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import socket
import sqlite3
import struct
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_SERVER  = "https://aiops-server.onrender.com"
RENDER_SERVER   = "https://aiops-server.onrender.com"
DEFAULT_TOOL    = "claude_code"
DEFAULT_TIME_PM = "18:00"
DEFAULT_TIME_AM = "09:00"
TASK_NAME_AM    = "ElliotAIOps_Telemetry_AM"
TASK_NAME_PM    = "ElliotAIOps_Telemetry_PM"
TASK_NAME       = "ElliotAIOps_Telemetry"   # legacy — removed on setup/remove
AGENT_VERSION   = "1.0.0"
CONFIG_FILE     = Path.home() / ".aiops" / "config.json"
CLAUDE_DIR      = Path.home() / ".claude"

PLIST_AM   = Path.home() / "Library" / "LaunchAgents" / "com.elliot.aiops.am.plist"
PLIST_PM   = Path.home() / "Library" / "LaunchAgents" / "com.elliot.aiops.pm.plist"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / "com.elliot.aiops.plist"  # legacy


def _app_data() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", "")) or \
               Path.home() / "AppData" / "Roaming"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    else:
        return Path.home() / ".config"

APP_DATA = _app_data()
HOME     = Path.home()

TOOL_PATHS = {
    "claude":    HOME / ".claude" / "projects",
    "gemini_tmp": HOME / ".gemini" / "tmp",
    "gemini_antigravity": HOME / ".gemini" / "antigravity" / "conversations",
    "cursor_db": APP_DATA / "Cursor" / "User" / "globalStorage" / "state.vscdb",
    "windsurf_db": APP_DATA / "Windsurf" / "User" / "globalStorage" / "state.vscdb",
    "cline_tasks": APP_DATA / "Code" / "User" / "globalStorage" / "saoudrizwan.claude-dev" / "tasks",
    "roo_tasks":   APP_DATA / "Code" / "User" / "globalStorage" / "rooveterinaryinc.roo-cline" / "tasks",
    "kilo_tasks":  APP_DATA / "Code" / "User" / "globalStorage" / "kilocode.kilo-code" / "tasks",
    "copilot_workspace": APP_DATA / "Code" / "User" / "workspaceStorage",
    "copilot_global":    APP_DATA / "Code" / "User" / "globalStorage" / "github.copilot-chat",
    "codex_sessions": HOME / ".codex" / "sessions",
}

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def post(server: str, path: str, payload: dict) -> dict:
    import ssl
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        f"{server}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    def _do(ctx=None):
        with urllib.request.urlopen(
            req, context=ctx
        ) as r:
            return json.loads(r.read())
    try:
        return _do(ssl.create_default_context())
    except ssl.SSLCertVerificationError:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode    = ssl.CERT_NONE
        return _do(ctx)
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode())
        raise RuntimeError(
            f"HTTP {e.code}: {body.get('detail', body)}"
        )
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Could not reach server: {e.reason}"
        )


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        print("Not enrolled yet. Run:  python aiops.py enroll")
        sys.exit(1)
    config = json.loads(CONFIG_FILE.read_text())

    # Auto-fix old local IP to Render URL
    old_server = config.get("server", "")
    if old_server != RENDER_SERVER and any(
        x in old_server for x in ("localhost", "192.168", "10.179", "127.0.0.1")
    ):
        config["server"] = RENDER_SERVER
        save_config(config)
        print(f"  Auto-updated server to {RENDER_SERVER}")

    return config


def save_config(data: dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(data, indent=2))


def get_machine_id() -> str:
    return hashlib.sha256(socket.gethostname().encode()).hexdigest()

PRICING = [
    (r"claude-opus-4",        5.00,  25.00,  0.50,  6.25),
    (r"claude-sonnet-4",      3.00,  15.00,  0.30,  3.75),
    (r"claude-haiku-4",       1.00,   5.00,  0.10,  1.25),
    (r"claude-3-7-sonnet",    3.00,  15.00,  0.30,  3.75),
    (r"claude-3-5-sonnet",    3.00,  15.00,  0.30,  3.75),
    (r"claude-3-5-haiku",     0.80,   4.00,  0.08,  1.00),
    (r"claude-3-opus",       15.00,  75.00,  1.50, 18.75),
    (r"claude-3-sonnet",      3.00,  15.00,  0.30,  3.75),
    (r"claude-3-haiku",       0.25,   1.25,  0.03,  0.30),
    (r"gemini-2\.5-pro",      1.25,  10.00,  0.00,  0.00),
    (r"gemini-2\.5-flash",    0.15,   0.60,  0.00,  0.00),
    (r"gemini-2\.0-flash",    0.075,  0.30,  0.02,  0.09),
    (r"gemini-1\.5-flash",    0.075,  0.30,  0.02,  0.09),
    (r"gemini-1\.5-pro",      1.25,   5.00,  0.00,  0.00),
    (r"gemini",               0.075,  0.30,  0.00,  0.00),
    (r"gpt-4\.1-nano",        0.10,   0.40,  0.00,  0.00),
    (r"gpt-4\.1-mini",        0.40,   1.60,  0.00,  0.00),
    (r"gpt-4\.1",             2.00,   8.00,  0.00,  0.00),
    (r"gpt-4o-mini",          0.15,   0.60,  0.075, 0.00),
    (r"gpt-4o",               2.50,  10.00,  0.63,  3.13),
    (r"gpt-4-turbo",         10.00,  30.00,  0.00,  0.00),
    (r"gpt-4",               10.00,  30.00,  0.00,  0.00),
    (r"gpt-3\.5-turbo",       0.50,   1.50,  0.00,  0.00),
    (r"o4-mini",              1.10,   4.40,  0.28,  0.00),
    (r"o3-mini",              1.10,   4.40,  0.28,  0.00),
    (r"o3",                  10.00,  40.00,  2.50,  0.00),
    (r"o1-mini",              3.00,  12.00,  0.75,  0.00),
    (r"\bo1\b",              15.00,  60.00,  3.75,  0.00),
]

def calc_cost(model: str, inp: int, out: int,
              cache_read: int = 0, cache_write: int = 0) -> float:
    model_lower = (model or "").lower()
    for pattern, p_in, p_out, p_cr, p_cw in PRICING:
        if re.search(pattern, model_lower):
            cost = (inp * p_in + out * p_out +
                    cache_read * p_cr +
                    cache_write * p_cw) / 1_000_000
            return round(cost, 6)
    return 0.0


def _print_network_error(err: str):
    print(f"\n  ERROR: {err}\n")
    e = err.lower()
    if "timed out" in e or "operation timed out" in e:
        print("  Cannot reach the server.")
        print("  Check your internet connection.")
    elif "ssl" in e or "certificate" in e:
        print("  SSL certificate error.")
        print("  Fix: pip3 install --upgrade certifi")
        print("  Then run this script again.")
    elif "401" in e or "403" in e:
        print("  Email not registered or access denied.")
        print("  Contact your admin.")
    elif "404" in e:
        print("  Endpoint not found.")
        print("  Contact your admin.")

# ---------------------------------------------------------------------------
# Command: enroll
# ---------------------------------------------------------------------------

def cmd_enroll(args):
    server     = args.server.rstrip("/")
    machine_id = get_machine_id()
    hostname   = socket.gethostname()

    print("=== Elliot Systems AIOps Enrollment ===\n")
    print(f"Server  : {server}")
    print(f"Tool    : {args.tool}")
    print(f"Machine : {hostname}\n")

    email = input("Enter your @elliotsystems.com email: ").strip()
    if not email.endswith("@elliotsystems.com"):
        print("Error: must use an @elliotsystems.com email address.")
        sys.exit(1)

    print("\nSending OTP to your email...")
    try:
        post(server, "/enroll/send-otp", {"email": email})
    except RuntimeError as e:
        _print_network_error(str(e))
        sys.exit(1)
    print("OTP sent. Check your inbox.\n")

    otp = input("Enter the 6-digit OTP from the email: ").strip()

    print("\nVerifying OTP...")
    try:
        verify_resp = post(server, "/enroll/verify-otp", {"email": email, "code": otp})
    except RuntimeError as e:
        _print_network_error(str(e))
        sys.exit(1)

    token = verify_resp.get("enrollment_token")
    if not token:
        print("Error: no enrollment token returned.")
        sys.exit(1)

    print("OTP verified. Registering device...")
    try:
        enroll_resp = post(server, "/enroll/device", {
            "enrollment_token": token,
            "machine_id": machine_id,
            "label": hostname,
            "tool": args.tool,
        })
    except RuntimeError as e:
        _print_network_error(str(e))
        sys.exit(1)

    device_id = enroll_resp.get("device_id")
    save_config({"server": server, "device_id": device_id, "machine_id": machine_id, "tool": args.tool})

    print(f"\nEnrollment complete!")
    print(f"Device ID  : {device_id}")
    print(f"Config     : {CONFIG_FILE}")
    print(f"\nNext steps:")
    print(f"  Set up daily reporting : python aiops.py setup")
    print(f"  Report manually today  : python aiops.py report")

# ---------------------------------------------------------------------------
# Command: report
# ---------------------------------------------------------------------------

# Maps Claude Code tool names to task categories.
# Each (file, date) is treated as one session; classified by dominant tool type.
_TASK_CATEGORIES = [
    "Code Generation",
    "Code Review",
    "Debugging",
    "Testing",
    "Refactoring",
    "Documentation",
    "Research",
    "Architecture",
]

_DOC_EXTENSIONS = (".md", ".txt", ".rst", ".mdx", ".org", ".adoc")


def _classify_session(tool_uses: list) -> str:
    """Classify a list of tool_use dicts into one of the 8 task categories."""
    counts: dict = defaultdict(int)
    doc_edits = 0

    for tu in tool_uses:
        name = tu.get("name", "")
        counts[name] += 1
        if name in ("Edit", "Write", "MultiEdit"):
            fp = tu.get("input", {}).get("file_path", "") or ""
            if any(fp.endswith(ext) for ext in _DOC_EXTENSIONS):
                doc_edits += 1

    edit  = counts["Edit"] + counts["Write"] + counts["MultiEdit"] + counts["NotebookEdit"]
    read  = counts["Read"] + counts["Grep"] + counts["Glob"]
    bash  = counts["Bash"]
    web   = counts["WebSearch"] + counts["WebFetch"]
    todo  = counts["TodoWrite"] + counts["TodoRead"]
    total = sum(counts.values())

    if total == 0:
        return "Code Generation"
    if web > 0 and web / total > 0.15:
        return "Research"
    if todo >= 2:
        return "Architecture"
    if doc_edits > 0 and doc_edits / max(edit, 1) > 0.4:
        return "Documentation"
    if edit > 0 and read > 0:
        ratio = edit / (edit + read)
        if ratio > 0.6:
            # Distinguish Testing from Code Generation by bash presence
            return "Testing" if bash > 0 else "Code Generation"
        elif ratio < 0.4:
            return "Code Review"
        else:
            return "Refactoring"
    if edit >= read and edit >= bash:
        return "Code Generation"
    if read > edit and read >= bash:
        return "Code Review"
    if bash > 0:
        return "Debugging"
    return "Code Generation"


def parse_claude_logs(target_date: str) -> dict:
    """Parse Claude Code logs counting individual sessions."""
    model_data: dict = {}
    projects_dir = TOOL_PATHS["claude"]

    if not projects_dir.exists():
        return {}

    for jsonl_file in projects_dir.rglob("*.jsonl"):
        try:
            content = jsonl_file.read_text(
                encoding="utf-8", errors="replace"
            ).replace("\r\n", "\n")

            session_id = str(jsonl_file)

            for line in content.splitlines():
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if entry.get("type") != "assistant":
                    continue

                ts = entry.get("timestamp", "")
                if not str(ts).startswith(target_date):
                    continue

                msg   = entry.get("message", {})
                usage = msg.get("usage")
                if not usage:
                    continue

                model = msg.get("model", "unknown") or "unknown"
                if model not in model_data:
                    model_data[model] = {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "sessions": set(),
                        "turns": 0,
                    }

                model_data[model]["input_tokens"] += \
                    usage.get("input_tokens", 0)
                model_data[model]["output_tokens"] += \
                    usage.get("output_tokens", 0)
                model_data[model]["cache_read_tokens"] += \
                    usage.get("cache_read_input_tokens", 0)
                model_data[model]["cache_write_tokens"] += \
                    usage.get("cache_creation_input_tokens", 0)
                model_data[model]["sessions"].add(session_id)
                model_data[model]["turns"] += 1

        except Exception:
            continue

    result = {}
    for model, data in model_data.items():
        if data["input_tokens"] + data["output_tokens"] == 0:
            continue
        result[model] = {
            "input_tokens":       data["input_tokens"],
            "output_tokens":      data["output_tokens"],
            "cache_read_tokens":  data["cache_read_tokens"],
            "cache_write_tokens": data["cache_write_tokens"],
            "sessions":           len(data["sessions"]),
            "turns":              data["turns"],
        }
    return result


def _parse_claude_logs_all() -> dict:
    """Scan all dates — used only for historical bulk upload."""
    by_date: dict = defaultdict(lambda: defaultdict(lambda: {
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
    }))
    projects_dir = CLAUDE_DIR / "projects"
    if not projects_dir.exists():
        return {}

    for jsonl_file in projects_dir.rglob("*.jsonl"):
        try:
            for line in jsonl_file.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("type") != "assistant":
                    continue
                ts = entry.get("timestamp", "")
                if len(ts) < 10:
                    continue
                date_str = ts[:10]
                msg   = entry.get("message", {})
                usage = msg.get("usage")
                if not usage:
                    continue
                model = msg.get("model", "unknown") or "unknown"
                by_date[date_str][model]["input_tokens"]       += usage.get("input_tokens", 0)
                by_date[date_str][model]["output_tokens"]      += usage.get("output_tokens", 0)
                by_date[date_str][model]["cache_read_tokens"]  += usage.get("cache_read_input_tokens", 0)
                by_date[date_str][model]["cache_write_tokens"] += usage.get("cache_creation_input_tokens", 0)
        except Exception:
            continue

    return {d: dict(models) for d, models in by_date.items()}


def parse_task_categories() -> dict:
    """
    Classifies each (JSONL file × date) as one session in a task category.
    Returns: { "YYYY-MM-DD": { "Category Name": session_count } }
    """
    by_date: dict = defaultdict(lambda: defaultdict(int))
    projects_dir = CLAUDE_DIR / "projects"
    if not projects_dir.exists():
        return {}

    for jsonl_file in projects_dir.rglob("*.jsonl"):
        # Collect tool_use entries grouped by date for this file
        file_by_date: dict = defaultdict(list)
        try:
            for line in jsonl_file.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("type") != "assistant":
                    continue
                ts = entry.get("timestamp", "")
                if len(ts) < 10:
                    continue
                date_str = ts[:10]
                content = entry.get("message", {}).get("content", [])
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "tool_use":
                            file_by_date[date_str].append({
                                "name":  item.get("name", ""),
                                "input": item.get("input", {}),
                            })
        except Exception:
            continue

        # Each (file, date) pair = 1 session; classify by dominant tools that day
        for date_str, tool_uses in file_by_date.items():
            category = _classify_session(tool_uses)
            by_date[date_str][category] += 1

    return {d: dict(cats) for d, cats in by_date.items()}


def parse_copilot_logs(target_date: str) -> dict:
    """
    Parse GitHub Copilot sessions.
    Reads chatSessions JSON files from workspace storage.
    Also reads state.vscdb for VS Code 1.100+.
    """
    workspace_root = TOOL_PATHS["copilot_workspace"]
    global_storage = TOOL_PATHS["copilot_global"]

    if not workspace_root.exists() and \
       not global_storage.exists():
        return {}

    sessions = []

    # Method 1: Read chatSessions JSON files
    if workspace_root.exists():
        try:
            for ws_dir in workspace_root.iterdir():
                if not ws_dir.is_dir():
                    continue
                chat_dir = ws_dir / "chatSessions"
                if not chat_dir.exists():
                    continue
                for f in chat_dir.glob("*.json"):
                    try:
                        data = json.loads(
                            f.read_text(encoding="utf-8")
                        )
                        if not isinstance(data, dict):
                            continue
                        requests = data.get("requests", [])
                        if not requests:
                            continue

                        is_copilot = any(
                            "github.copilot" in str(
                                r.get("agent", {})
                                 .get("extensionId", {})
                                 .get("value", "")
                            ).lower()
                            for r in requests
                            if isinstance(r, dict)
                        )
                        if not is_copilot:
                            continue

                        first_ts = data.get("creationDate", 0)
                        if first_ts:
                            ts_ms = int(first_ts)
                            file_date = datetime.datetime.fromtimestamp(
                                ts_ms / 1000
                            ).strftime("%Y-%m-%d")
                        else:
                            file_date = datetime.date.fromtimestamp(
                                f.stat().st_mtime
                            ).isoformat()

                        if file_date != target_date:
                            continue

                        input_tokens  = 0
                        output_tokens = 0
                        model = "copilot/auto"
                        turns = 0

                        for r in requests:
                            if not isinstance(r, dict):
                                continue
                            user_text = str(
                                r.get("message", {})
                                 .get("text", "")
                            )
                            input_tokens  += len(user_text) // 4
                            output_tokens += len(user_text) // 8
                            if r.get("result", {}).get("details"):
                                model = r["result"]["details"]\
                                    .split("•")[0].strip() \
                                    or model
                            turns += 1

                        sessions.append({
                            "model":              model or "copilot/auto",
                            "input_tokens":       input_tokens,
                            "output_tokens":      output_tokens,
                            "cache_read_tokens":  0,
                            "cache_write_tokens": 0,
                            "session_id":         str(f),
                            "turns":              turns,
                        })
                    except Exception:
                        continue
        except Exception:
            pass

    # Method 2: Read state.vscdb (VS Code 1.100+)
    global_db = global_storage.parent / "state.vscdb"
    db_paths = []
    if global_db.exists():
        db_paths.append(global_db)

    if workspace_root.exists():
        try:
            for ws_dir in workspace_root.iterdir():
                db = ws_dir / "state.vscdb"
                if db.exists():
                    db_paths.append(db)
        except Exception:
            pass

    for db_path in db_paths:
        try:
            conn = sqlite3.connect(
                f"file:{db_path}?mode=ro", uri=True,
                timeout=3
            )
            try:
                row = conn.execute(
                    "SELECT value FROM ItemTable "
                    "WHERE key = 'chat.ChatSessionStore.index'"
                ).fetchone()
                if not row:
                    continue
                idx = json.loads(row[0])
                entries = idx.get("entries", {})
                if isinstance(entries, dict):
                    entries = list(entries.values())
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    if entry.get("isEmpty") is not False:
                        continue
                    created = entry.get("timing", {}) \
                                   .get("created", 0) or \
                              entry.get("lastMessageDate", 0)
                    if not created:
                        continue
                    entry_date = datetime.datetime.fromtimestamp(
                        int(created) / 1000
                    ).strftime("%Y-%m-%d")
                    if entry_date != target_date:
                        continue
                    sessions.append({
                        "model":              "copilot/auto",
                        "input_tokens":       0,
                        "output_tokens":      0,
                        "cache_read_tokens":  0,
                        "cache_write_tokens": 0,
                        "session_id":         entry.get(
                            "sessionId", str(db_path)
                        ),
                        "turns": 1,
                    })
            finally:
                conn.close()
        except Exception:
            continue

    if not sessions:
        return {}

    model_data: dict = {}
    seen_sessions: set = set()
    for s in sessions:
        sid = s["session_id"]
        if sid in seen_sessions:
            continue
        seen_sessions.add(sid)
        model = s["model"]
        if model not in model_data:
            model_data[model] = {
                "input_tokens": 0, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "sessions": 0, "turns": 0,
            }
        model_data[model]["input_tokens"]  += s["input_tokens"]
        model_data[model]["output_tokens"] += s["output_tokens"]
        model_data[model]["sessions"]      += 1
        model_data[model]["turns"]         += s["turns"]

    return model_data


def parse_cursor_logs(target_date: str) -> dict:
    """
    Parse Cursor AI sessions from state.vscdb SQLite file.
    Reads composerData entries from cursorDiskKV table.
    """
    db_path = TOOL_PATHS["cursor_db"]
    if not db_path.exists():
        return {}

    model_data: dict = {}

    try:
        conn = sqlite3.connect(
            f"file:{db_path}?mode=ro", uri=True,
            timeout=3
        )
        try:
            tables = [
                r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table'"
                ).fetchall()
            ]
            if "cursorDiskKV" not in tables:
                return {}

            rows = conn.execute(
                "SELECT key, value FROM cursorDiskKV "
                "WHERE key LIKE 'composerData:%'"
            ).fetchall()

            for key, value in rows:
                try:
                    data = json.loads(value)
                    if not isinstance(data, dict):
                        continue

                    composer_id = key.replace(
                        "composerData:", ""
                    )

                    created_at = data.get("createdAt", 0)
                    if created_at:
                        entry_date = datetime.datetime\
                            .fromtimestamp(
                                int(created_at) / 1000
                                if int(created_at) > 1e10
                                else int(created_at)
                            ).strftime("%Y-%m-%d")
                        if entry_date != target_date:
                            continue

                    model      = ""
                    inp        = 0
                    out        = 0
                    turns      = 0
                    has_tokens = False

                    bubble_rows = conn.execute(
                        "SELECT value FROM cursorDiskKV "
                        "WHERE key LIKE ?",
                        (f"bubbleId:{composer_id}:%",)
                    ).fetchall()

                    for (bval,) in bubble_rows:
                        try:
                            b = json.loads(bval)
                            if not isinstance(b, dict):
                                continue
                            btype = int(b.get("type", -1))
                            if btype == 1:
                                turns += 1
                                if not model:
                                    mi = b.get("modelInfo", {})
                                    if isinstance(mi, dict):
                                        model = str(
                                            mi.get(
                                                "modelName", ""
                                            )
                                        )
                                tc = b.get("tokenCount", {})
                                if isinstance(tc, dict):
                                    i = int(tc.get(
                                        "inputTokens",
                                        tc.get("input_tokens", 0)
                                    ))
                                    o = int(tc.get(
                                        "outputTokens",
                                        tc.get("output_tokens", 0)
                                    ))
                                    if i > 0 or o > 0:
                                        has_tokens = True
                                        inp += i
                                        out += o
                        except Exception:
                            continue

                    if turns == 0:
                        continue

                    if not model:
                        mc = data.get("modelConfig", {})
                        if isinstance(mc, dict):
                            model = str(
                                mc.get("modelName", "")
                            )
                    model = model or "cursor"

                    if model not in model_data:
                        model_data[model] = {
                            "input_tokens": 0,
                            "output_tokens": 0,
                            "cache_read_tokens": 0,
                            "cache_write_tokens": 0,
                            "sessions": 0, "turns": 0,
                        }
                    model_data[model]["input_tokens"]  += inp
                    model_data[model]["output_tokens"] += out
                    model_data[model]["sessions"]      += 1
                    model_data[model]["turns"]         += turns

                except Exception:
                    continue
        finally:
            conn.close()
    except Exception:
        pass

    return model_data


def parse_gemini_logs(target_date: str) -> dict:
    """
    Parse Gemini CLI logs.
    Reads .jsonl files from ~/.gemini/tmp/
    Also reads .pb files from antigravity folder.
    """
    model_data: dict = {}

    # Method 1: JSONL files in tmp
    tmp_dir = TOOL_PATHS["gemini_tmp"]
    if tmp_dir.exists():
        for f in tmp_dir.rglob("*.jsonl"):
            try:
                mtime_date = datetime.date.fromtimestamp(
                    f.stat().st_mtime
                ).isoformat()
                if mtime_date != target_date:
                    continue

                content = f.read_text(
                    encoding="utf-8", errors="replace"
                ).replace("\r\n", "\n")

                model      = ""
                inp        = 0
                out        = 0
                cache_read = 0
                turns      = 0
                has_usage  = False

                for line in content.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if not model:
                        m = entry.get("modelVersion") or \
                            entry.get("model", "")
                        if m:
                            model = str(m)

                    role = str(
                        entry.get("role", entry.get("type", ""))
                    )
                    if role in ("assistant", "model"):
                        turns += 1

                    meta = entry.get("usageMetadata")
                    if meta and isinstance(meta, dict):
                        has_usage = True
                        inp        += int(meta.get(
                            "promptTokenCount",
                            meta.get("input_tokens", 0)
                        ))
                        out        += int(meta.get(
                            "candidatesTokenCount",
                            meta.get("output_tokens", 0)
                        ))
                        cache_read += int(meta.get(
                            "cachedContentTokenCount", 0
                        ))

                if not has_usage:
                    total_chars = len(content)
                    inp = int(total_chars * 0.6 / 4)
                    out = int(total_chars * 0.4 / 4)

                model = model or "gemini-2.0-flash"
                if model not in model_data:
                    model_data[model] = {
                        "input_tokens": 0, "output_tokens": 0,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "sessions": 0, "turns": 0,
                    }
                model_data[model]["input_tokens"]      += inp
                model_data[model]["output_tokens"]     += out
                model_data[model]["cache_read_tokens"] += cache_read
                model_data[model]["sessions"]          += 1
                model_data[model]["turns"]             += turns
            except Exception:
                continue

    # Method 2: Antigravity .pb files (binary — estimate size)
    ag_dir = TOOL_PATHS["gemini_antigravity"]
    if ag_dir.exists():
        try:
            for f in ag_dir.glob("*.pb"):
                try:
                    mtime_date = datetime.date.fromtimestamp(
                        f.stat().st_mtime
                    ).isoformat()
                    if mtime_date != target_date:
                        continue
                    size   = f.stat().st_size
                    est    = size // 5
                    inp    = int(est * 0.6)
                    out    = int(est * 0.4)
                    model  = "gemini-antigravity"
                    if model not in model_data:
                        model_data[model] = {
                            "input_tokens": 0, "output_tokens": 0,
                            "cache_read_tokens": 0,
                            "cache_write_tokens": 0,
                            "sessions": 0, "turns": 0,
                        }
                    model_data[model]["input_tokens"]  += inp
                    model_data[model]["output_tokens"] += out
                    model_data[model]["sessions"]      += 1
                except Exception:
                    continue
        except Exception:
            pass

    return model_data


def parse_windsurf_logs(target_date: str) -> dict:
    """
    Parse Windsurf sessions from state.vscdb.
    Reads chat.ChatSessionStore.index from ItemTable.
    """
    db_path = TOOL_PATHS["windsurf_db"]
    if not db_path.exists():
        return {}

    model_data: dict = {}

    try:
        conn = sqlite3.connect(
            f"file:{db_path}?mode=ro", uri=True,
            timeout=3
        )
        try:
            tables = [
                r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table'"
                ).fetchall()
            ]
            if "ItemTable" not in tables:
                return {}

            row = conn.execute(
                "SELECT value FROM ItemTable "
                "WHERE key = 'chat.ChatSessionStore.index'"
            ).fetchone()

            if not row:
                return {}

            index = json.loads(row[0])
            sessions_list = (
                index.get("entries") or
                index.get("sessions") or
                index.get("chatSessions") or
                (index if isinstance(index, list) else [])
            )

            if isinstance(sessions_list, dict):
                sessions_list = list(sessions_list.values())

            for s in sessions_list:
                if not isinstance(s, dict):
                    continue
                ts = (
                    s.get("createdAt") or
                    s.get("lastUpdated") or
                    s.get("timestamp") or 0
                )
                if ts:
                    ts_int = int(ts)
                    if ts_int > 1e10:
                        ts_int = ts_int // 1000
                    entry_date = datetime.datetime\
                        .fromtimestamp(ts_int)\
                        .strftime("%Y-%m-%d")
                    if entry_date != target_date:
                        continue

                inp = int(
                    s.get("inputTokens") or
                    s.get("tokensIn") or
                    s.get("input_tokens") or 0
                )
                out = int(
                    s.get("outputTokens") or
                    s.get("tokensOut") or
                    s.get("output_tokens") or 0
                )

                if inp == 0 and out == 0:
                    text = json.dumps(s)
                    inp  = len(text) // 4
                    out  = len(text) // 10

                model = str(
                    s.get("model") or
                    s.get("modelId") or
                    "windsurf"
                )
                turns = int(
                    s.get("turns") or
                    s.get("turnCount") or 1
                )

                if model not in model_data:
                    model_data[model] = {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "sessions": 0, "turns": 0,
                    }
                model_data[model]["input_tokens"]  += inp
                model_data[model]["output_tokens"] += out
                model_data[model]["sessions"]      += 1
                model_data[model]["turns"]         += turns

        finally:
            conn.close()
    except Exception:
        pass

    return model_data


def parse_cline_family_logs(
    target_date: str,
    tasks_dir: Path,
    tool_name: str
) -> dict:
    """
    Parse Cline/Roo/Kilo tasks.
    Reads ui_messages.json from each task directory.
    """
    if not tasks_dir.exists():
        return {}

    model_data: dict = {}

    try:
        task_dirs = [
            d for d in tasks_dir.iterdir()
            if d.is_dir()
        ]
    except Exception:
        return {}

    for td in task_dirs:
        try:
            td_date = datetime.date.fromtimestamp(
                td.stat().st_mtime
            ).isoformat()
            if td_date != target_date:
                continue

            ui_msgs_path = td / "ui_messages.json"
            if not ui_msgs_path.exists():
                continue

            try:
                ui_messages = json.loads(
                    ui_msgs_path.read_text(encoding="utf-8")
                )
            except Exception:
                continue

            if not isinstance(ui_messages, list):
                continue

            model       = ""
            inp         = 0
            out         = 0
            cache_read  = 0
            cache_write = 0
            turns       = 0
            cost_usd    = 0.0
            has_tokens  = False
            has_cost    = False

            for m in ui_messages:
                if not isinstance(m, dict):
                    continue

                if not model:
                    if m.get("model"):
                        model = str(m["model"])
                    elif isinstance(m.get("modelInfo"), dict):
                        model = str(
                            m["modelInfo"].get("modelId", "")
                        )

                if (m.get("type") == "say" and
                    m.get("say") == "api_req_started" and
                    m.get("text")):
                    try:
                        p = json.loads(str(m["text"]))
                        if not model and p.get("model"):
                            model = str(p["model"])

                        def _tok(key, *fb):
                            for k in [key] + list(fb):
                                v = p.get(k)
                                if v is not None:
                                    try:
                                        n = int(v)
                                        if n >= 0:
                                            return n
                                    except Exception:
                                        pass
                            return 0

                        i  = _tok("tokensIn", "inputTokens",
                                  "input_tokens",
                                  "promptTokenCount")
                        o  = _tok("tokensOut", "outputTokens",
                                  "output_tokens",
                                  "candidatesTokenCount")
                        cr = _tok("cacheReads",
                                  "cacheReadTokens",
                                  "cache_read_input_tokens")
                        cw = _tok("cacheWrites",
                                  "cacheWriteTokens",
                                  "cache_creation_input_tokens")

                        if i > 0 or o > 0:
                            has_tokens   = True
                            inp         += i
                            out         += o
                            cache_read  += cr
                            cache_write += cw
                            turns       += 1

                        tc = p.get("totalCost") or \
                             p.get("cost")
                        if tc is not None:
                            try:
                                tc_f = float(tc)
                                if tc_f > 0:
                                    has_cost  = True
                                    cost_usd += tc_f
                            except Exception:
                                pass
                    except Exception:
                        continue

            # Fallback: read history_item.json
            if not has_tokens and not has_cost:
                hist_path = td / "history_item.json"
                if hist_path.exists():
                    try:
                        hist = json.loads(
                            hist_path.read_text(encoding="utf-8")
                        )
                        if isinstance(hist, dict):
                            i = hist.get("tokensIn", 0)
                            o = hist.get("tokensOut", 0)
                            c = hist.get("totalCost", 0)
                            if i and int(i) > 0:
                                inp        = int(i)
                                out        = int(o or 0)
                                has_tokens = True
                            if c and float(c) > 0:
                                cost_usd = float(c)
                                has_cost = True
                    except Exception:
                        pass

            if inp + out == 0 and not has_cost:
                continue

            if not model:
                model = "unknown"

            if model not in model_data:
                model_data[model] = {
                    "input_tokens": 0, "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "sessions": 0, "turns": 0,
                }
            model_data[model]["input_tokens"]       += inp
            model_data[model]["output_tokens"]      += out
            model_data[model]["cache_read_tokens"]  += cache_read
            model_data[model]["cache_write_tokens"] += cache_write
            model_data[model]["sessions"]           += 1
            model_data[model]["turns"]              += turns

        except Exception:
            continue

    return model_data


def parse_cline_logs(target_date: str) -> dict:
    return parse_cline_family_logs(
        target_date, TOOL_PATHS["cline_tasks"], "cline"
    )

def parse_roo_logs(target_date: str) -> dict:
    return parse_cline_family_logs(
        target_date, TOOL_PATHS["roo_tasks"], "roo"
    )

def parse_kilo_logs(target_date: str) -> dict:
    return parse_cline_family_logs(
        target_date, TOOL_PATHS["kilo_tasks"], "kilo"
    )


def _ensure_scheduler_up_to_date():
    """Silently recreate the scheduler if it is missing."""
    if not CONFIG_FILE.exists():
        return
    if task_exists():
        return
    python_exe  = sys.executable
    script_path = str(Path(__file__).resolve())
    try:
        if IS_WINDOWS:
            _setup_windows(python_exe, script_path)
        else:
            _setup_mac(python_exe, script_path)
    except Exception:
        pass


def cmd_report(args):
    config    = load_config()
    server    = config["server"]
    device_id = config["device_id"]
    target    = args.date   # None means all historical dates

    try:
        _ensure_scheduler_up_to_date()
    except Exception:
        pass

    print("AIOps Telemetry Report")
    print(f"Server    : {server}")
    print(f"Device ID : {device_id}")
    print(f"Date      : {target if target else 'all'}\n")

    submitted = skipped = 0

    if target:
        # ── Single date: scan ALL tools ──────────────────────────────────
        print(f"Scanning all AI tool logs...\n")

        tool_scanners = [
            ("claude_code", parse_claude_logs),
            ("copilot",     parse_copilot_logs),
            ("gemini",      parse_gemini_logs),
            ("cline",       parse_cline_logs),
            ("roo",         parse_roo_logs),
            ("kilo",        parse_kilo_logs),
            ("cursor",      parse_cursor_logs),
            ("windsurf",    parse_windsurf_logs),
        ]

        tool_count = 0

        for tool_name, scanner in tool_scanners:
            try:
                usage_by_model = scanner(target)
            except Exception as e:
                continue

            if not usage_by_model:
                continue

            tool_submitted = 0
            total_sessions = 0

            for model, usage in usage_by_model.items():
                if usage.get("input_tokens", 0) + \
                   usage.get("output_tokens", 0) == 0 and \
                   usage.get("sessions", 0) == 0:
                    continue

                ikey = hashlib.sha256(
                    f"{device_id}:{target}:{tool_name}:{model}"
                    .encode()
                ).hexdigest()[:64]

                payload = {
                    "device_id":          device_id,
                    "date":               target,
                    "tool":               tool_name,
                    "model":              model,
                    "input_tokens":       usage.get("input_tokens", 0),
                    "output_tokens":      usage.get("output_tokens", 0),
                    "cache_read_tokens":  usage.get("cache_read_tokens", 0),
                    "cache_write_tokens": usage.get("cache_write_tokens", 0),
                    "idempotency_key":    ikey,
                    "agent_version":      AGENT_VERSION,
                }

                try:
                    resp = post(
                        server,
                        "/telemetry/daily-rollup",
                        payload
                    )
                    tool_submitted += 1
                    submitted      += 1
                    total_sessions += usage.get("sessions", 0)
                except RuntimeError as e:
                    err = str(e)
                    if "already_exists" in err or \
                       "duplicate" in err.lower() or \
                       "409" in err:
                        skipped += 1
                    else:
                        print(f"  {tool_name}/{model}: ERROR — {e}")

            if tool_submitted > 0:
                tool_count += 1
                print(
                    f"  ✓ {tool_name}: "
                    f"{total_sessions} sessions — "
                    f"{tool_submitted} model(s) sent"
                )

        print(f"\n{'─'*50}")
        print(f"  Summary — {target}")
        print(f"{'─'*50}")
        print(f"  Tools with data : {tool_count}")
        print(f"  Records sent    : {submitted}")
        print(f"  Already existed : {skipped}")
        print(f"  Server          : {server}")
        print(f"{'─'*50}\n")

    else:
        # ── All dates: Claude Code historical scan ───────────────────────
        print("Scanning Claude Code logs (all historical dates)...")
        all_data = _parse_claude_logs_all()

        if not all_data:
            print("No Claude Code usage found in logs.")
            return

        tool = config.get("tool", "claude_code")
        errors = 0
        for date in sorted(all_data.keys()):
            for model, usage in all_data[date].items():
                if usage["input_tokens"] + usage["output_tokens"] == 0:
                    continue
                ikey = hashlib.sha256(
                    f"{device_id}:{date}:{tool}:{model}".encode()
                ).hexdigest()[:64]
                payload = {
                    "device_id":          device_id,
                    "date":               date,
                    "tool":               tool,
                    "model":              model,
                    "input_tokens":       usage["input_tokens"],
                    "output_tokens":      usage["output_tokens"],
                    "cache_read_tokens":  usage["cache_read_tokens"],
                    "cache_write_tokens": usage["cache_write_tokens"],
                    "idempotency_key":    ikey,
                    "agent_version":      AGENT_VERSION,
                }
                try:
                    resp = post(server, "/telemetry/daily-rollup", payload)
                    print(f"  {date}  {model}: {usage['input_tokens']}in / {usage['output_tokens']}out → usage_id={resp['usage_id']}")
                    submitted += 1
                except RuntimeError as e:
                    if "already_exists" in str(e) or "duplicate" in str(e).lower():
                        skipped += 1
                    else:
                        print(f"  {date}  {model}: ERROR — {e}")
                        errors += 1

        total_dates = len([d for d, m in all_data.items() if any(
            u["input_tokens"] + u["output_tokens"] > 0 for u in m.values())])
        print(f"\nDone. {submitted} submitted, {skipped} already existed, {errors} errors. ({total_dates} active dates scanned)")

    # ── Task category breakdown (always) ────────────────────────────────
    print("\nScanning task categories from log patterns...")
    all_categories = parse_task_categories()
    cat_submitted = cat_skipped = 0
    for date in sorted(all_categories.keys()):
        if target and date != target:
            continue
        cat_counts = all_categories[date]
        if not cat_counts:
            continue
        ikey = hashlib.sha256(f"{device_id}:{date}:categories:v1".encode()).hexdigest()[:64]
        payload = {
            "device_id":       device_id,
            "date":            date,
            "categories":      cat_counts,
            "idempotency_key": ikey,
        }
        try:
            post(server, "/telemetry/categories", payload)
            cat_submitted += 1
        except RuntimeError as e:
            if "already_exists" in str(e) or "duplicate" in str(e).lower():
                cat_skipped += 1
            else:
                print(f"  {date} categories: ERROR — {e}")

    print(f"Categories: {cat_submitted} dates submitted, {cat_skipped} already existed.")

# ---------------------------------------------------------------------------
# Command: setup  (Task Scheduler on Windows, launchd on Mac)
# ---------------------------------------------------------------------------

IS_WINDOWS = sys.platform == "win32"


def task_exists() -> bool:
    if IS_WINDOWS:
        r = subprocess.run(
            ["schtasks", "/query", "/tn", TASK_NAME],
            capture_output=True, check=False
        )
        return r.returncode == 0
    else:
        return PLIST_PATH.exists()


def _remove_legacy(python_exe=None, script_path=None):
    """Clean up the old single-task setup if it exists."""
    if IS_WINDOWS:
        subprocess.run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"], capture_output=True, check=False)
    else:
        if PLIST_PATH.exists():
            subprocess.run(["launchctl", "unload", str(PLIST_PATH)], capture_output=True, check=False)
            PLIST_PATH.unlink(missing_ok=True)


def cmd_setup(args):
    python_exe  = sys.executable
    script_path = str(Path(__file__).resolve())

    _remove_legacy()

    if IS_WINDOWS:
        _setup_windows(python_exe, script_path)
    else:
        _setup_mac(python_exe, script_path)


def _setup_windows(python_exe, script_path, time_str=None):
    # Remove existing tasks
    for suffix in ['', '_2', '_3', '_4', '_5', '_6', '_7']:
        subprocess.run(
            ["schtasks", "/delete", "/tn", TASK_NAME + suffix, "/f"],
            capture_output=True
        )

    # Create tasks for every 2 hours
    times    = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"]
    suffixes = ['', '_2', '_3', '_4', '_5', '_6', '_7']
    cmd      = f'"{python_exe}" "{script_path}" report'

    created = 0
    for t, s in zip(times, suffixes):
        result = subprocess.run([
            "schtasks", "/create",
            "/tn", TASK_NAME + s,
            "/tr", cmd,
            "/sc", "DAILY",
            "/st", t,
            "/f",
        ], capture_output=True, text=True)
        if result.returncode == 0:
            created += 1

    if created > 0:
        print(f"Scheduler set up. Runs every 2 hours.")
        print(f"  8am 10am 12pm 2pm 4pm 6pm 8pm")
    else:
        print(f"Failed to create scheduled tasks.")
        print(f"Try running as Administrator.")
        sys.exit(1)


def _make_plist(python_exe: str, script_path: str, label: str, log_path: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python_exe}</string>
        <string>{script_path}</string>
        <string>report</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Hour</key><integer>8</integer>
              <key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>10</integer>
              <key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>12</integer>
              <key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>14</integer>
              <key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>16</integer>
              <key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>18</integer>
              <key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>20</integer>
              <key>Minute</key><integer>0</integer></dict>
    </array>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{log_path}</string>
</dict>
</plist>"""


def _setup_mac(python_exe, script_path):
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    log_path = str(Path.home() / ".aiops" / "telemetry.log")

    # Remove old AM/PM plists if they exist
    for old_plist in [PLIST_AM, PLIST_PM]:
        if old_plist.exists():
            subprocess.run(["launchctl", "unload", str(old_plist)], capture_output=True, check=False)
            old_plist.unlink(missing_ok=True)

    if PLIST_PATH.exists():
        subprocess.run(["launchctl", "unload", str(PLIST_PATH)], capture_output=True, check=False)
    PLIST_PATH.write_text(_make_plist(python_exe, script_path, "com.elliot.aiops", log_path))
    subprocess.run(["launchctl", "load", str(PLIST_PATH)], capture_output=True, check=False)

    print(f"Scheduler set up. Runs every 2 hours")
    print(f"  8am 10am 12pm 2pm 4pm 6pm 8pm")
    print(f"Log file: {log_path}")


def cmd_remove(_args):
    if IS_WINDOWS:
        removed = 0
        for suffix in ['', '_2', '_3', '_4', '_5', '_6', '_7']:
            r = subprocess.run(
                ["schtasks", "/delete", "/tn", TASK_NAME + suffix, "/f"],
                capture_output=True
            )
            if r.returncode == 0:
                removed += 1
        if removed > 0:
            print(f"Scheduled tasks removed.")
        else:
            print(f"No tasks found.")
    else:
        removed = False
        for plist_path in [PLIST_PATH, PLIST_AM, PLIST_PM]:
            if plist_path.exists():
                subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True, check=False)
                plist_path.unlink(missing_ok=True)
                removed = True
        if removed:
            print(f"Scheduled task removed.")
        else:
            print(f"No tasks found.")

# ---------------------------------------------------------------------------
# Command: install  (enroll + setup in one go)
# ---------------------------------------------------------------------------

def cmd_install(args):
    print("=" * 50)
    print("  Elliot Systems AIOps — One-Click Install")
    print("=" * 50)
    print()

    print("STEP 1 of 2: Enrolling this machine...\n")
    cmd_enroll(args)

    print()
    print("STEP 2 of 2: Setting up telemetry scheduler...\n")
    cmd_setup(args)

    print()
    print("=" * 50)
    print("  Installation complete!")
    print("  Usage will be reported every 2 hours.")
    print("  8am, 10am, 12pm, 2pm, 4pm, 6pm, 8pm")
    print("  Historical logs are also submitted automatically.")
    print("=" * 50)
    input("\nPress Enter to close...")

# ---------------------------------------------------------------------------
# Command: status
# ---------------------------------------------------------------------------

def cmd_status(_args):
    print("=== AIOps Status ===\n")
    if CONFIG_FILE.exists():
        config = json.loads(CONFIG_FILE.read_text())
        print(f"Enrolled      : yes")
        print(f"Device ID     : {config.get('device_id')}")
        print(f"Server        : {config.get('server')}")
        print(f"Tool          : {config.get('tool')}")
        print(f"Config file   : {CONFIG_FILE}")
    else:
        print(f"Enrolled      : no  (run: python aiops.py enroll)")

    print(f"Scheduler     : {'active' if task_exists() else 'not set up'}")
    if task_exists():
        print(f"  Tip: Run 'python aiops.py setup' to")
        print(f"       update to every-2-hour schedule")

    print(f"\nTool log paths:")
    home = Path.home()
    paths = {
        "Claude Code": CLAUDE_DIR / "projects",
        "Copilot":     home / "Library" / "Application Support" / "Code" / "User" / "globalStorage" / "github.copilot-chat",
        "Cursor":      home / "Library" / "Application Support" / "Cursor",
        "Gemini":      home / ".gemini",
        "Windsurf":    home / "Library" / "Application Support" / "Windsurf",
    }
    for name, path in paths.items():
        exists = "✓" if path.exists() else "✗"
        print(f"  {exists} {name}: {path}")

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog="aiops.py",
        description="Elliot Systems AIOps Client",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Commands:\n"
            "  enroll   Register this machine\n"
            "  report   Post all usage (or --date YYYY-MM-DD for a single day)\n"
            "  setup    Create twice-daily scheduler tasks (9 AM + 6 PM)\n"
            "  remove   Remove all scheduled tasks\n"
            "  status   Show enrollment and scheduler state\n"
        ),
    )
    sub = parser.add_subparsers(dest="command")

    p_install = sub.add_parser("install", help="Enroll + set up scheduler in one step")
    p_install.add_argument("--server", default=DEFAULT_SERVER)
    p_install.add_argument("--tool", default=DEFAULT_TOOL, choices=["claude_code", "cursor"])

    p_enroll = sub.add_parser("enroll", help="Register this machine")
    p_enroll.add_argument("--server", default=DEFAULT_SERVER)
    p_enroll.add_argument("--tool", default=DEFAULT_TOOL, choices=["claude_code", "cursor"])

    p_report = sub.add_parser("report", help="Post usage to AIOps server")
    p_report.add_argument("--date", default=None, help="YYYY-MM-DD (default: all historical dates)")

    sub.add_parser("setup", help="Create every-2-hour scheduled tasks (8am–8pm)")
    sub.add_parser("remove", help="Remove all scheduled tasks")
    sub.add_parser("status", help="Show enrollment and scheduler state")

    args = parser.parse_args()

    if args.command == "install":   cmd_install(args)
    elif args.command == "enroll":  cmd_enroll(args)
    elif args.command == "report":  cmd_report(args)
    elif args.command == "setup":   cmd_setup(args)
    elif args.command == "remove":  cmd_remove(args)
    elif args.command == "status":  cmd_status(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
