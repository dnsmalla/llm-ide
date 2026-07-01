#!/usr/bin/env bash
# =============================================================================
# LLM IDE — One-command startup
# Usage:  ./start.sh
# =============================================================================
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

OK()   { echo -e "${GREEN}  ✓${NC}  $*"; }
INFO() { echo -e "${BLUE}  ›${NC}  $*"; }
WARN() { echo -e "${YELLOW}  !${NC}  $*"; }
STEP() { echo -e "\n${BOLD}${BLUE}[$1]${NC} $2"; }
FAIL() { echo -e "${RED}  ✗  $*${NC}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║       LLM IDE — Quick Start       ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════╝${NC}"

# ── Step 1: Dependencies ──────────────────────────────────────────────────────
STEP "1/2" "Server dependencies"

if [ -d "$SCRIPT_DIR/node_modules" ]; then
  OK "node_modules already present — skipping install."
else
  INFO "Running npm install..."
  npm install --silent
  OK "Dependencies installed."
fi

# ── Step 2: Start server ──────────────────────────────────────────────────────
STEP "2/2" "Starting LLM IDE server"

# Track PID for clean Ctrl-C
SERVER_PID=""

cleanup() {
  echo ""
  INFO "Shutting down..."
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  OK "Server stopped. Goodbye."
  exit 0
}
trap cleanup INT TERM

INFO "Starting main server → http://127.0.0.1:3456"
node server.mjs &
SERVER_PID=$!

echo ""
echo -e "${GREEN}${BOLD}✓ LLM IDE is running.${NC}"
echo -e "  Dashboard:  ${BLUE}http://127.0.0.1:3456${NC}"
echo -e "  Press ${BOLD}Ctrl-C${NC} to stop.\n"

# Wait for process to exit
wait "$SERVER_PID"
