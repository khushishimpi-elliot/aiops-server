#!/bin/sh
# macOS / Linux / Git-Bash setup wrapper — delegates to the cross-platform Node.js script.
# Requires Node.js 18+.  Download from: https://nodejs.org/

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Download from https://nodejs.org/"
  exit 1
fi

if [ "$OS" = "Windows_NT" ]; then
  cmd /c setup.bat
else
  node setup.mjs
fi
