# Setup Troubleshooting Guide

If you encounter issues during installation, try the solutions below in order.

## Problem: `esbuild: Exec format error` or Build Failures

**Cause:** Platform-specific binary incompatibility. This happens when:
- You clone the repo on Windows but install dependencies from a cached macOS build (or vice versa)
- Node modules are copied between machines with different architectures (Intel vs Apple Silicon)
- esbuild native binaries don't match your OS/processor

### Solution (Try in Order)

#### **Option 1: Clean Install (Recommended)**

```bash
# Remove build cache and platform-specific binaries
rm -rf node_modules package-lock.json dist

# Use the official setup script (handles all edge cases)
bash setup.sh                    # macOS / Linux
# OR
setup.bat                        # Windows
```

#### **Option 2: Install with Ignored Scripts**

If the setup script doesn't work:

```bash
# Skip build scripts during install (esbuild won't run)
npm install --ignore-scripts

# Build is not needed — dist/cli.cjs comes pre-built from git
npm install -g .
```

#### **Option 3: Manual Build + Install**

```bash
# 1. Install only production dependencies
npm install --omit=dev --no-scripts

# 2. The CLI binary is pre-built in dist/cli.cjs (no build needed!)
#    It was committed to git specifically so you don't need to build

# 3. Install globally
npm install -g .
```

#### **Option 4: Verify the Binary Exists**

Before trying to use `aiops`, check that the binary was installed:

```bash
which aiops              # macOS / Linux
where aiops              # Windows (PowerShell)
```

If not found, manually copy:

```bash
# macOS / Linux
cp dist/cli.cjs /usr/local/bin/aiops
chmod +x /usr/local/bin/aiops

# Windows (in PowerShell as Admin)
Copy-Item dist/cli.cjs "$env:ProgramFiles\nodejs\aiops.cmd"
```

---

## Problem: `aiops: command not found`

The `aiops` command is not in your PATH.

### Solution

**Mac / Linux:**
```bash
# Check if it's installed
which aiops

# If not found, reinstall globally
npm install -g . --force

# If still not found, add manually to PATH
echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Windows:**
```powershell
# Check if it's in npm global bin
npm config get prefix

# Should be: C:\Users\<username>\AppData\Roaming\npm
# Verify aiops is there:
dir "$env:APPDATA\npm\aiops.cmd"

# If missing, reinstall
npm install -g . --force

# Restart PowerShell and try again
aiops --version
```

---

## Problem: `better-sqlite3` Build Fails (Windows)

Cursor and Windsurf data requires `better-sqlite3` to compile native code.

### Solution

**Option A: Install Build Tools (Easiest)**
```bash
npm install -g windows-build-tools
node setup.mjs
```

**Option B: Install Visual Studio C++ Workload**
1. Download Visual Studio Community: https://visualstudio.microsoft.com/
2. Run installer, select "Desktop development with C++"
3. Complete installation
4. Re-run `setup.bat`

**Option C: Skip It**
The tool works fine without `better-sqlite3` — it just won't read Cursor/Windsurf data. You can continue with:
```bash
npm install --ignore-scripts
npm install -g .
```

---

## Problem: Node.js Not Found or Wrong Version

### Solution

1. **Verify Node.js is installed:**
   ```bash
   node --version    # Should be 18.0.0 or higher
   ```

2. **If not installed:**
   - Download from: https://nodejs.org/
   - Use the LTS (Long Term Support) version
   - Restart terminal after installing

3. **If installed but `setup.sh` still fails:**
   ```bash
   # macOS (might need Homebrew)
   brew install node
   
   # Linux (Ubuntu/Debian)
   sudo apt-get install nodejs npm
   
   # Windows: Use the installer from nodejs.org
   ```

---

## Problem: Permission Denied on macOS/Linux

```bash
# If you see "Permission denied" during npm install -g:

# Option 1: Use sudo
sudo npm install -g . --force

# Option 2: Use a user-local npm prefix (no sudo needed)
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH="$HOME/.npm-global/bin:$PATH"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g .

# Option 3: Let setup.sh handle it
bash setup.sh
```

---

## Problem: Module Not Found or ESM/CommonJS Errors

If you see errors like `Cannot find module` or `require is not defined`:

```bash
# Rebuild from scratch
rm -rf node_modules package-lock.json

# Use the setup script
bash setup.sh                    # macOS / Linux
# OR
setup.bat                        # Windows
```

---

## Problem: Cursor or Windsurf Data Not Detected

1. **Verify the tools are installed:**
   - Launch Cursor or Windsurf at least once
   - Make sure you've used the AI features

2. **Check the database exists:**
   ```bash
   # macOS / Linux
   ls ~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb  # or Windsurf
   
   # Windows (PowerShell)
   Test-Path "$env:APPDATA\Cursor\User\globalStorage\state.vscdb"
   ```

3. **If `better-sqlite3` is missing:**
   - Follow "better-sqlite3 Build Fails" section above
   - Without it, Cursor/Windsurf data will be skipped (but Claude Code, Gemini, Cline still work)

---

## After Installation: Verify It Works

```bash
# Test the command
aiops --version

# Run your first scan
aiops

# Check a specific tool
aiops --claude --summary
```

If `aiops` runs but reports no data, check:
1. Have you used Claude Code, Cursor, or Gemini CLI recently?
2. Are those tools' log files in the expected locations?

---

## Still Stuck?

If none of these solutions work:

1. **Clean state:**
   ```bash
   rm -rf node_modules package-lock.json
   rm -rf ~/.npm-global  # if you created it
   ```

2. **Full reinstall:**
   ```bash
   npm cache clean --force
   bash setup.sh        # macOS / Linux
   # OR
   setup.bat            # Windows
   ```

3. **Check Node version again:**
   ```bash
   node --version
   npm --version
   ```

4. **Report the issue** with:
   - Your OS and Node version (`node --version`)
   - The full error output
   - Which step fails (npm install, build, global install, or aiops command)
