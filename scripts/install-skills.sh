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

# claude: only install skills (kit has no claude-specific agents/commands).
# The kit's install.sh replaces .claude/agents with a symlink to
# .skills/config/tool/claude/agents — which is empty — wiping local agent
# files. Exclude claude from the full install; we wire skills separately.
args=(
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
echo "    tools: cursor codex agents gemini (claude handled separately below)"
echo "    stacks: $STACKS"
bash "$KIT/scripts/install.sh" "$ROOT" "${args[@]}"

# Install claude skills manually: symlink each kit skill that lists 'claude'
# in its tools declaration. Agents are in .claude/agents/ as a real dir with
# symlinks — the kit's install.sh would replace that with an empty symlink dir.
echo "==> Installing claude skills"
mkdir -p "$ROOT/.claude/skills"
python3 - <<'PY'
import os, yaml, pathlib

kit = os.environ.get("KIT")
root = os.environ.get("ROOT")
reg = yaml.safe_load(open(f"{kit}/registry.yaml"))
skills_dir = pathlib.Path(f"{root}/.claude/skills")
linked = 0
for s in reg.get("skills", []):
    if "claude" not in s.get("tools", []):
        continue
    src = pathlib.Path(kit) / s["path"]
    if not src.exists():
        continue
    link = skills_dir / s["id"]
    if link.is_symlink():
        link.unlink()
    rel = os.path.relpath(src, skills_dir)
    link.symlink_to(rel)
    linked += 1
print(f"claude: linked {linked} skills -> .claude/skills")
PY
echo "✅ Skills installed for all agents."
