---
title: CLI scripts
source: setup.sh, run.sh, extension/start.sh
---

# CLI scripts

| Script | What it does | When to use |
|---|---|---|
| `./setup.sh` | Verifies Node + npm, runs `npm install` in `extension/`, optionally installs the Claude CLI. | One-time install on a new machine. |
| `./run.sh` | Builds the macOS app (`swift build`), packages it under `/tmp/LlmIdeMac.app`, kills any running instance, opens the app. | Fast iteration on the macOS app during development. |
| `./extension/start.sh` | Boots the server with a "Quick Start" banner; runs `npm install` if `node_modules/` is missing, then `node server.mjs`. | First-time server launch; also wrapped by `npm start`. |

## Environment overrides

See [environment variables reference](env-vars.md) for the full list.
