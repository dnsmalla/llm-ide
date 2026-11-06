# Next steps after the cleanup (2026-11-07)

**Goal:** a first real release of the four surfaces that remain — Tauri desktop, iPhone app, web app, Chrome
extension — with the shared Node core. Everything below is in priority order. The master plan stays the
complete list; this page only says what comes first.

## Track A — agents (code), about one working day

| # | Work | Plan | Size | Why now |
|---|---|---|---|---|
| A1 | Desktop archivist for extension captures | `plans/2026-11-07-desktop-capture-archivist.md` (being written) | 2-4 h | Since the Mac app's removal, meetings captured in Chrome are never saved as notes |
| A2 | Hosted issue write actions (create, comment, close) | `plans/2026-11-07-hosted-issue-writes.md` (being written) | 2-4 h | The desktop Issues screen's write buttons call routes the core does not serve |
| A3 | Review leftovers batch | this page, below | 1 h | Small items the reviews recorded but did not fix |
| A4 | Master-plan re-baseline | this page, below | 30 min | Many rows still measure against the retired Mac app |

Run each plan with the rules in [2026-11-06-next-4h-run.md](2026-11-06-next-4h-run.md): copy plan code and
tests word for word, do every step, stage only your own files, gates per task, push after each block.

### A3 — review leftovers (one small commit each)

1. Code Assistant toolbar toggle: restore `aria-expanded` / `aria-controls` (or `aria-pressed`) and the
   narrow-window disabled state and title, with the deleted tests back (review of `c8283838`, `023ff66a`).
2. Settings hints cut in `689c39d2`: restore the security context ("after a native confirmation" on the Terminal
   switch; the Loop warning "With no check, a repair can delete the failing test…" must be `role="alert"` or outside
   `st-hint` so compact view never hides it).
3. Rust `#[allow(dead_code)]` from `f98dc632`: delete `os_open::spawn_url`, `prefs::is_feature_key`,
   `prefs::effective_features`, `SecretBackend::delete` if unused; check why `CaptureState::Error` is never
   constructed (errors silently dropped?).
4. `scripts/build-desktop-mac.sh`: scope the `DYLD_LIBRARY_PATH` export to the cargo build step only.
5. Sync devices card: reset the module-level `keptStart` / `keptPoll` on sign-out or user change.
6. iPhone: if the Tailscale check (B3) fails, add a narrow ATS exception for the paired desktop instead of
   arbitrary loads.
7. `desktop/src-tauri/src/loop_runner.rs` `loop_boundary_warnings` runs `mac/Scripts/feature-boundaries.sh` if a
   project has it: generalize the name or drop the command.

### A4 — master-plan re-baseline

Retire (`[-]`, one line why) or reword every row that measures against the retired Swift app: "verified against
the Mac app", "Mac-parity round", "Phone sees archived chats and notes only through the Mac", "mirror-the-Mac",
"Mechanical parity inventory", "ui-kit parity bar against the Mac render", "Two Macs on one account". Replace
each kept one with what the Tauri desktop itself must do, and mark built screens that you have checked in a real
window as `[x]`. Then `node scripts/plan-status.mjs --fix` and `node scripts/user-needs.mjs --fix`.

## Track B — you (real devices and accounts), this weekend

| # | Check | How | Unblocks |
|---|---|---|---|
| B1 | Release dry run | `gh workflow run desktop-release.yml` (no secrets) | first real run on GitHub's runners; AppImage size |
| B2 | Updater key + first release | `docs/how-to/desktop-release.md` §2 (UN-115), then tag `desktop-v0.1.0` and run the checklist (UN-114) | signed installers, auto-update |
| B3 | iPhone over Tailscale | pair the iPhone from a `100.x` desktop address | whether ATS needs a narrow exception (A3 item 6) |
| B4 | Sync with real accounts | MEGA (dedicated account, 2FA off); own server (`deploy/vps/sync-sftp.md` + `check-sync.sh`); Box (`docs/how-to/sync-box-setup.md`) | SP1-SP6 `[x]` |
| B5 | Box and GitLab reading | `docs/how-to/read-box-gitlab-on-phone-and-web.md` | SP7 `[x]` |
| B6 | Web chat compose | core with `LLMIDE_HOST_API_READ=1 LLMIDE_HOST_API_COMPOSE=1`, re-pair the browser, pickers + a text attachment + New chat at phone width | web chat parity `[x]` |
| B7 | Desktop screens in a real window | open each section (Chat, Explorer, Library, Settings, Issues, Gantt, Graph, Doc Gen, Loop, Auto Tasks, Live) and note anything broken | Phase 3/5 rows `[x]` |
| B8 | A real meeting | extension capture after A1 lands; desktop Live capture on Zoom or Teams | live-capture and archivist rows |

## Later (not this weekend)

Push notifications (needs a design: APNs from the desktop, Web Push), command bus S4/S5, Windows and Linux
autobench, App Store submission (App Review now needs a real desktop: no demo mode), Chrome Web Store listing,
plugin hash pinning, token-saving work gated on the bench (X1-X3).
