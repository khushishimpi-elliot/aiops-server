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
    return json.loads(CONFIG_FILE.read_text())


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


def cmd_report(args):
    config    = load_config()
    server    = config["server"]
    device_id = config["device_id"]
    tool      = config.get("tool", "claude_code")
    target    = args.date   # None means all historical dates

    print("AIOps Telemetry Report")
    print(f"Server    : {server}")
    print(f"Device ID : {device_id}")
    print(f"Date      : {target if target else 'all'}\n")

    print("Scanning Claude Code logs...")
    all_data = parse_claude_logs()

    if not all_data:
        print("No Claude Code usage found in logs.")
        return

    # Filter to a single date if --date was given
    if target:
        dates_to_submit = {target: all_data.get(target, {})}
    else:
        dates_to_submit = all_data

    submitted = skipped = errors = 0
    for date in sorted(dates_to_submit.keys()):
        usage_by_model = dates_to_submit[date]
        for model, usage in usage_by_model.items():
            if usage["input_tokens"] + usage["output_tokens"] == 0:
                continue
            ikey = hashlib.sha256(f"{device_id}:{date}:{model}".encode()).hexdigest()[:64]
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

    if not target:
        total_dates = len([d for d, m in dates_to_submit.items() if any(
            u["input_tokens"] + u["output_tokens"] > 0 for u in m.values())])
        print(f"\nDone. {submitted} submitted, {skipped} already existed, {errors} errors. ({total_dates} active dates scanned)")
    else:
        print(f"\nDone. {submitted} submitted, {skipped} already existed.")

    # Submit task category breakdown
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
        r = subprocess.run(["schtasks", "/query", "/tn", TASK_NAME_AM], capture_output=True, check=False)
        return r.returncode == 0
    else:
        return PLIST_AM.exists() or PLIST_PM.exists()


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


def _setup_windows(python_exe, script_path):
    for task_name, time_str in [(TASK_NAME_AM, DEFAULT_TIME_AM), (TASK_NAME_PM, DEFAULT_TIME_PM)]:
        # Remove existing task with this name first
        subprocess.run(["schtasks", "/delete", "/tn", task_name, "/f"], capture_output=True, check=False)

        result = subprocess.run([
            "schtasks", "/create",
            "/tn", task_name,
            "/tr", f'"{python_exe}" "{script_path}" report',
            "/sc", "DAILY",
            "/st", time_str,
            "/rl", "HIGHEST",
            "/f",
        ], capture_output=True, text=True)

        if result.returncode == 0:
            print(f"Scheduled task '{task_name}' created — runs daily at {time_str}.")
        else:
            print(f"Failed to create task '{task_name}':\n{result.stderr}")
            sys.exit(1)


def _make_plist(python_exe: str, script_path: str, label: str, hour: int, minute: int, log_path: str) -> str:
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
    <dict>
        <key>Hour</key>
        <integer>{hour}</integer>
        <key>Minute</key>
        <integer>{minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{log_path}</string>
</dict>
</plist>"""


def _setup_mac(python_exe, script_path):
    PLIST_AM.parent.mkdir(parents=True, exist_ok=True)
    log_path = str(Path.home() / ".aiops" / "telemetry.log")

    schedules = [
        (PLIST_AM, "com.elliot.aiops.am", 9,  0),
        (PLIST_PM, "com.elliot.aiops.pm", 18, 0),
    ]
    for plist_path, label, hour, minute in schedules:
        if plist_path.exists():
            subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True, check=False)
        plist_path.write_text(_make_plist(python_exe, script_path, label, hour, minute, log_path))
        subprocess.run(["launchctl", "load", str(plist_path)], capture_output=True, check=False)
        print(f"Scheduled task '{label}' created — runs daily at {hour:02d}:{minute:02d}.")

    print(f"Log file: {log_path}")


def cmd_remove(_args):
    removed = False
    if IS_WINDOWS:
        for task_name in [TASK_NAME_AM, TASK_NAME_PM, TASK_NAME]:
            r = subprocess.run(["schtasks", "/delete", "/tn", task_name, "/f"], capture_output=True, check=False)
            if r.returncode == 0:
                print(f"Removed task: {task_name}")
                removed = True
    else:
        for plist_path in [PLIST_AM, PLIST_PM, PLIST_PATH]:
            if plist_path.exists():
                subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True, check=False)
                plist_path.unlink(missing_ok=True)
                print(f"Removed: {plist_path.name}")
                removed = True

    if not removed:
        print("No scheduled tasks found.")

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
    print("  Usage will be reported twice daily: 9:00 AM and 6:00 PM.")
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
    print(f"Claude logs   : {CLAUDE_DIR / 'projects'}")

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

    sub.add_parser("setup", help="Create twice-daily scheduled tasks (9 AM + 6 PM)")
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
