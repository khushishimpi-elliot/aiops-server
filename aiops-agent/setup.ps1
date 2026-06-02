# aiops-agent Windows PowerShell setup
# Run this if you are in PowerShell and setup.bat did not work:
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# Or right-click setup.ps1 → "Run with PowerShell"

Write-Host ""
Write-Host "  aiops-agent Setup (PowerShell)" -ForegroundColor Cyan
Write-Host "  ==============================" -ForegroundColor Cyan
Write-Host ""

# ── Fix execution policy ──────────────────────────────────────────────────────
# Without this, PowerShell blocks npm because npm.ps1 is a signed-required script.
Write-Host "  Fixing PowerShell execution policy..." -ForegroundColor Yellow
try {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    Write-Host "  OK: Execution policy set to RemoteSigned for current user." -ForegroundColor Green
} catch {
    Write-Host "  Warning: Could not set execution policy automatically." -ForegroundColor Yellow
    Write-Host "  If npm commands fail, run PowerShell as Administrator and retry." -ForegroundColor Yellow
}

# ── Check Node.js ─────────────────────────────────────────────────────────────
$nodeVersion = & node --version 2>$null
if (-not $nodeVersion) {
    Write-Host ""
    Write-Host "  ERROR: Node.js not found. Download from https://nodejs.org/" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "  OK: Node.js $nodeVersion" -ForegroundColor Green

# ── Run setup via Node (uses cmd.exe internally — no PS policy issues) ────────
Write-Host ""
Write-Host "  Running node setup.mjs ..." -ForegroundColor Cyan
Write-Host ""

& node setup.mjs

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  Setup encountered an error. See output above." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit $LASTEXITCODE
}

Write-Host ""
Read-Host "Press Enter to exit"
