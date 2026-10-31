# Running LLM-IDE (desktop) on your Mac

This is the Tauri desktop app: one window with Chat, Explorer (files, search, source control, terminal),
Library and Settings, backed by its own local core (a bundled Node server). It runs next to the Swift Mac app
without touching its data.

| | Desktop app (this) | Swift Mac app |
|---|---|---|
| Bundle id | `com.llmide.desktop` | `com.llmide.macapp` |
| App data | `~/Library/Application Support/llm-ide-desktop` | `~/Library/Application Support/llm-ide` |
| Core port | 3457 (then 3458, 3459) | 3456 |
| Keychain service | `com.llmide.desktop` | its own |

Nothing is shared: accounts, chats and the database are separate. The desktop app only adopts a core that
answers on 3456 if one is already running, and then marks it "adopted (unverified)" in the status bar and in
Settings > About; quit the Swift app first if you want the verified, app-owned core.

## Prerequisites

- macOS 12 or later, Apple Silicon or Intel (build on the Mac you will run it on).
- Xcode command line tools (`xcode-select --install`): `codesign`, `plutil`, `hdiutil`.
- Node 20 or later and npm (the build also downloads the pinned official Node that ships inside the app).
- Rust from rustup (https://rustup.rs). The build script uses `~/.rustup/toolchains/stable-*/bin/cargo`.
- Network access for the first build (Node download, `npm ci`, cargo crates).
- For a real model in Chat: **either** `claude login` in a terminal (Claude Code installed; the app finds it
  in `~/.claude/local`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin` or nvm), **or**
  a provider key you add in Settings > Providers. A real chat uses your plan or key; keep prompts short while testing.
  There is no fake model in the packaged app (the core's environment is scrubbed on purpose).

## Build and open

```bash
cd ~/llm-ide
scripts/build-desktop-mac.sh          # add --dmg for a disk image
```

The first run takes several minutes (Rust compile); later runs are faster. The script stages the core, runs the
security checks, builds, signs ad hoc, verifies the bundle and smoke-tests the core inside it, then prints:

```bash
open ~/llm-ide/desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app
```

The app is signed ad hoc and built on this Mac, so Gatekeeper has nothing to block. Only if you copy it from
another machine or download the `.dmg`, run `xattr -dr com.apple.quarantine /Applications/LLM-IDE.app` first.

Because the signature is ad hoc, every rebuild is a "new" app to macOS: the first start after a rebuild can ask
once to let LLM-IDE use its keychain items (click Always Allow), and folder access (Desktop, Documents,
Downloads) is asked again by the system.

Quit with Cmd+Q. Quitting stops the core and every terminal shell.

## First-run checklist

Try these in order. Note anything that differs in the bug-report template at the end.

1. **Sign in or create an account.** On the empty local core you see a sign-in / create-account panel. Create an
   account (any email, a password of your choice; it stays on this Mac). The status bar should read ready and
   Settings > About should say "Spawned by this app (identity verified)".
2. **Open a project.** Use Open folder in the status bar (a native dialog). Pick a small scratch folder, not
   your home folder: the home folder, `/` and system folders are refused on purpose.
3. **Chat.** Open Chat and send a short message such as "Say hi in five words." Watch the reply stream in.
   If it fails with a message about Claude Code, run `claude login` in a terminal (or add a provider key in
   Settings > Providers) and use Retry. Try the mode picker and the model picker.
4. **Approvals.** Switch the permission mode to Ask and ask for "Create a file hello.txt containing hi". An
   approval card should appear; try Deny once and Allow once once. Choose Bypass once: a native dialog (default
   button Cancel) must appear first. Cancel it.
5. **Trust banner.** Make a scratch folder with a `.mcp.json` (for example
   `{"mcpServers":{"demo":{"command":"echo","args":["hi"]}}}`), open it as the project and start a chat.
   A banner says the folder is untrusted and what was not loaded. Choose "Trust this folder...", confirm in the
   in-page dialog, then in the native dialog (it names the folder; default button Cancel). Press Cancel once
   (nothing is trusted), then repeat and confirm.
6. **Explorer.** Open Explorer: expand the tree, open a file, edit and save (Cmd+S). Then edit the same file
   from a terminal (`echo x >> file`) while the app has unsaved changes: the app must offer to reload or keep
   yours, never silently overwrite. Try rename, new file, delete (goes to the Trash). Delete a chat: a native dialog asks first and says a copy is kept for 30 days in the chat folder (`.deleted`).
7. **Search.** Cmd+Shift+F: search for a word, open a result at its line.
8. **Terminal.** Open the terminal dock in Explorer and start a shell. A native consent dialog appears the
   first time (its default button is Cancel; Allow terminal is the other one); refuse once (the dock shows a denied state with Try again), then allow. The approval lasts 30 minutes: after that a new terminal asks again and typing into an old one is refused. Type `exit`: the tab must
   say "(exited)" at once. Settings > Features has a Terminal switch (applies at next start).
9. **Source Control.** In a scratch repo (`git init` there, add a file) open it as the project, go to the Source
   Control panel, stage, write a message and commit. Confirm with `git log` in the terminal.
10. **Library.** Open Library, choose a notes folder (native dialog), see the notes listed. Try search, then the
    index rebuild (it reports progress and never deletes), and open a note to edit and save it. Connections
    (Email, Slack, Box, Repositories, Connectors) can be left alone; a secret you type is write-only.
11. **Extensions.** Library > Extensions: the installed list, the catalog, and the consent sheet before anything
    that can run code is enabled. Do not install anything you do not want.
12. **Settings.** Visit every section: Providers, Model routing (the router, token limit, prompt shortening and
    provider-limit switches apply at next start), Agent history (the archiving mode off / shadow / on and
    "applies the next time you open the app"), Extensions trust (Add folder opens a native dialog), Appearance
    (Dark, Light, Midnight), Workspace, Features, Account (sign out keeps your data), About (copy diagnostics).
13. **Quit and relaunch.** Cmd+Q, open the app again, sign in if asked: your chat list and the chat you had open
    must be there.
14. **Core crash and restart (your action).** In Activity Monitor find the `node` process whose parent is
    LLM-IDE (or `ps -ef | grep "extension/server.mjs"`) and force-quit it. The status bar should show restarting
    and then ready within a few seconds, and Chat should offer Retry. Five crashes within five minutes put the
    app in a "failed" state on purpose (no restart loop); quit and reopen to clear it.

## When something fails

- **Status bar and Settings > About** show the core state, whether it was spawned or adopted, and whether
  Claude Code was found.
- **`core.log`** lives at `~/Library/Application Support/llm-ide-desktop/core.log`. It exists only after a core
  failure, holds the redacted tail of the core's output, and is readable by you only (mode 0600). Settings >
  About shows its path.
- **Diagnostics without secrets:** Settings > About > Copy diagnostics gives versions and states only (no
  tokens, keys or file contents). Never attach anything from your keychain; `prefs.json` in the data folder
  is safe to attach, the database and `secrets` files are not.
- **Start from a terminal** to see host messages: `"/path/to/LLM-IDE.app/Contents/MacOS/llm-ide-desktop-poc"`
  (stop it with Cmd+Q in the app, or Ctrl+C in that terminal).
- **Reset:** quit the app and move `~/Library/Application Support/llm-ide-desktop` aside to start from an empty
  core. Remove the keychain item `com.llmide.desktop` too if the app says the secret store is unreadable.
- **Two apps on one port:** if the Swift app runs, the desktop app can adopt its core (unverified). Quit the
  Swift app and relaunch the desktop app for an app-owned core.

## Known gaps

Built and tested, but not yet exercised in a real window by anyone (the checklist rows are marked built, not
verified): everything above. Not built yet, from the parity checklist
(`docs/superpowers/plans/2026-10-31-tauri-parity-checklist.md`):

- Sections other than Chat, Explorer (with Search, Source Control, Terminal), Library and Settings: Live, Review
  Conflicts, Issues, Gantt, Visual, Doc Gen, Auto Tasks, Graph, Loop, System show as disabled "Soon".
- Shell: deep links (`llmide://`), activity bell, welcome and recovery screens, command palette, manual core
  restart button, hiding a section when its feature is off, window state restore of the project (you pick it
  from recent projects each launch).
- Chat: the archive settings card of the Swift app is replaced by the Agent history card; context meter has no
  breakdown.
- Explorer: project paths sheet, project memory viewer, hunk-level staging inside the editor diff (staging
  hunks is in Source Control).
- Library: plugin detail / git install / marketplace / Claude and Codex import sheets, LLM-source add, update
  and per-item checkboxes, source removal for some connectors.
- Settings: Backend (restart), Preferences, Tool approvals (stored rules), Agent SDK, Token saving, Memory and
  Paths sections of the Swift app have no desktop equivalent yet.
- The SDK's bundled `claude` binary is deliberately not shipped: Chat needs your own Claude Code install or a
  provider key.
- Developer ID signing and notarization, auto-update, Windows and Linux builds are not part of this build.

## Bug-report template

```
Screen / section:
macOS version, chip, app build date:
What I did (numbered steps):
1.
2.
Expected:
Actual:
Status bar text at the time (core state, trust, Claude found/missing):
core.log excerpt (redacted tail; remove anything private):
Screenshot (optional):
```
