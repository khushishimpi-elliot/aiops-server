#!/bin/bash
echo ""
echo " ================================================"
echo "  Elliot Systems AIOps - Developer Setup"
echo " ================================================"
echo ""

# Check Python is installed
if ! command -v python3 &>/dev/null; then
    echo " ERROR: Python 3 is not installed."
    echo " Install it from https://www.python.org/downloads/"
    exit 1
fi

# Run install from the same directory as this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

python3 "$SCRIPT_DIR/aiops.py" install --server http://10.179.21.117:8000
