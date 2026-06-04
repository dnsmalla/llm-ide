#!/usr/bin/env bash
# Refresh the agent-loop tool DEFINITIONS from the central skills repo.
#
# The tool .md files (name/kind/schema + the prompt body) are authored centrally
# in dnsmalla/skills (the `agent-tools/` family), NOT here. This mirrors them into
# llm_agent/internal/skills/ so the server loads the canonical set. The read-tool
# HANDLERS (llm_agent/runtime/handlers/*.mjs) stay local and are resolved by name.
#
# Central repo located via: $SKILLS_REPO, then ~/Desktop/skills, then a cached clone.
#
# Usage:  npm run sync:skills   (or: bash scripts/sync-skills.sh)
set -euo pipefail

cd "$(dirname "$0")/.."
TARGET="$PWD/llm_agent/internal/skills"

central=""
if [ -n "${SKILLS_REPO:-}" ] && [ -d "$SKILLS_REPO/agent-tools" ]; then
    central="$SKILLS_REPO"
elif [ -d "$HOME/Desktop/skills/agent-tools" ]; then
    central="$HOME/Desktop/skills"
else
    cache="$HOME/.cache/dnsmalla-skills"
    if [ -d "$cache/.git" ]; then git -C "$cache" pull --ff-only
    else git clone --depth 1 https://github.com/dnsmalla/skills.git "$cache"; fi
    central="$cache"
fi

echo "central skills repo: $central"
# Domain tools → internal/skills (full mirror).
"$central/scripts/sync-agent-tools.sh" "$TARGET"
# Always-on global tools → global/ (copies the .md defs; the app-local
# system prompt.md and compose-prompt.mjs in that dir are preserved).
"$central/scripts/sync-agent-globals.sh" "$PWD/llm_agent/global"
echo "llm-ide agent-tool + agent-global definitions refreshed from central (handlers unchanged)."
