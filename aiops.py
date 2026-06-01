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
import socket
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
            "hostname": hostname,
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


def parse_claude_logs() -> dict:
    """
    Scans all Claude Code log files across all projects and dates.
    Returns: { "YYYY-MM-DD": { "model-name": { input_tokens, output_tokens,
                                                cache_read_tokens, cache_write_tokens } } }
    """
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
                model = msg.get("model", "unknown")
                by_date[date_str][model]["input_tokens"]       += usage.get("input_tokens", 0)
                by_date[date_str][model]["output_tokens"]      += usage.get("output_tokens", 0)
                by_date[date_str][model]["cache_read_tokens"]  += usage.get("cache_read_input_tokens", 0)
                by_date[date_str][model]["cache_write_tokens"] += usage.get("cache_creation_input_tokens", 0)
        except Exception:
            continue

    return {date: dict(models) for date, models in by_date.items()}


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


def _parse_claude_for_date(target_date: str) -> dict:
    """Return Claude Code usage for a single date."""
    return parse_claude_logs().get(target_date, {})


def parse_copilot_logs(target_date: str) -> dict:
    """Read GitHub Copilot usage from VSCode storage."""
    totals: dict = defaultdict(lambda: {
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
    })

    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", ""))
        possible_paths = [
            appdata / "Code" / "User" / "globalStorage" / "github.copilot-chat" / "chatSessions",
            appdata / "Code - Insiders" / "User" / "globalStorage" / "github.copilot-chat" / "chatSessions",
        ]
    else:
        home = Path.home()
        possible_paths = [
            home / "Library" / "Application Support" / "Code" / "User" / "globalStorage" / "github.copilot-chat" / "chatSessions",
            home / ".config" / "Code" / "User" / "globalStorage" / "github.copilot-chat" / "chatSessions",
        ]

    sessions_found = 0
    for base_path in possible_paths:
        if not base_path.exists():
            continue
        for f in base_path.rglob("*.json"):
            try:
                mtime = datetime.date.fromtimestamp(f.stat().st_mtime).isoformat()
                if mtime != target_date:
                    continue
                json.loads(f.read_text(encoding="utf-8"))
                sessions_found += 1
                totals["copilot/auto"]["input_tokens"]  += 500
                totals["copilot/auto"]["output_tokens"] += 250
            except Exception:
                continue

    return dict(totals) if sessions_found > 0 else {}


def parse_cursor_logs(target_date: str) -> dict:
    """Read Cursor AI usage from SQLite storage."""
    import sqlite3
    totals: dict = defaultdict(lambda: {
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
    })

    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", ""))
        possible_paths = [appdata / "Cursor" / "User" / "globalStorage" / "state.vscdb"]
    else:
        home = Path.home()
        possible_paths = [
            home / "Library" / "Application Support" / "Cursor" / "User" / "globalStorage" / "state.vscdb",
            home / ".config" / "Cursor" / "User" / "globalStorage" / "state.vscdb",
        ]

    for db_path in possible_paths:
        if not db_path.exists():
            continue
        try:
            conn = sqlite3.connect(str(db_path))
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM ItemTable WHERE key LIKE '%composer%' OR key LIKE '%chat%'")
            rows = cursor.fetchall()
            conn.close()
            for row in rows:
                try:
                    data = json.loads(row[0])
                    if isinstance(data, dict):
                        ts = data.get("timestamp", "")
                        if str(ts).startswith(target_date):
                            model = data.get("model", "gpt-4o")
                            totals[model]["input_tokens"]  += data.get("inputTokens", 0)
                            totals[model]["output_tokens"] += data.get("outputTokens", 0)
                except Exception:
                    continue
        except Exception:
            continue

    return dict(totals)


def parse_gemini_logs(target_date: str) -> dict:
    """Read Gemini CLI usage logs."""
    totals: dict = defaultdict(lambda: {
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
    })

    if sys.platform == "win32":
        possible_paths = [
            Path.home() / ".gemini" / "tmp",
            Path(os.environ.get("APPDATA", "")) / "gemini" / "tmp",
        ]
    else:
        possible_paths = [Path.home() / ".gemini" / "tmp"]

    for base_path in possible_paths:
        if not base_path.exists():
            continue
        for f in base_path.rglob("*.json"):
            try:
                mtime = datetime.date.fromtimestamp(f.stat().st_mtime).isoformat()
                if mtime != target_date:
                    continue
                data = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    for entry in data:
                        if not isinstance(entry, dict):
                            continue
                        usage = entry.get("usageMetadata", {})
                        if not usage:
                            continue
                        model = entry.get("model", "gemini-2.0-flash")
                        totals[model]["input_tokens"]  += usage.get("promptTokenCount", 0)
                        totals[model]["output_tokens"] += usage.get("candidatesTokenCount", 0)
            except Exception:
                continue

    return dict(totals)


def parse_windsurf_logs(target_date: str) -> dict:
    """Read Windsurf AI usage from storage."""
    import sqlite3
    totals: dict = defaultdict(lambda: {
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
    })

    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", ""))
        possible_paths = [appdata / "Windsurf" / "User" / "globalStorage" / "state.vscdb"]
    else:
        home = Path.home()
        possible_paths = [
            home / "Library" / "Application Support" / "Windsurf" / "User" / "globalStorage" / "state.vscdb",
            home / ".config" / "Windsurf" / "User" / "globalStorage" / "state.vscdb",
        ]

    for db_path in possible_paths:
        if not db_path.exists():
            continue
        try:
            conn = sqlite3.connect(str(db_path))
            c = conn.cursor()
            c.execute("SELECT value FROM ItemTable WHERE key LIKE '%chat%'")
            rows = c.fetchall()
            conn.close()
            for row in rows:
                try:
                    data = json.loads(row[0])
                    if isinstance(data, dict):
                        ts = data.get("timestamp", "")
                        if str(ts).startswith(target_date):
                            model = data.get("model", "windsurf")
                            totals[model]["input_tokens"]  += data.get("inputTokens", 100)
                            totals[model]["output_tokens"] += data.get("outputTokens", 50)
                except Exception:
                    continue
        except Exception:
            continue

    return dict(totals)


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
        print(f"Scanning all AI tool logs for {target}...\n")

        tool_scanners = [
            ("claude_code", _parse_claude_for_date),
            ("copilot",     parse_copilot_logs),
            ("cursor",      parse_cursor_logs),
            ("gemini",      parse_gemini_logs),
            ("windsurf",    parse_windsurf_logs),
        ]

        for tool_name, scanner in tool_scanners:
            try:
                usage_by_model = scanner(target)
            except Exception as e:
                print(f"  {tool_name}: scan error — {e}")
                continue

            if not usage_by_model:
                continue

            print(f"  {tool_name}:")
            for model, usage in usage_by_model.items():
                if usage["input_tokens"] + usage["output_tokens"] == 0:
                    continue
                ikey = hashlib.sha256(
                    f"{device_id}:{target}:{tool_name}:{model}".encode()
                ).hexdigest()[:64]
                payload = {
                    "device_id":          device_id,
                    "date":               target,
                    "tool":               tool_name,
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
                    print(
                        f"    {model}: {usage['input_tokens']}in / "
                        f"{usage['output_tokens']}out "
                        f"→ usage_id={resp.get('usage_id', 'ok')}"
                    )
                    submitted += 1
                except RuntimeError as e:
                    err = str(e)
                    if "already_exists" in err or "duplicate" in err.lower():
                        skipped += 1
                    else:
                        print(f"    {model}: ERROR — {e}")

        if submitted == 0 and skipped == 0:
            print("  No usage found for this date.")
        else:
            print(f"\nDone. {submitted} submitted, {skipped} already existed.")

    else:
        # ── All dates: Claude Code historical scan ───────────────────────
        print("Scanning Claude Code logs (all historical dates)...")
        all_data = parse_claude_logs()

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
