#!/bin/bash
# Simplest possible installation — just copy the wrapper script

set -e

echo "🔧 AIOps Simple Installation"
echo ""

# Check Node
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found"
  echo "Download from: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node --version)
echo "✓ Node.js $NODE_VERSION"

# Check dist/cli.cjs exists
if [ ! -f "dist/cli.cjs" ]; then
  echo "ERROR: dist/cli.cjs not found"
  echo "Make sure you're in the aiops-agent directory"
  exit 1
fi

echo "✓ dist/cli.cjs found"
echo ""

# Copy to /usr/local/bin (may need sudo)
TARGET="/usr/local/bin/aiops"

if [ -w /usr/local/bin ]; then
  cp aiops "$TARGET"
  chmod +x "$TARGET"
  echo "✓ Installed to: $TARGET"
else
  echo "Need sudo to install to /usr/local/bin..."
  sudo cp aiops "$TARGET"
  sudo chmod +x "$TARGET"
  echo "✓ Installed to: $TARGET (with sudo)"
fi

echo ""

# Test
if "$TARGET" --version > /dev/null 2>&1; then
  VERSION=$("$TARGET" --version)
  echo "✓ Installation successful!"
  echo "  aiops version: $VERSION"
  echo ""
  echo "You can now use: aiops"
else
  echo "⚠️  Something went wrong"
  echo "Try manual install:"
  echo "  sudo cp aiops /usr/local/bin/"
  exit 1
fi
