@echo off
title Elliot Systems AIOps Install
echo.
echo  ================================================
echo   Elliot Systems AIOps - Developer Setup
echo  ================================================
echo.

:: Check Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python is not installed or not in PATH.
    echo  Download it from https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

:: Run the install command with the server URL hardcoded
python "%~dp0aiops.py" install --server http://10.179.21.117:8000

if errorlevel 1 (
    echo.
    echo  Something went wrong. Contact your IT admin.
    pause
)
