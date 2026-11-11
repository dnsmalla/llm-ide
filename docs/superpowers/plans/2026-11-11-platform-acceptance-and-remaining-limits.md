# Platform Acceptance and Remaining Limits — Plan (2026-11-11)

> **For agentic workers:** use checkboxes (`- [ ]`) to track this plan. Do not start feature work from "Remaining backlog"
> until the packaged-app acceptance pass is green on Windows and Ubuntu.

**Goal:** verify that the packaged desktop app works on Windows 11 and Ubuntu 24.04, then finish the remaining
cross-cutting limitations found in the 2026-11-11 system review.

**Starting point:** `main` at `d434f22da`; desktop API 144; issue writes are always-on; the bundled core is killed by
the rebuild script; Rust builds with zero warnings.

**Why this order:** the core lifecycle, issue write routing, graph layout, Help/OS UI, rebuild handling and Rust
warnings all changed in one day. macOS development passed, but the Windows and Linux installers have not been tested
in a real window. A platform failure invalidates any feature work done before it.

---

## Phase 1 — unsigned desktop release dry run

- [ ] Run the unsigned release workflow from `main`:
  ```bash
  gh workflow run desktop-release.yml
  gh run watch
  ```
- [ ] Download the artefacts:
  - Windows x64 `LLM-IDE_X.Y.Z_x64-setup.exe`
  - Ubuntu x64 `.deb` and `.AppImage`
  - macOS `.dmg` for control
- [ ] Record the run URL, version and commit here:
  - Run:
  - Version:
  - Commit:

## Phase 2 — Windows 11 x64 acceptance

### Install
- [ ] Run `LLM-IDE_*_x64-setup.exe`.
- [ ] Confirm **Windows protected your PC** → **More info** → **Run anyway** (expected: unsigned).
- [ ] No admin prompt; per-user install completes.
- [ ] App starts; no missing WebView2 error.

### Core lifecycle
- [ ] Core starts on `127.0.0.1:3456`; `Core ready` in the bottom bar.
- [ ] **Kill & Restart** replaces the process, waits for `/health`, and does not show a false “unreachable”.
- [ ] Close and reopen the app: only one core process, no `EADDRINUSE`.
- [ ] Settings → Server & Backend shows a fresh uptime.

### Must-pass flows
- [ ] Create or open a project.
- [ ] Settings → Providers: save a key, test it.
- [ ] Terminal opens and runs a command (ConPTY).
- [ ] Issue window: edit title/labels; **Save works** (no `Not found`).
- [ ] Comment posts.
- [ ] Factory board loads.
- [ ] Graph opens and a hub drills into a circular graph.
- [ ] Library shows Code and Data sections.

### Windows specifics
- [ ] Credential Manager contains `com.llmide.desktop` entries; no plaintext key file.
- [ ] Data is under `%LOCALAPPDATA%\llm-ide-desktop`.
- [ ] Windows uninstall removes the app; data and credentials are handled as documented.

## Phase 3 — Ubuntu 24.04 x64 acceptance

### Secret Service first
- [ ] GNOME Keyring or KWallet is running.
- [ ] Without Secret Service, the app reports the clear error and does **not** start a core with plaintext secrets.

### Install both formats
- [ ] `sudo apt install ./LLM-IDE_*_amd64.deb`; `libayatana-appindicator3-1` is pulled.
- [ ] `chmod +x` and run the AppImage; install `libfuse2` if the FUSE error appears.
- [ ] Tray icon and menu work on GNOME/Wayland.

### Core and flows
- [ ] Core starts, Kill & Restart works, no stale core on `3456`.
- [ ] Terminal opens with the login shell.
- [ ] Project, Providers, Issue edit/save, Factory, Graph, Library all pass as on Windows.
- [ ] Data is under `~/.local/share/llm-ide-desktop`; secrets are in Secret Service.
- [ ] AppImage update path is checked (mock/latest channel); `.deb` upgrade uses `apt`.

## Phase 4 — fix only what the pass finds

Likely platform-specific fixes, in order of probability:

- [ ] Windows terminal shell/PTY startup.
- [ ] Windows Credential Manager read/write failure.
- [ ] Linux Secret Service unavailable/locked startup path.
- [ ] Ubuntu tray/appindicator visibility.
- [ ] Windows `%LOCALAPPDATA%` and Linux XDG path handling in project/terminal code.
- [ ] Orphaned core after a rebuild or crash on either OS.
- [ ] Unsigned Windows updater behaviour.
- [ ] AppImage FUSE/desktop-entry behaviour.

Each fix gets one regression test or a documented manual step here.

## Phase 5 — remaining feature backlog

Only start these after Phase 2 and Phase 3 pass.

### 1. Comment pagination
- [ ] Add page/per_page to `/kb/issues/detail` for GitHub comments and GitLab notes.
- [ ] Return `hasMore` and next cursor/page.
- [ ] UI: “Load older comments” appends rather than replacing.
- [ ] Test: 150 comments → first 100, then the remaining 50 exactly once.

### 2. Local database backup/restore
- [ ] Settings → Agent history: “Back up data” writes a verified copy of `data.db` + `agent.db`.
- [ ] Restore is explicit, typed-confirm, and stops the core first.
- [ ] Backups are never overwritten silently; show path and size.
- [ ] Test: backup, mutate, restore, verify both databases and migration head.

### 3. Graph paged/streamed read
- [ ] Replace the whole-file 128 MB read with a host summary/index read.
- [ ] Load node/edge layers on demand; keep the overview budgets.
- [ ] Hard-fail the old full read above the cap with a clear message.
- [ ] Test: synthetic 40 MB graph opens without loading every node into the webview at once.

### 4. Visual/E2E gate
- [ ] Playwright screenshots for Explorer, Library, Settings, Issues, Gantt, Factory, OS/System.
- [ ] Dark/Midnight/Light and 1440/1920 widths.
- [ ] Fail on unexpected layout overflow or blank primary content.
- [ ] Keep the manual D7 Factory checklist for real provider work.

### 5. Gantt provider-date reconciliation
- [ ] Decide: push local start/due to the provider, or keep the overlay explicitly local.
- [ ] If push: GitLab due date + milestone; GitHub can only update milestone/dates through the overlay.
- [ ] Show “Provider date” vs “Planned date” when they differ.

### 6. OS historical charts
- [ ] Keep a bounded daily rollup for tokens, runs, storage and activity.
- [ ] Add 7/30-day sparklines to the OS rail.
- [ ] No unbounded table scans; cap retention.

### 7. Terminal session restore
- [ ] Persist tab list/cwd (not scrollback) across app restart.
- [ ] Restore only when the project root matches.
- [ ] Never restore a dead PTY as live.

## Decisions still needed

- [ ] Graph: lower the 128 MB cap to a safer number until paged reads exist?
- [ ] Issues: paginate comments at 100, 50, or 25 per request?
- [ ] Backup: automatic daily copy, manual only, or both?
- [ ] Windows signing: keep unsigned, or add Azure Trusted Signing?
- [ ] Gantt: provider dates authoritative, or local overlay authoritative?

## References

- [desktop-release.md](../../how-to/desktop-release.md)
- [desktop-secret-store.md](../../how-to/desktop-secret-store.md)
- [desktop-core-lifecycle.md](../../how-to/desktop-core-lifecycle.md)
- [2026-11-08-system-limitations-fixes.md](2026-11-08-system-limitations-fixes.md)
- [invariants.md](../../explanation/invariants.md)
