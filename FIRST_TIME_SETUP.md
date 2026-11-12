# First-Time Setup & After Pull

## New Machine Setup

```bash
# 0. Prerequisites (new Mac): Xcode CLT, Node 22+, Rust 1.88+, Claude CLI
xcode-select --install
# Homebrew first if missing: https://brew.sh
brew install node                                   # must be v22 or newer
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # then open a new shell
# Claude CLI: https://docs.claude.com/en/docs/claude-code/quickstart, then `claude login`

# 1. Clone the repo (with submodules: graph-kit, .skills)
git clone --recurse-submodules git@github.com:dnsmalla/llm-ide.git
cd llm-ide

# 2. Run setup (checks prerequisites; installs extension, ui/kit, desktop and graph-kit/web deps)
./setup.sh

# 3. Start the Node server
cd extension && npm run server

# 4. In another terminal, run the desktop app (deps already installed by setup.sh)
cd desktop && npm run tauri dev
```

---

## Load the Chrome extension

```bash
cd extension && npm run build     # writes extension/dist/ (gitignored, so build before loading)
cd extension && npm run server    # the core on http://127.0.0.1:3456; keep it running
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked**, then pick `llm-ide/extension/dist/`.
3. Pin the extension icon in the toolbar.

## Build and install the macOS app

`npm run tauri dev` is the debug app. For normal use build the release app:

```bash
bash scripts/build-desktop-mac.sh
open desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app
ditto desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app /Applications/LLM-IDE.app   # optional: install
```

The desktop app starts its own core; Settings → Features switches features off (applied on the next core start). The release
app and the debug binary are different macOS programs, so a folder allowed by macOS privacy (TCC) for one is not
automatically allowed for the other. Grant the debug binary Desktop / Full Disk Access, or keep the project outside
`~/Desktop`, `~/Documents` and `~/Downloads`. Full checklist: [desktop/RUN-ON-MAC.md](desktop/RUN-ON-MAC.md).

## Check your tools

```bash
node --version     # v22 or newer
npm --version      # v10 or newer
claude --version   # then `claude login`
git --version
cargo --version    # desktop app only
```

Xcode is optional: it is needed for the iPhone app (a physical device), `make test-shared-protocol` and `make test-ios-app`.

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
| Run desktop app | `cd desktop && npm run tauri dev` |
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

In the desktop app, **Settings → Token Saving → Install rtk** runs `brew install rtk`
for you. It installs the binary only; turning on the hook is still the
`rtk init` step above, because the hook auto-approves every command it
rewrites (`git push --force` included) and skips Claude Code's permission prompt.

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot find module 'docx'", "js-yaml" or any other npm error | `./setup.sh`, or clean: `rm -rf extension/node_modules && npm ci --prefix extension` |
| "Node.js 22+ is required" / "node: command not found" | Install Node 22+ ([nodejs.org](https://nodejs.org/) or `brew install node`); Node 20 is no longer supported |
| "cargo: command not found" (desktop app) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh`, open a new shell, run `./setup.sh` |
| "resource path `../resources/core` doesn't exist" (`tauri dev`) | The desktop core is not staged: `./setup.sh`, or `node desktop/scripts/stage-core.mjs` |
| "Could not load …/graph-kit/web/node_modules/three/build/three.module.js" | `git submodule update --init --recursive graph-kit && npm ci --prefix graph-kit/web` (`./setup.sh` does both) |
| "claude: command not found" | Install it ([guide](https://docs.claude.com/en/docs/claude-code/quickstart)), then `claude login` |
| "Port 3456 already in use" | `lsof -i :3456`, stop that process, start the server again. If another program holds it, the desktop falls back to 3457-3459 |
| Server starts but routes answer 404 | The Node server is not running: `cd extension && npm run server` |
| Chrome extension not updating | `cd extension && npm run build`, refresh at `chrome://extensions`, then hard-reload the meeting tab (Cmd+Shift+R) |
| "Load unpacked" fails: no `dist` folder | `extension/dist/` is gitignored: `cd extension && npm run build` first |
| iPhone: Execute, Auto Tasks or Loop tabs missing | Restart the desktop core, then pair the phone again (a device paired earlier keeps its old grants) |
| Settings or data lost after a pull | Your data is safe, a pull only changes code. Meetings and the KB live in the app data directory; user settings in `~/.llmide/` |

If `./setup.sh` itself fails, read the ❌ lines it prints (each names the missing prerequisite), fix those, and run it again. It is safe to repeat.
