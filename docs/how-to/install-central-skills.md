---
title: Install central skills for all agents
applies_to: docs, extension, mac
---

# Install central skills for all agents

## Goal

Wire the pinned [dnsmalla/skills](https://github.com/dnsmalla/skills) kit so Claude Code, Cursor, Codex, `.agents`, and Gemini all see the same SKILL.md catalogue — with no vendored copies in this repo.

## Background

| Family | Where it lives | How llm-ide consumes it |
|---|---|---|
| Process / domain `SKILL.md` skills | `.skills/skills/` (submodule) | `bash scripts/install-skills.sh` → relative symlinks under `.claude/skills`, `.cursor/skills`, `.codex/skills`, `.agents/skills`, `.gemini/skills` |
| Agent-loop tool defs | `.skills/agent-tools/` + `.skills/agent-globals/` | `cd extension && npm run sync:skills` → committed mirrors under `extension/llm_agent/` |
| Handlers (executable code) | stay in this repo | `extension/llm_agent/runtime/handlers/` |

Do **not** add project-local skills under `.claude/skills/` anymore. Author them in the central kit, bump the `.skills` submodule pin, then re-install.

## Steps

### 1. Init the submodule (first clone / after pull)

```bash
git submodule update --init --recursive .skills
```

`./setup.sh` does this automatically.

### 2. Install into every agent tool

```bash
bash scripts/install-skills.sh
# preview:
bash scripts/install-skills.sh --dry-run
```

This calls `.skills/scripts/install.sh` with tools `claude cursor codex agents gemini` and stacks `typescript,swift`.

### 3. (Optional) Claude Code marketplace — zero-copy alternative

If you prefer the marketplace instead of (or in addition to) project symlinks:

```text
/plugin marketplace add dnsmalla/skills
/plugin install skills@dnsmalla-skills
```

### 4. Refresh agent-loop tool definitions

After bumping the `.skills` pin (or editing agent-tools/globals in central):

```bash
cd extension && npm run sync:skills
```

Commit the mirrored `.md` files **and** `extension/.skills-lock`.

## Bumping the kit

```bash
cd .skills && git fetch && git checkout <tag-or-sha> && cd ..
git add .skills
bash scripts/install-skills.sh
cd extension && npm run sync:skills   # if agent-tools/globals changed
```

## Auto-install into user projects (Mac app)

When you **New Project** or **Settings → Paths → Rebuild missing folders**, the Mac
app:

1. Scaffolds folders **and** root agent entry files (`CLAUDE.md`, `AGENTS.md`,
   `.cursorrules`, `GEMINI.md`) that point every tool at `.claude/project.md`
   plus the per-tool skills/rules dirs.
2. Calls the local server (with a local `install.sh` fallback):

```http
POST /kb/project/install-skills
{ "path": "/absolute/project/root", "language": "en" }
```

The server only installs into folders that already have `system/project.json`
(the LLM IDE project marker). It runs the same kit `install.sh` so Claude /
Cursor / Codex / `.agents` / Gemini get relative skill symlinks inside that
project. Real files the scaffolder wrote (e.g. `.claude/settings.json`,
hand-authored `CLAUDE.md` without the `llmide:auto` marker) are preserved.

| Tool | Entry file | Skills / rules |
|------|------------|----------------|
| Claude Code | `CLAUDE.md` | `.claude/skills/`, `.claude/rules/` |
| Cursor | `.cursorrules` | `.cursor/skills/`, `.cursor/rules/` |
| Codex | `AGENTS.md` | `.codex/skills/`, `.codex/rules/` |
| Gemini | `GEMINI.md` | `.gemini/skills/`, `.gemini/rules/` |

## Verification

- `ls -la .cursor/skills/token-efficient-workflow` → symlink into `../../.skills/skills/...`
- Cursor / Claude / Codex can invoke `/token-efficient-workflow`
- Create a new project in the Mac app → `.cursor/skills/` appears under the project root
- `cd extension && npm test -- tests/install-project-skills.test.mjs` green
