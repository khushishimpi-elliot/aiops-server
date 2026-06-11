#!/bin/bash
# Install aiops locally without npm global install issues
# Works on macOS and Linux

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔧 AIOps Local Installation${NC}\n"

# 1. Check Node
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# 2. Install dependencies (skip scripts to avoid esbuild issues)
echo -e "\n${YELLOW}Installing dependencies...${NC}"
npm install --ignore-scripts --no-save

# 3. Check binary exists
if [ ! -f "dist/cli.cjs" ]; then
  echo -e "${RED}✗ dist/cli.cjs not found${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Binary found${NC}"

# 4. Create local bin directory
mkdir -p ~/bin

# 5. Copy binary
cp dist/cli.cjs ~/bin/aiops
chmod +x ~/bin/aiops

echo -e "\n${GREEN}✓ Installation complete!${NC}"
echo ""
echo "📍 Binary location: $HOME/bin/aiops"
echo ""

# 6. Check PATH
if [[ ":$PATH:" == *":$HOME/bin:"* ]]; then
  echo -e "${GREEN}✓ $HOME/bin is in your PATH${NC}"
  echo "You can use 'aiops' command now"
else
  echo -e "${YELLOW}⚠️  $HOME/bin is NOT in your PATH${NC}"
  echo ""
  echo "To add it, run one of these:"
  echo ""
  echo "  For zsh (macOS):"
  echo "    echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.zshrc"
  echo "    source ~/.zshrc"
  echo ""
  echo "  For bash (Linux):"
  echo "    echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.bashrc"
  echo "    source ~/.bashrc"
  echo ""
fi

# 7. Test it
echo ""
echo "${YELLOW}Testing...${NC}"
if ~/bin/aiops --version > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Works! Version: $(~/bin/aiops --version)${NC}"
  echo ""
  echo "Try: aiops"
else
  echo -e "${YELLOW}⚠️  Binary works but not in PATH yet${NC}"
  echo "Full path: ~/bin/aiops --version"
fi
