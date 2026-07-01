#!/bin/bash

# LLM IDE Automated Deployment Script
# This script handles resolving all dependencies, compiling native binaries,
# and initializing the Node server seamlessly for the end-user.

set -e

echo "========================================="
echo "   LLM IDE Extension Initialization   "
echo "========================================="
echo ""

# 1. Verify Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed."
    echo "Please download and install Node from https://nodejs.org/"
    exit 1
fi
NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "❌ Error: Node.js 20+ is required (found v$NODE_VERSION)."
    echo "Please upgrade from https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js detected: v$NODE_VERSION"

# 2. Verify NPM
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed (usually comes with Node.js)."
    exit 1
fi
echo "✅ npm detected: $(npm -v)"

# 3. Handle specific extension dependencies
export TARGET_DIR="extension"

if [ -d "$TARGET_DIR" ]; then
    echo "⚙️ Resolving local backend engine dependencies..."
    cd $TARGET_DIR
    
    # We purposefully run an install that reconstructs native modules (better-sqlite3)
    npm install
    
    echo "✅ Backend dependencies compiled successfully!"
else
    echo "⚠️ Target directory /$TARGET_DIR not found. Please run this script from the project root."
    exit 1
fi

echo ""
# 4. Verify Claude CLI (required — see docs/decisions/0001-claude-cli-not-api-key.md)
# LLM IDE shells out to the `claude` CLI authenticated as the user.
# ANTHROPIC_API_KEY is NOT required and NOT used.
if ! command -v claude &> /dev/null; then
    echo "❌ Error: the 'claude' CLI is not installed or not on PATH."
    echo ""
    echo "LLM IDE uses the Claude CLI (authenticated via 'claude login') to talk to the model."
    echo "We do NOT use an Anthropic API key."
    echo ""
    echo "Install instructions: https://docs.claude.com/en/docs/claude-code/quickstart"
    echo "Then run 'claude login' to authenticate, and re-run this script."
    exit 1
fi
echo "✅ Claude CLI detected: $(claude --version 2>/dev/null || echo 'version check failed')"

# Best-effort auth check: `claude --version` succeeding is a weak signal; a real
# call to the model is the only reliable check, but that's too heavy for setup.
# Just nudge the user if they haven't logged in.
if ! claude --version &> /dev/null; then
    echo "⚠️  'claude --version' failed. If the CLI is installed but not authenticated,"
    echo "    run: claude login"
fi

# Enable the repo's git hooks (same as `make hooks`). The pre-push hook runs
# `make regression` when mac/ changes; bypass with `git push --no-verify`.
if [ -d .githooks ]; then
    git config core.hooksPath .githooks
    echo "✅ git hooks enabled (.githooks)"
fi

echo ""
echo "========================================="
echo "🎉 Setup Complete!"
echo "========================================="
echo "The system is fully resolved and ready to activate."
echo "To boot the intelligent backend server, execute:"
echo ""
echo "    cd extension && npm run server"
echo ""
