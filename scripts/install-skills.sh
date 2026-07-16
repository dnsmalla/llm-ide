#!/usr/bin/env bash
# Wire the central skills kit (.skills submodule) into every AI tool this
# project uses: Claude Code, Cursor, Codex, open `.agents`, and Gemini.
#
# Skills are authored once in dnsmalla/skills and consumed here as relative
# symlinks (no vendored copies). Agent-loop tool DEFINITIONS still sync via
# `cd extension && npm run sync:skills` — this script is for the SKILL.md
# process/domain catalogue that Claude/Cursor/Codex discover.
#
# Usage (from repo root):
#   bash scripts/install-skills.sh
#   bash scripts/install-skills.sh --dry-run
#   bash scripts/install-skills.sh --prune
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
KIT="$ROOT/.skills"

if [ ! -f "$KIT/scripts/install.sh" ]; then
  echo "error: central skills kit missing at $KIT" >&2
  echo "  run:  git submodule update --init --recursive .skills" >&2
  exit 1
fi

# llm-ide stacks: TypeScript extension + Swift mac app.
STACKS="${LLMIDE_SKILL_STACKS:-typescript,swift}"

args=(
  --tool claude
  --tool cursor
  --tool codex
  --tool agents
  --tool gemini
  --stacks "$STACKS"
  --force
  --prune
)

# Forward any extra flags (--dry-run, etc.).
args+=("$@")

echo "==> Installing skills from $KIT into $ROOT"
echo "    tools: claude cursor codex agents gemini"
echo "    stacks: $STACKS"
bash "$KIT/scripts/install.sh" "$ROOT" "${args[@]}"
echo "✅ Skills installed for all agents."
