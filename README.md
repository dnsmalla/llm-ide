# LLM IDE

> End-to-end AI meeting intelligence — from live transcription to dispatched tickets, draft PRs, and a self-learning knowledge base. Runs entirely on `127.0.0.1`.

[![Version](https://img.shields.io/badge/version-3.0-blue.svg)](./extension/package.json)
[![API](https://img.shields.io/badge/API-v18-green.svg)](./docs/reference/api/openapi.yaml)
[![Manifest](https://img.shields.io/badge/manifest-V3-orange.svg)](./extension/manifest.json)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](#license)

## What this is

A Chrome extension + native macOS app + local Node server that captures meetings, generates plans, and dispatches the work. Nothing leaves your machine unless you approve a delivery action.

## Quick start

```bash
git clone <repo-url> llm-ide
cd llm-ide
./setup.sh
cd extension && npm run server
```

Then load `extension/dist/` as an unpacked Chrome extension. Full tutorial: [Record your first meeting](docs/tutorials/01-first-meeting.md).

## Mobile control

Control LLM IDE from your iPhone using the production-ready auto_swift_aicontrol system:

- **Remote desktop** - View and control your Mac from your iPhone
- **LLM IDE chat** - Ask questions and get responses on mobile
- **Meeting assistant** - AI co-pilot during video calls
- **Screen streaming** - Real-time desktop view (800×600 @ 10fps)

📱 **Quick start:** [docs/mobile/quick-start.md](docs/mobile/quick-start.md) - 3-step setup guide

**Verify installation:** `./scripts/mobile/verify-mobile-control.sh` - Automated system checks

## Documentation

📚 **Full docs:** https://grid-devs.gitlab.io/personal/dinesh/notes-extension/

Common entry points:

- [System architecture](docs/explanation/architecture.md)
- [API overview](docs/reference/api/overview.md)
- [Engineering invariants](docs/explanation/invariants.md) — read before changing the hot paths
- [Decisions index](docs/decisions/) — ADRs 0001–0015
- [How to contribute](docs/how-to/contribute.md)

## Project layout

```
llm-ide/
├── docs/         engineering docs — see docs site
├── extension/    Chrome extension + local Node server
├── mac/          SwiftUI macOS app
└── kb/           per-install SQLite (gitignored content)
```

## License

MIT.
