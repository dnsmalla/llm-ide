# First-Time Setup & After Pull

## New Machine Setup

```bash
# 1. Clone the repo
git clone git@github.com:dnsmalla/llm-ide.git
cd llm-ide

# 2. Run setup (installs all dependencies)
./setup.sh

# 3. Start the Node server
cd extension && npm run server

# 4. In another terminal, build the macOS app
cd mac && swift build
```

---

## After `git pull` on any machine

**Always run setup if you pulled changes:**

```bash
./setup.sh
```

This ensures:
- ✅ Node dependencies installed (`npm install` in extension/)
- ✅ Native modules rebuilt (better-sqlite3, etc.)
- ✅ Claude CLI verified
- ✅ Git hooks enabled

---

## Why `npm install` is needed

- `node_modules/` is in `.gitignore` (correct practice)
- Only `package-lock.json` is committed
- `package-lock.json` tells `npm install` what exact versions to download
- Without running `npm install`, you get: **"module not found"** errors

---

## Quick Commands

| Task | Command |
|------|---------|
| Full setup | `./setup.sh` |
| Just install deps | `cd extension && npm install` |
| Start Node server | `cd extension && npm run server` |
| Build macOS app | `cd mac && swift build` |
| Run tests | `cd extension && npm test` |

---

## Optional: token-saving tools

These cut how many tokens Claude Code spends while you work in this repo.
`./setup.sh` checks for rtk and prints the commands below; it never installs
or enables anything, because each tool changes your global AI-tool config.

| Tool | What it cuts | Status |
|------|--------------|--------|
| [rtk](https://github.com/rtk-ai/rtk) | Shell command output (`git`, tests, builds, package managers) by 60–90% | **Recommended** |
| [caveman](https://github.com/JuliusBrussee/caveman) | Claude's replies (skill) and what it reads (local proxy) | Optional |
| [headroom](https://github.com/headroomlabs-ai/headroom) | Tool outputs, logs, files, RAG chunks (local proxy or library) | Optional |

**rtk** — a single binary; its installer verifies the release checksum and
writes only `~/.local/bin/rtk`.

```bash
brew install rtk          # or: curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
rtk init -g --auto-patch --hook-only   # adds one Bash hook to ~/.claude/settings.json
rtk init --show                        # confirm the hook is configured
rtk gain                               # tokens saved so far
rtk init -g --uninstall                # remove it again
```

Installing the binary alone does nothing: rtk only works once the hook rewrites
commands (`git status` → `rtk git status`). The hook covers Bash calls only —
Claude Code's own Read / Grep / Glob tools bypass it.

**caveman** — the skill makes every reply very terse; the proxy routes all
your Claude traffic through a local server. Try the skill alone first
(`npx skills add JuliusBrussee/caveman -g`) and drop it if replies get too
clipped.

**headroom** — `pip install "headroom-ai[all]"`, then `headroom proxy`; also a
local proxy for all traffic. Worth it mainly for log- and JSON-heavy sessions.

**Not for LLM-IDE's own chats.** The server runs Claude with your user hooks
and settings switched off (`--setting-sources ''`, see
`extension/providers/providers.mjs`), so these tools speed up *your* Claude
Code sessions, not the chats inside the LLM-IDE app.

Already covered elsewhere: Serena (semantic code retrieval) and context7
(library docs). Skipped: code-review-graph (overlaps LLM-IDE's code graph) and
chop (same job as rtk, little adoption).

## Common Errors After Pull

### ❌ "Cannot find module 'docx'"
→ Run `./setup.sh`

### ❌ "Cannot find module 'js-yaml'"  
→ Run `./setup.sh`

### ❌ "Server starts but gives 404 on routes"
→ Make sure Node server running: `cd extension && npm run server`

---

## Troubleshooting

If `./setup.sh` fails:

```bash
# Clean install
rm -rf extension/node_modules
npm ci --prefix extension     # Uses package-lock.json for exact versions

# Or use the full setup
./setup.sh --force
```
