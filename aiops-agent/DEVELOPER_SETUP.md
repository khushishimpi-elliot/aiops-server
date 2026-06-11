# Quick Setup for Developers

## TL;DR — Just Run This

**macOS / Linux:**
```bash
git clone <repo-url>
cd aiops-agent
bash setup.sh
```

**Windows (PowerShell):**
```powershell
git clone <repo-url>
cd aiops-agent
.\setup.bat
```

Then verify:
```bash
aiops --version    # Should print: 1.0.0
aiops              # Should scan and show your AI tool usage
```

---

## What If Setup Fails?

### `esbuild: Exec format error`
This means platform-specific binaries are incompatible (you cloned on macOS but installed on Windows, etc.).

**Quick fix:**
```bash
rm -rf node_modules package-lock.json
bash setup.sh        # macOS / Linux
setup.bat            # Windows
```

### `aiops: command not found`
The global install didn't work. Try:

```bash
# Reinstall globally
npm install -g . --force

# Verify it's installed
which aiops          # macOS / Linux
where aiops          # Windows PowerShell
```

### Other Issues?
See **SETUP_TROUBLESHOOTING.md** in the project root for detailed solutions.

---

## System Requirements

| Item | Requirement |
|---|---|
| **Node.js** | 18.0.0 or higher ([download](https://nodejs.org/)) |
| **npm** | 8+ (included with Node.js) |
| **OS** | macOS, Linux, or Windows 10/11 |
| **Disk Space** | ~50 MB |

---

## For Team Admins / DevOps

### Creating a Binary Distribution Package

To send this to teams who can't run setup:

```bash
# Build once on your machine
npm install
npm run build

# Package just the binary + minimal files
tar -czf aiops-v1.0.0-{platform}.tar.gz \
  dist/cli.cjs \
  package.json \
  README.md

# Users just extract and run:
# tar -xzf aiops-v1.0.0-macos-arm64.tar.gz
# npm install -g . --force
```

Or you can distribute pre-built Docker images instead for full consistency.

---

## Troubleshooting Matrix

| Error | Cause | Fix |
|---|---|---|
| `esbuild: Exec format error` | Platform mismatch | `rm -rf node_modules && bash setup.sh` |
| `aiops: command not found` | Not in PATH | `npm install -g . --force` |
| `Node.js is not installed` | Missing requirement | Download from nodejs.org |
| `better-sqlite3` build fails | Windows missing build tools | See SETUP_TROUBLESHOOTING.md |
| Module not found errors | Corrupted install | `rm -rf node_modules && npm install` |

---

## Advanced: Install Without Build

If you only want to install and don't have time for build:

```bash
# Just install dependencies, skip any build
npm install --ignore-scripts

# Install globally (the binary is pre-built from git)
npm install -g .

# Done
aiops --version
```

---

## Pre-built Binaries

The `dist/cli.cjs` file is pre-built and committed to git. If the setup script fails but this file exists, the CLI will still work.

To manually use it:
```bash
# macOS / Linux
cp dist/cli.cjs /usr/local/bin/aiops
chmod +x /usr/local/bin/aiops

# Windows (PowerShell as Admin)
Copy-Item dist/cli.cjs "$env:ProgramFiles\nodejs\aiops.cmd"
```
