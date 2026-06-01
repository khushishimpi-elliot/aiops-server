#!/bin/bash
set -e

echo ""
echo " ================================================"
echo "  Elliot Systems AIOps - Developer Setup"
echo " ================================================"
echo ""

SERVER="https://aiops-server.onrender.com"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v python3 &>/dev/null; then
    echo " ERROR: Python 3 is not installed."
    echo " Install from https://www.python.org/downloads/"
    exit 1
fi
echo " Python 3 found."

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo " Fixing SSL certificates..."
    PY_VER=$(python3 -c \
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    CERT_CMD="/Applications/Python $PY_VER/Install Certificates.command"
    if [ -f "$CERT_CMD" ]; then
        bash "$CERT_CMD" > /dev/null 2>&1 || true
    fi
    python3 -m pip install --quiet --upgrade certifi \
      2>/dev/null || true
    echo " SSL ready."
fi

echo ""
python3 "$SCRIPT_DIR/aiops.py" install --server "$SERVER"
