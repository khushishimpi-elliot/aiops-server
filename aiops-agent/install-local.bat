@echo off
REM Install aiops locally without npm global install issues
REM Works on Windows

setlocal enabledelayexpansion

echo.
echo === AIOps Local Installation ===
echo.

REM 1. Check Node
node --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js not found
  exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODEVER=%%i
echo [OK] Node.js %NODEVER%

REM 2. Install dependencies (skip scripts)
echo.
echo Installing dependencies...
call npm install --ignore-scripts --no-save
if errorlevel 1 (
  echo ERROR: npm install failed
  exit /b 1
)

REM 3. Check binary exists
if not exist "dist\cli.cjs" (
  echo ERROR: dist\cli.cjs not found
  exit /b 1
)
echo [OK] Binary found

REM 4. Create local bin directory
if not exist "%USERPROFILE%\.aiops-bin" mkdir "%USERPROFILE%\.aiops-bin"

REM 5. Copy binary
copy "dist\cli.cjs" "%USERPROFILE%\.aiops-bin\aiops.cmd" >nul 2>&1
if errorlevel 1 (
  REM Try direct copy
  copy "dist\cli.cjs" "%USERPROFILE%\.aiops-bin\aiops.js" >nul
)

echo.
echo [OK] Installation complete!
echo.
echo Binary location: %USERPROFILE%\.aiops-bin\aiops.js
echo.

REM 6. Check PATH
setlocal enabledelayexpansion
set "userpath=!PATH!"
if "!userpath:%USERPROFILE%\.aiops-bin=!" neq "!userpath!" (
  echo [OK] .aiops-bin is in your PATH
  echo You can use 'aiops' command now
) else (
  echo [WARNING] .aiops-bin is NOT in your PATH
  echo.
  echo To add it, run this in PowerShell as Admin:
  echo.
  echo [Environment]::SetEnvironmentVariable('PATH', "$env:PATH;%USERPROFILE%\.aiops-bin", 'User')
  echo.
)

REM 7. Test
echo.
echo Testing...
node "%USERPROFILE%\.aiops-bin\aiops.js" --version >nul 2>&1
if errorlevel 1 (
  echo [WARNING] Binary created but test failed
  echo Try full path: node %USERPROFILE%\.aiops-bin\aiops.js
) else (
  for /f "tokens=*" %%i in ('node "%USERPROFILE%\.aiops-bin\aiops.js" --version') do set VER=%%i
  echo [OK] Works! Version: !VER!
)

endlocal
