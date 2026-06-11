@echo off
REM AIOps wrapper for Windows
REM Just copy this file to C:\Windows\System32\ or any folder in PATH

REM Get the directory where this script is located
for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"

REM Run the CLI
node "%SCRIPT_DIR%\dist\cli.cjs" %*
