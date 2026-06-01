@echo off
setlocal enabledelayedexpansion
title Elliot Systems AIOps Setup
cd /d "%~dp0"

echo.
echo  ================================================
echo   Elliot Systems AIOps - Developer Setup
echo  ================================================
echo.

set SERVER=https://aiops-server.onrender.com

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Python is not installed.
    echo  Download from https://www.python.org/downloads/
    echo  Check "Add Python to PATH" during install.
    pause
    exit /b 1
)
echo  Python found.

echo  Installing SSL certificates...
python -m pip install --quiet --upgrade certifi 2>nul
echo  SSL ready.

echo.
python "%~dp0aiops.py" install --server %SERVER%

echo.
pause
