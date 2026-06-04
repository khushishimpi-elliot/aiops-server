import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export interface InstallResult {
  ok: boolean;
  message: string;
  method: string;
}

// Returns { exec: full path to node, script: full path to cli.cjs }
function executorArgs(): { exec: string; script: string } {
  return {
    exec:   process.execPath,   // e.g. /usr/local/bin/node or C:\Program Files\nodejs\node.exe
    script: process.argv[1],    // e.g. /usr/local/lib/node_modules/aiops-agent/dist/cli.cjs
  };
}

export function install(): InstallResult {
  if (process.platform === 'darwin') return installMac();
  if (process.platform === 'win32')  return installWindows();
  return installLinux();
}

export function uninstall(): InstallResult {
  if (process.platform === 'darwin') return uninstallMac();
  if (process.platform === 'win32')  return uninstallWindows();
  return uninstallLinux();
}

// ── macOS — launchd ────────────────────────────────────────────────────────────

const MAC_LABEL    = 'com.elliot.aiops';
const MAC_PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const MAC_PLIST     = path.join(MAC_PLIST_DIR, `${MAC_LABEL}.plist`);

function installMac(): InstallResult {
  const { exec, script } = executorArgs();
  const logFile = path.join(os.homedir(), '.aiops', 'daemon.log');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exec}</string>
    <string>${script}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
  </dict>
</dict>
</plist>`;

  try {
    fs.mkdirSync(MAC_PLIST_DIR, { recursive: true });
    fs.writeFileSync(MAC_PLIST, plist, 'utf8');
    // Unload first in case it's already registered (ignore failure)
    try { execSync(`launchctl unload "${MAC_PLIST}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
    execSync(`launchctl load "${MAC_PLIST}"`, { stdio: 'pipe' });
    return { ok: true, message: `Registered as launchd agent (${MAC_LABEL})`, method: 'launchd' };
  } catch (err) {
    return { ok: false, message: `macOS install failed: ${(err as Error).message}`, method: 'launchd' };
  }
}

function uninstallMac(): InstallResult {
  try {
    try { execSync(`launchctl unload "${MAC_PLIST}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
    if (fs.existsSync(MAC_PLIST)) fs.unlinkSync(MAC_PLIST);
    return { ok: true, message: 'Removed launchd agent', method: 'launchd' };
  } catch (err) {
    return { ok: false, message: `macOS uninstall failed: ${(err as Error).message}`, method: 'launchd' };
  }
}

export function isMacInstalled(): boolean {
  return fs.existsSync(MAC_PLIST);
}

// ── Windows — Task Scheduler ───────────────────────────────────────────────────

const WIN_TASK   = 'AIOps Agent';
const WIN_VBS    = path.join(os.homedir(), '.aiops', 'start-daemon.vbs');

function installWindows(): InstallResult {
  const { exec, script } = executorArgs();
  const logFile = path.join(os.homedir(), '.aiops', 'daemon.log');

  // Write a VBScript wrapper that starts node hidden (no console window)
  const vbs = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "${exec.replace(/\\/g, '\\\\')}" & Chr(34) & " " & Chr(34) & "${script.replace(/\\/g, '\\\\')}" & Chr(34) & " daemon", 0, False
`;
  try {
    fs.mkdirSync(path.dirname(WIN_VBS), { recursive: true });
    fs.writeFileSync(WIN_VBS, vbs, 'utf8');
  } catch (err) {
    return { ok: false, message: `Failed to write VBS wrapper: ${(err as Error).message}`, method: 'schtasks' };
  }

  // Delete existing task first (ignore failure)
  try { execSync(`schtasks /delete /f /tn "${WIN_TASK}"`, { stdio: 'pipe', shell: true }); } catch {}

  const taskCmd = `schtasks /create /f /tn "${WIN_TASK}" /tr "wscript.exe \\"${WIN_VBS}\\"" /sc onlogon /rl limited /delay 0000:30`;
  try {
    execSync(taskCmd, { stdio: 'pipe', shell: true });
    // Start it immediately (don't wait for next login)
    try { execSync(`schtasks /run /tn "${WIN_TASK}"`, { stdio: 'pipe', shell: true }); } catch {}
    return { ok: true, message: `Registered in Task Scheduler ("${WIN_TASK}")`, method: 'schtasks' };
  } catch (err) {
    return { ok: false, message: `Windows install failed: ${(err as Error).message}`, method: 'schtasks' };
  }
}

function uninstallWindows(): InstallResult {
  const errors: string[] = [];
  try { execSync(`schtasks /end /tn "${WIN_TASK}"`, { stdio: 'pipe', shell: true }); } catch {}
  try {
    execSync(`schtasks /delete /f /tn "${WIN_TASK}"`, { stdio: 'pipe', shell: true });
  } catch (err) {
    errors.push((err as Error).message);
  }
  try { if (fs.existsSync(WIN_VBS)) fs.unlinkSync(WIN_VBS); } catch {}
  if (errors.length) {
    return { ok: false, message: `Windows uninstall failed: ${errors.join('; ')}`, method: 'schtasks' };
  }
  return { ok: true, message: `Removed Task Scheduler entry ("${WIN_TASK}")`, method: 'schtasks' };
}

export function isWindowsInstalled(): boolean {
  try {
    execSync(`schtasks /query /tn "${WIN_TASK}"`, { stdio: 'pipe', shell: true });
    return true;
  } catch { return false; }
}

// ── Linux — systemd user service ──────────────────────────────────────────────

const LINUX_SVC      = 'aiops';
const LINUX_SVC_DIR  = path.join(os.homedir(), '.config', 'systemd', 'user');
const LINUX_SVC_FILE = path.join(LINUX_SVC_DIR, `${LINUX_SVC}.service`);

function installLinux(): InstallResult {
  const { exec, script } = executorArgs();
  const logFile = path.join(os.homedir(), '.aiops', 'daemon.log');

  const unit = `[Unit]
Description=AIOps AI Usage Monitor
After=network.target

[Service]
Type=simple
ExecStart=${exec} ${script} daemon
Restart=on-failure
RestartSec=15
StandardOutput=append:${logFile}
StandardError=append:${logFile}
Environment="HOME=${os.homedir()}"
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
`;

  try {
    fs.mkdirSync(LINUX_SVC_DIR, { recursive: true });
    fs.writeFileSync(LINUX_SVC_FILE, unit, 'utf8');
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user enable ${LINUX_SVC}`, { stdio: 'pipe' });
    execSync(`systemctl --user start ${LINUX_SVC}`, { stdio: 'pipe' });
    return { ok: true, message: `Registered as systemd user service (${LINUX_SVC})`, method: 'systemd' };
  } catch (err) {
    return { ok: false, message: `Linux install failed: ${(err as Error).message}`, method: 'systemd' };
  }
}

function uninstallLinux(): InstallResult {
  try {
    try { execSync(`systemctl --user stop ${LINUX_SVC}`, { stdio: 'pipe' }); } catch {}
    try { execSync(`systemctl --user disable ${LINUX_SVC}`, { stdio: 'pipe' }); } catch {}
    if (fs.existsSync(LINUX_SVC_FILE)) fs.unlinkSync(LINUX_SVC_FILE);
    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
    return { ok: true, message: `Removed systemd service (${LINUX_SVC})`, method: 'systemd' };
  } catch (err) {
    return { ok: false, message: `Linux uninstall failed: ${(err as Error).message}`, method: 'systemd' };
  }
}

export function isLinuxInstalled(): boolean {
  return fs.existsSync(LINUX_SVC_FILE);
}

export function isInstalled(): boolean {
  if (process.platform === 'darwin') return isMacInstalled();
  if (process.platform === 'win32')  return isWindowsInstalled();
  return isLinuxInstalled();
}
