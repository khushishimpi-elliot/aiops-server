@echo off
REM Windows setup wrapper for aiops-agent
REM Double-click this file OR run from Command Prompt / PowerShell

echo.
echo  aiops-agent Setup
echo  ================
echo.

REM ── Fix PowerShell execution policy so npm commands work in PS ────────────────
REM    This is the #1 cause of "npm.ps1 cannot be loaded" errors on Windows.
PowerShell -NoProfile -ExecutionPolicy Bypass -Command "try { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force; Write-Host '  Execution policy set to RemoteSigned (current user).' -ForegroundColor Green } catch { Write-Host '  Could not set execution policy — continuing anyway.' -ForegroundColor Yellow }"

REM ── Check that Node.js is installed ──────────────────────────────────────────
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: Node.js is not installed or not in PATH.
    echo  Download it from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM ── Run the cross-platform setup script ──────────────────────────────────────
REM    Node.js uses cmd.exe internally so npm commands are never blocked by PS.
node setup.mjs
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  Setup encountered an error. See output above.
    pause
    exit /b %ERRORLEVEL%
)

pause
