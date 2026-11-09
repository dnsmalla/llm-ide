#!/bin/bash

# LLM-IDE Automated Deployment Script
# This script handles resolving all dependencies, compiling native binaries,
# and initializing the Node server seamlessly for the end-user.

set -e

# Always resolve paths from the repo root (this script lives there).
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

echo "========================================="
echo "   LLM-IDE Extension Initialization   "
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
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "❌ Error: Node.js 22+ is required (found v$NODE_VERSION)."
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

if [ -d "$REPO_ROOT/$TARGET_DIR" ]; then
    echo "⚙️ Resolving local backend engine dependencies..."
    (
        cd "$REPO_ROOT/$TARGET_DIR"
        # We purposefully run an install that reconstructs native modules (better-sqlite3)
        npm install
    )
    echo "✅ Backend dependencies compiled successfully!"
else
    echo "⚠️ Target directory /$TARGET_DIR not found. Please run this script from the project root."
    exit 1
fi

echo ""
# 4. Claude CLI (see docs/decisions/0001-claude-cli-not-api-key.md)
# LLM-IDE shells out to the `claude` CLI authenticated as the user.
# ANTHROPIC_API_KEY is NOT required and NOT used.
# NOTE: a missing CLI is a deferred failure, not an abort: exiting here used to skip the
# submodules, hooks and desktop dependencies below, leaving a half-configured checkout.
SETUP_FAILED=0
if ! command -v claude &> /dev/null; then
    echo "❌ The 'claude' CLI is not installed or not on PATH (setup continues; fix before using LLM-IDE)."
    echo "   Install: https://docs.claude.com/en/docs/claude-code/quickstart, then run 'claude login'."
    SETUP_FAILED=1
else
    echo "✅ Claude CLI detected: $(claude --version 2>/dev/null || echo 'version check failed')"
    # `claude --version` is a weak signal; a real model call is too heavy for setup.
    if ! claude --version &> /dev/null; then
        echo "⚠️  'claude --version' failed. If the CLI is installed but not authenticated, run: claude login"
    fi
fi

# Enable the repo's git hooks (same as `make hooks`). The pre-push hook runs the
# gates for what changed; bypass with `git push --no-verify`.
if [ -d "$REPO_ROOT/.githooks" ]; then
    git -C "$REPO_ROOT" config core.hooksPath .githooks
    echo "✅ git hooks enabled (.githooks)"
fi

# 4b. graph-kit — the graph engine (submodule). The desktop build reads its web
# package and CLI, and `make graph-gates` runs its labs from the checkout.
if [ -f "$REPO_ROOT/.gitmodules" ] && grep -q 'path = graph-kit' "$REPO_ROOT/.gitmodules" 2>/dev/null; then
    echo ""
    echo "⚙️  Fetching graph-kit (graph engine submodule)..."
    git -C "$REPO_ROOT" submodule update --init --recursive graph-kit
    echo "✅ graph-kit ready"
fi

# 4c. Desktop app prerequisites and JS dependencies.
# The desktop Vite build aliases `three` into graph-kit/web/node_modules
# (desktop/vite.config.ts), and consumes ui/kit from source, so all three trees need
# `npm ci` — without graph-kit/web the build dies with "Could not load .../three.module.js".
echo ""
echo "⚙️  Desktop app prerequisites..."
if ! xcode-select -p &> /dev/null && [ "$(uname -s)" = "Darwin" ]; then
    echo "❌ Xcode Command Line Tools missing. Run: xcode-select --install"
    SETUP_FAILED=1
fi
RUST_PATH_HINT="$HOME/.cargo/bin"
if ! command -v cargo &> /dev/null && [ -x "$RUST_PATH_HINT/cargo" ]; then
    export PATH="$RUST_PATH_HINT:$PATH"
fi
if command -v cargo &> /dev/null; then
    echo "✅ Rust detected: $(cargo --version)  (desktop needs 1.88+)"
else
    echo "❌ Rust is not installed (needed for the desktop app only)."
    echo "   Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   then open a new shell"
    SETUP_FAILED=1
fi
for dir in ui/kit desktop graph-kit/web; do
    if [ -f "$REPO_ROOT/$dir/package-lock.json" ]; then
        echo "⚙️  npm ci in $dir ..."
        if (cd "$REPO_ROOT/$dir" && npm ci --no-audit --no-fund >/dev/null 2>&1); then
            echo "✅ $dir dependencies installed"
        else
            echo "❌ npm ci failed in $dir (re-run: cd $dir && npm ci)"
            SETUP_FAILED=1
        fi
    else
        echo "⚠️  $dir/package-lock.json not found — skipped (is the graph-kit submodule checked out?)"
        SETUP_FAILED=1
    fi
done

# The Tauri build script (desktop/src-tauri/build.rs) fails with "resource path
# ../resources/core doesn't exist" unless the core is staged; that directory is gitignored.
# NOTE: STAGE.json is written last by stage-core.mjs; the directory alone can be a half-staged leftover.
if [ -f "$REPO_ROOT/desktop/resources/core/STAGE.json" ]; then
    echo "✅ desktop core already staged (re-stage: node desktop/scripts/stage-core.mjs)"
else
    echo "⚙️  Staging the Node core for the desktop app (downloads the pinned Node once)..."
    if node "$REPO_ROOT/desktop/scripts/stage-core.mjs" >/dev/null; then
        echo "✅ desktop core staged"
    else
        echo "❌ core staging failed (re-run: node desktop/scripts/stage-core.mjs)"
        SETUP_FAILED=1
    fi
fi

# 5. Central skills kit — pin via `.skills` submodule, then symlink into
# every AI tool dir (Claude / Cursor / Codex / .agents / Gemini).
echo ""
echo "⚙️  Wiring central skills kit for all agents..."
if [ -f "$REPO_ROOT/.gitmodules" ] && grep -q 'path = \.skills' "$REPO_ROOT/.gitmodules" 2>/dev/null; then
    git -C "$REPO_ROOT" submodule update --init --recursive .skills
fi
if [ -f "$REPO_ROOT/scripts/install-skills.sh" ]; then
    bash "$REPO_ROOT/scripts/install-skills.sh"
    echo "✅ Skills installed (Claude / Cursor / Codex / .agents / Gemini)"
else
    echo "⚠️  scripts/install-skills.sh not found — skip skills wiring"
fi
if [ -f "$REPO_ROOT/scripts/sync-skills.sh" ]; then
    bash "$REPO_ROOT/scripts/sync-skills.sh" 2>/dev/null && echo "✅ Agent tool definitions synced from .skills" || echo "⚠️  sync-skills skipped (central repo unavailable)"
fi

# 6. Optional token-saving tools — checked, never installed or enabled here
# (they change the user's global AI-tool config). See FIRST_TIME_SETUP.md
# "Optional: token-saving tools". Never fails setup.
echo ""
echo "⚙️  Optional token-saving tools..."
if command -v rtk &> /dev/null; then
    if rtk init --show 2>/dev/null | grep -qiE "hook:.*not found|hook not configured"; then
        echo "⚠️  rtk $(rtk --version 2>/dev/null | awk '{print $2}') is installed but its Claude Code hook is off — it saves nothing yet."
        echo "    Enable:  rtk init -g --auto-patch --hook-only   (undo: rtk init -g --uninstall)"
    else
        echo "✅ rtk detected with its Claude Code hook: $(rtk --version 2>/dev/null)"
    fi
else
    echo "ℹ️  rtk not installed (recommended: compresses shell output 60-90% for Claude Code sessions)."
    echo "    Install: brew install rtk"
    echo "         or curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh"
    echo "    Enable:  rtk init -g --auto-patch --hook-only"
fi

echo ""
echo "========================================="
if [ "$SETUP_FAILED" -ne 0 ]; then
    echo "⚠️  Setup finished WITH PROBLEMS — see the ❌ lines above."
    echo "========================================="
    echo "Fix them and re-run ./setup.sh (it is safe to repeat)."
    exit 1
fi
echo "🎉 Setup Complete!"
echo "========================================="
echo "The system is fully resolved and ready to activate."
echo "To boot the intelligent backend server, execute:"
echo ""
echo "    cd extension && npm run server"
echo ""
echo "Skills (Claude / Cursor / Codex / …) come from the .skills submodule."
echo "Refresh dev skills:   bash scripts/install-skills.sh"
echo "Sync agent tools:     bash scripts/sync-skills.sh"
echo ""
