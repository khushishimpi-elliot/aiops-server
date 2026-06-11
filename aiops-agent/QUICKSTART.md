# 🚀 Quick Start — 2 Minutes, No BS

Your developers are tired. They don't want to mess with npm, PATH, global installs, etc. Here's the **absolute simplest way** to get aiops working.

## For Each Developer

### Step 1: Clone the repo
```bash
git clone <repo>
cd aiops-agent
```

### Step 2: Choose ONE option

#### **Option A: Copy to /usr/local/bin (Recommended)**

**macOS/Linux:**
```bash
sudo cp aiops /usr/local/bin/
chmod +x /usr/local/bin/aiops
```

Then use anywhere:
```bash
aiops
aiops --version
```

**Windows (PowerShell as Admin):**
```powershell
Copy-Item aiops.cmd "C:\Windows\System32\"
```

Then use anywhere:
```powershell
aiops
aiops --version
```

---

#### **Option B: Use from project folder (Zero setup)**

No installation needed:
```bash
# From inside aiops-agent folder:
./aiops --version
./aiops
```

Then create an alias in your shell:
```bash
# Add to ~/.bashrc or ~/.zshrc:
alias aiops="/path/to/aiops-agent/aiops"
```

---

#### **Option C: One-liner install for teams**

Distribute this to your team:

**macOS/Linux:**
```bash
git clone <repo> && cd aiops-agent && sudo cp aiops /usr/local/bin/ && chmod +x /usr/local/bin/aiops && aiops --version
```

**Windows (PowerShell as Admin):**
```powershell
git clone <repo>; cd aiops-agent; Copy-Item aiops.cmd "C:\Windows\System32\"; aiops --version
```

---

## What If They Still Get "command not found"?

1. **Check it's actually there:**
   ```bash
   ls -la /usr/local/bin/aiops       # macOS/Linux
   dir "C:\Windows\System32\aiops.cmd"  # Windows
   ```

2. **Try with full path:**
   ```bash
   /usr/local/bin/aiops --version
   ```

3. **Use from project folder:**
   ```bash
   cd /path/to/aiops-agent
   ./aiops --version
   ```

4. **Last resort — use directly:**
   ```bash
   node /path/to/aiops-agent/dist/cli.cjs
   ```

---

## For Admins: Distribute Pre-Built

Just give them the entire `aiops-agent` folder, they only need to do:

```bash
cd aiops-agent
./aiops
```

No npm, no installation, just works. 

Or copy just the `aiops` script to a shared location:
```bash
cp aiops-agent/aiops /usr/local/bin/aiops
chmod +x /usr/local/bin/aiops
```

---

## Why This Works

- ✅ No npm global install (no PATH issues)
- ✅ No esbuild binary incompatibility
- ✅ Just a simple shell script wrapper around the pre-built binary
- ✅ Works on macOS, Linux, Windows
- ✅ Works with different architectures (Intel, Apple Silicon, etc.)

That's it. **The aiops and aiops.cmd files are all they need.**
