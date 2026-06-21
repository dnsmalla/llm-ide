# Remote SSH — Phase 1 design (connection discovery + remote terminal)

**Date:** 2026-06-21
**Status:** Approved (brainstorm) — pending implementation plan
**Component:** macOS app (`mac/`)

## Goal

Let the user connect to a remote server over SSH and work in a remote shell
inside the LLM IDE — the first phase of a "VS Code Remote-SSH"-style feature.

## Roadmap context (why this is Phase 1)

Full Remote-SSH (the whole IDE operating against a remote host) is too large
for a single change, so it is decomposed into shippable phases, each its own
spec → plan → build:

- **Phase 1 (this spec)** — Connection management + remote terminal. Discover
  hosts from `~/.ssh/config`; connect to one and get a remote shell in the
  terminal panel. Establishes the connection + UX model everything else builds
  on, and is useful on its own.
- **Phase 2 (later)** — Remote files over SFTP: browse/open/edit remote files
  in the tree; set a remote folder as the workspace.
- **Phase 3 (later)** — Remote backend + agents: run the Node backend, file
  index, terminals, git, and the agent CLI on the remote (VS Code-Server
  style). The true "whole IDE runs remotely" piece.

Phases 2 and 3 depend on Phase 1.

## Scope (Phase 1)

### In scope
- Discover SSH hosts by parsing the user's `~/.ssh/config` (read-only).
- A new **Remote / SSH** Settings section listing discovered hosts, each with a
  **Connect** button and a **Refresh** control.
- **Connect** opens a new terminal tab in the existing terminal panel running
  the system `ssh` against the host's alias; the remote shell appears there.
- **Disconnect** = close the terminal tab (existing behavior; `ssh` exits).

### Non-goals (deferred)
- Any auth method other than what `~/.ssh/config` + `ssh` already provide
  (no in-app key paths, passphrases, or passwords; **no Keychain usage**).
- Writing to `~/.ssh/config` / adding hosts from the app.
- Favorites / friendly labels / persisted "last host".
- Status-bar quick-connect button and terminal `+`-menu connect entry points.
- `Include` directive expansion in `~/.ssh/config`.
- SFTP / remote file browsing / remote backend (Phases 2–3).

## Approach

Spawn the **system `ssh` binary inside the existing SwiftTerm terminal** — a
remote variant of how `TerminalSession` already spawns `/bin/zsh`. All
authentication (keys, passphrases, ssh-agent, jump hosts, host-key
verification) is delegated to `ssh` and `~/.ssh/config`. Consequences:

- The app stores **no secrets** and makes **no Keychain or AppConfig changes**.
- First-connect host-key prompts and passphrase prompts happen **interactively
  in the terminal**, exactly as in a normal terminal.

**Rejected alternative:** a Swift SSH library (e.g. Citadel/NMSSH). It would
reimplement known_hosts / agent / config handling and add a crypto dependency
for no benefit, since delegating to `ssh` covers every auth path for free.

## Components

Each unit is small, single-purpose, and independently testable.

### 1. `SSHConfig` parser — `mac/Sources/LlmIdeMac/Services/SSHConfig.swift`
Pure, `nonisolated` parsing of `~/.ssh/config` text into hosts.

```swift
struct RemoteHost: Identifiable, Hashable {
    var id: String { alias }
    let alias: String      // the `Host` token
    let hostName: String?  // HostName
    let user: String?      // User
    let port: Int?         // Port
}

enum SSHConfig {
    /// Parse config text into hosts. Pure → unit-testable without disk.
    static func parse(_ text: String) -> [RemoteHost]
    /// Read ~/.ssh/config (or return [] if absent/unreadable) and parse it.
    static func discover(configURL: URL = defaultConfigURL) -> [RemoteHost]
    static var defaultConfigURL: URL { /* ~/.ssh/config */ }
}
```

Parsing rules:
- A `Host` line starts a block; subsequent keys until the next `Host` belong
  to it.
- A `Host` line may list several space-separated patterns. From each line,
  keep the **concrete** patterns (those containing neither `*` nor `?`) as
  connectable aliases; drop wildcard patterns. A block whose patterns are all
  wildcards contributes no host. (A line like `Host prod *.internal` yields the
  single alias `prod`; the block's keys apply to it.)
- Keys are case-insensitive; capture `HostName`, `User`, `Port` for display.
- Ignore blank lines and `#` comments.
- Missing/unreadable file → `[]` (caller shows the empty state).

### 2. `RemoteSSHSettingsSection` — `mac/Sources/LlmIdeMac/Views/Settings/RemoteSSHSettingsSection.swift`
SwiftUI section (matching the existing `*SettingsSection` pattern + theme):
- On appear, calls `SSHConfig.discover()`; a **Refresh** button re-reads.
- Lists each `RemoteHost`: alias as the title, `user@hostName:port` subtitle,
  and a **Connect** button.
- Empty/guidance state when no hosts (no file, unreadable, or only wildcards):
  e.g. "No connectable hosts found in ~/.ssh/config." plus a one-line hint.
- A small footnote noting `Include` directives aren't expanded (Phase 1).
- **Connect** opens the terminal panel and adds a remote tab (see §4).
- Registered in the Settings sidebar/section list (`SettingsView`).

### 3. Remote terminal spawn — `mac/Sources/LlmIdeMac/Views/Terminal/TerminalSession.swift`
`TerminalSession` gains a remote mode alongside the local-shell path:
- A pure helper for the command, unit-tested:
  ```swift
  enum RemoteSSHCommand {
      static let sshPath = "/usr/bin/ssh"
      /// `-t` forces a PTY so remote programs (vim/htop) and prompts work.
      static func args(forAlias alias: String) -> [String] { ["-t", alias] }
  }
  ```
- The session spawns `sshPath` with `args(forAlias:)` (instead of
  `/bin/zsh --login`) using the same SwiftTerm `LocalProcessTerminalView` +
  curated environment plumbing. Title = `ssh: <alias>`.
- `/usr/bin/ssh` missing → the existing inline "shell not found" error path,
  reworded ("ssh not found at /usr/bin/ssh").

### 4. `TerminalPanelState` — `mac/Sources/LlmIdeMac/Views/Terminal/TerminalPanelState.swift`
Add an entry point to open a remote session and surface the panel:
```swift
func connectRemote(host: RemoteHost)   // add a remote session + open panel,
                                        // focus the Terminal dock tab
```
The local `addTab(in:)` path is unchanged.

## Data flow

1. User opens **Settings → Remote / SSH** → `SSHConfig.discover()` →
   `[RemoteHost]` rendered as a list.
2. User clicks **Connect** on a host → `TerminalPanelState.connectRemote(host:)`
   → panel opens, Terminal dock tab focused, a new session spawns
   `/usr/bin/ssh -t <alias>`.
3. SwiftTerm shows the remote shell; any host-key/passphrase prompts are typed
   interactively by the user.
4. **Disconnect**: user closes the terminal tab → existing SIGHUP teardown →
   `ssh` exits.

## Error handling

| Condition | Behavior |
|---|---|
| No `~/.ssh/config` / unreadable | Settings shows the empty/guidance state. |
| Only wildcard `Host` blocks | Same empty state (nothing connectable). |
| `/usr/bin/ssh` absent | Inline terminal error (existing pattern, reworded). |
| Bad host / auth fail / host-key change | Surfaced in the terminal output by `ssh`; the tab stays so the user can read it, then close. |

No new global error surfaces; failures live where the user acts (Settings list
or the terminal).

## Testing

- **`SSHConfigTests`** (`mac/Tests/LlmIdeMacTests/`): `parse(_:)` against
  fixtures — multiple hosts; wildcard-only blocks excluded; mixed
  concrete+wildcard kept; HostName/User/Port extraction; comments/blank lines;
  case-insensitive keys; empty input → `[]`.
- **`RemoteSSHCommand.args(forAlias:)`** test — asserts `["-t", alias]`.
- No persistence, Keychain, or `AppConfig` changes to test.

## Files

**New**
- `mac/Sources/LlmIdeMac/Services/SSHConfig.swift` (parser + `RemoteHost` +
  `RemoteSSHCommand`)
- `mac/Sources/LlmIdeMac/Views/Settings/RemoteSSHSettingsSection.swift`
- `mac/Tests/LlmIdeMacTests/SSHConfigTests.swift`

**Modified**
- `mac/Sources/LlmIdeMac/Views/Terminal/TerminalSession.swift` (remote spawn)
- `mac/Sources/LlmIdeMac/Views/Terminal/TerminalPanelState.swift`
  (`connectRemote`)
- `mac/Sources/LlmIdeMac/Views/Settings/SettingsView.swift` (register section)
