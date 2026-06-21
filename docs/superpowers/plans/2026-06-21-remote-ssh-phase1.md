# Remote SSH Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover SSH hosts from `~/.ssh/config` and open a remote shell for one in the existing terminal panel, configured from a new Remote/SSH Settings section.

**Architecture:** A pure `SSHConfig` parser turns `~/.ssh/config` into `[RemoteHost]`. `TerminalSession` gains a remote mode that spawns `/usr/bin/ssh -t <alias>` (instead of `/bin/zsh`) through the existing SwiftTerm PTY; `TerminalPanelState.connectRemote(host:)` opens such a session and reveals the panel. A `RemoteSSHSettingsSection` lists discovered hosts with Connect buttons. Auth is fully delegated to `ssh`/config — no secrets, no Keychain, no AppConfig.

**Tech Stack:** Swift 5.9, SwiftUI, Swift Testing (`@Test`/`#expect`), SwiftTerm (`LocalProcessTerminalView`).

**Spec:** `docs/superpowers/specs/2026-06-21-remote-ssh-phase1-design.md`

**Branch:** `feat/remote-ssh-phase1`

> **Note on commands:** `swift build`/`swift test` run from the `mac/` directory. In this sandboxed environment they require the Bash tool's `dangerouslyDisableSandbox: true`.

---

## File Structure

**New**
- `mac/Sources/LlmIdeMac/Services/SSHConfig.swift` — `RemoteHost` model, `SSHConfig` parser/discovery, `RemoteSSHCommand` (ssh path + args). One responsibility: turn ssh config into connectable hosts + build the ssh command. Pure/`nonisolated`.
- `mac/Sources/LlmIdeMac/Views/Settings/RemoteSSHSettingsSection.swift` — the Settings UI listing hosts + Connect.
- `mac/Tests/LlmIdeMacTests/SSHConfigTests.swift` — parser + command + subtitle tests.
- `mac/Tests/LlmIdeMacTests/TerminalRemoteTests.swift` — session title + `connectRemote` tests.

**Modified**
- `mac/Sources/LlmIdeMac/Views/Terminal/TerminalSession.swift` — optional `remoteAlias`; `start()` spawns ssh when set.
- `mac/Sources/LlmIdeMac/Views/Terminal/TerminalPanelState.swift` — `connectRemote(host:)`.
- `mac/Sources/LlmIdeMac/Views/SettingsView.swift` — register `RemoteSSHSettingsSection` in the App group.

---

## Task 1: SSHConfig parser, RemoteHost, RemoteSSHCommand

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/SSHConfig.swift`
- Test: `mac/Tests/LlmIdeMacTests/SSHConfigTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/LlmIdeMacTests/SSHConfigTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

struct SSHConfigTests {
    @Test func parsesMultipleHostsWithFields() {
        let cfg = """
        Host web
            HostName 10.0.0.5
            User deploy
            Port 2222

        Host db
            HostName db.internal
        """
        let hosts = SSHConfig.parse(cfg)
        #expect(hosts.map(\.alias) == ["web", "db"])
        let web = hosts.first { $0.alias == "web" }
        #expect(web?.hostName == "10.0.0.5")
        #expect(web?.user == "deploy")
        #expect(web?.port == 2222)
    }

    @Test func skipsWildcardOnlyBlocks() {
        let cfg = """
        Host *
            User root
        Host *.internal
            User admin
        Host prod
            HostName prod.example.com
        """
        #expect(SSHConfig.parse(cfg).map(\.alias) == ["prod"])
    }

    @Test func mixedConcreteAndWildcardKeepsFirstConcrete() {
        let cfg = """
        Host prod *.internal
            HostName prod.example.com
        """
        let hosts = SSHConfig.parse(cfg)
        #expect(hosts.map(\.alias) == ["prod"])
        #expect(hosts.first?.hostName == "prod.example.com")
    }

    @Test func ignoresCommentsBlankLinesAndIsCaseInsensitive() {
        let cfg = """
        # a comment
        Host srv

          hostname  example.com
          USER  me
        """
        let hosts = SSHConfig.parse(cfg)
        #expect(hosts.count == 1)
        #expect(hosts.first?.hostName == "example.com")
        #expect(hosts.first?.user == "me")
    }

    @Test func emptyInputYieldsNoHosts() {
        #expect(SSHConfig.parse("").isEmpty)
    }

    @Test func discoverMissingFileReturnsEmpty() {
        let url = URL(fileURLWithPath: "/nonexistent/\(UUID().uuidString)/config")
        #expect(SSHConfig.discover(configURL: url).isEmpty)
    }

    @Test func remoteCommandArgsForceTTY() {
        #expect(RemoteSSHCommand.args(forAlias: "prod") == ["-t", "prod"])
    }

    @Test func subtitleComposesUserHostPort() {
        let h = RemoteHost(alias: "web", hostName: "10.0.0.5", user: "deploy", port: 2222)
        #expect(h.subtitle == "deploy@10.0.0.5:2222")
    }

    @Test func subtitleFallsBackToAliasWhenNoHostName() {
        let h = RemoteHost(alias: "box", hostName: nil, user: nil, port: nil)
        #expect(h.subtitle == "box")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && swift test --filter SSHConfigTests`
Expected: FAIL — "cannot find 'SSHConfig'/'RemoteHost'/'RemoteSSHCommand' in scope".

- [ ] **Step 3: Implement `SSHConfig.swift`**

Create `mac/Sources/LlmIdeMac/Services/SSHConfig.swift`:

```swift
import Foundation

/// A connectable host discovered from `~/.ssh/config`.
struct RemoteHost: Identifiable, Hashable {
    var id: String { alias }
    let alias: String       // the `Host` token used as `ssh <alias>`
    let hostName: String?   // HostName
    let user: String?       // User
    let port: Int?          // Port

    /// Display subtitle, e.g. "deploy@10.0.0.5:2222"; falls back to the alias.
    var subtitle: String {
        var s = ""
        if let user { s += "\(user)@" }
        s += hostName ?? alias
        if let port { s += ":\(port)" }
        return s
    }
}

/// Reads + parses `~/.ssh/config` into connectable hosts. Pure where it can be
/// (parse from a String) so it's unit-testable without disk.
enum SSHConfig {
    static var defaultConfigURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".ssh/config")
    }

    /// Read the config file (or return [] if absent/unreadable) and parse it.
    static func discover(configURL: URL? = nil) -> [RemoteHost] {
        let url = configURL ?? defaultConfigURL
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return parse(text)
    }

    /// Parse ssh-config text into hosts. One host per `Host` block, keyed by the
    /// first concrete (non-wildcard) pattern on the `Host` line; wildcard-only
    /// blocks are skipped. `Include` directives are not expanded (Phase 1).
    static func parse(_ text: String) -> [RemoteHost] {
        var hosts: [RemoteHost] = []
        var alias: String? = nil
        var hostName: String? = nil
        var user: String? = nil
        var port: Int? = nil

        func flush() {
            if let alias { hosts.append(RemoteHost(alias: alias, hostName: hostName, user: user, port: port)) }
            alias = nil; hostName = nil; user = nil; port = nil
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }

            // "Key rest of line" — key is the first token, value is the remainder.
            let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            guard let keyToken = parts.first else { continue }
            let key = keyToken.lowercased()
            let value = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""

            if key == "host" {
                flush()
                // First concrete pattern (no '*' or '?') becomes the alias.
                let patterns = value.split(separator: " ").map(String.init)
                alias = patterns.first { !$0.contains("*") && !$0.contains("?") }
                // wildcard-only block → alias stays nil → flush() skips it
            } else if alias != nil {
                switch key {
                case "hostname": hostName = value.isEmpty ? nil : value
                case "user":     user = value.isEmpty ? nil : value
                case "port":     port = Int(value)
                default:         break
                }
            }
        }
        flush()
        return hosts
    }
}

/// The system-`ssh` command used to open a remote shell.
enum RemoteSSHCommand {
    static let sshPath = "/usr/bin/ssh"
    /// `-t` forces a PTY so remote full-screen programs (vim/htop) and prompts
    /// (passphrase, host-key) work in the terminal.
    static func args(forAlias alias: String) -> [String] { ["-t", alias] }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mac && swift test --filter SSHConfigTests`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SSHConfig.swift mac/Tests/LlmIdeMacTests/SSHConfigTests.swift
git commit -m "feat(remote-ssh): SSHConfig parser + RemoteHost + RemoteSSHCommand"
```

---

## Task 2: Remote spawn in TerminalSession

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Terminal/TerminalSession.swift`
- Test: `mac/Tests/LlmIdeMacTests/TerminalRemoteTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/LlmIdeMacTests/TerminalRemoteTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

struct TerminalRemoteTests {
    @Test @MainActor func remoteSessionTitleAndAlias() {
        let s = TerminalSession(number: 3, workingDirectory: URL(fileURLWithPath: "/"),
                                remoteAlias: "prod")
        #expect(s.title == "ssh: prod")
        #expect(s.remoteAlias == "prod")
    }

    @Test @MainActor func localSessionTitleAndNilAlias() {
        let s = TerminalSession(number: 3, workingDirectory: URL(fileURLWithPath: "/"))
        #expect(s.title == "zsh 3")
        #expect(s.remoteAlias == nil)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && swift test --filter TerminalRemoteTests`
Expected: FAIL — "extra argument 'remoteAlias' in call" / "value of type 'TerminalSession' has no member 'remoteAlias'".

- [ ] **Step 3: Add `remoteAlias` to TerminalSession + branch `start()`**

In `mac/Sources/LlmIdeMac/Views/Terminal/TerminalSession.swift`, change the stored properties + init. Replace:

```swift
    let id = UUID()
    var title: String
    var status: SessionStatus = .running
    var workingDirectory: URL
```

with:

```swift
    let id = UUID()
    var title: String
    var status: SessionStatus = .running
    var workingDirectory: URL
    /// When non-nil, this session is a remote SSH shell (`ssh -t <alias>`)
    /// rather than a local login shell. Auth is delegated to ssh/~/.ssh/config.
    let remoteAlias: String?
```

Replace the init:

```swift
    init(number: Int, workingDirectory: URL) {
        self.title = "zsh \(number)"
        self.workingDirectory = workingDirectory
    }
```

with:

```swift
    init(number: Int, workingDirectory: URL, remoteAlias: String? = nil) {
        self.remoteAlias = remoteAlias
        self.title = remoteAlias.map { "ssh: \($0)" } ?? "zsh \(number)"
        self.workingDirectory = workingDirectory
    }
```

Replace the body of `start()` (the shell-resolution + spawn) — from the start of the method through `self.status = .running` — with:

```swift
    func start() {
        let executable: String
        let args: [String]

        if let alias = remoteAlias {
            guard FileManager.default.fileExists(atPath: RemoteSSHCommand.sshPath) else {
                spawnError = "ssh not found at \(RemoteSSHCommand.sshPath)."
                status = .dead
                return
            }
            executable = RemoteSSHCommand.sshPath
            args = RemoteSSHCommand.args(forAlias: alias)
        } else {
            if FileManager.default.fileExists(atPath: "/bin/zsh") {
                executable = "/bin/zsh"
            } else if FileManager.default.fileExists(atPath: "/bin/bash") {
                executable = "/bin/bash"
            } else {
                spawnError = "Shell not found. Check /bin/zsh or /bin/bash."
                status = .dead
                return
            }
            args = ["--login"]
        }

        // Give the terminal a non-zero initial frame so SwiftTerm calculates
        // a sensible initial PTY size (cols/rows). Programs like vim and htop
        // read the terminal size at startup; a 0×0 frame renders incorrectly.
        let tv = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        tv.processDelegate = self

        // Curated environment — passes only the variables a user shell needs.
        let env = Self.shellEnvironment()

        tv.startProcess(
            executable: executable,
            args: args,
            environment: env,
            execName: URL(fileURLWithPath: executable).lastPathComponent,
            currentDirectory: workingDirectory.path
        )

        self.termView = tv
        self.termViewForDeinit = tv
        self.status = .running
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mac && swift test --filter TerminalRemoteTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Terminal/TerminalSession.swift mac/Tests/LlmIdeMacTests/TerminalRemoteTests.swift
git commit -m "feat(remote-ssh): TerminalSession spawns ssh -t <alias> for remote sessions"
```

---

## Task 3: TerminalPanelState.connectRemote

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Terminal/TerminalPanelState.swift`
- Test: `mac/Tests/LlmIdeMacTests/TerminalRemoteTests.swift` (add to the existing file)

- [ ] **Step 1: Add the failing test**

Append to `struct TerminalRemoteTests` in `mac/Tests/LlmIdeMacTests/TerminalRemoteTests.swift`:

```swift
    @Test @MainActor func connectRemoteOpensRemoteTabAndPanel() {
        let state = TerminalPanelState()
        state.connectRemote(host: RemoteHost(alias: "prod", hostName: nil, user: nil, port: nil))
        #expect(state.sessions.count == 1)
        #expect(state.sessions.first?.remoteAlias == "prod")
        #expect(state.isOpen == true)
        #expect(state.activeDockTab == .terminal)
        #expect(state.activeIndex == 0)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter TerminalRemoteTests`
Expected: FAIL — "value of type 'TerminalPanelState' has no member 'connectRemote'".

- [ ] **Step 3: Implement `connectRemote`**

In `mac/Sources/LlmIdeMac/Views/Terminal/TerminalPanelState.swift`, add this method inside the `// MARK: - Actions` section (e.g. right after `addTab(in:)`):

```swift
    /// Open a remote SSH session for `host` and reveal the terminal panel.
    /// The PTY (`ssh -t <alias>`) starts when the session view mounts.
    func connectRemote(host: RemoteHost) {
        let session = TerminalSession(
            number: nextTabNumber,
            workingDirectory: FileManager.default.homeDirectoryForCurrentUser,
            remoteAlias: host.alias)
        nextTabNumber += 1
        sessions.append(session)
        activeIndex = sessions.count - 1
        activeDockTab = .terminal
        isOpen = true
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter TerminalRemoteTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Terminal/TerminalPanelState.swift mac/Tests/LlmIdeMacTests/TerminalRemoteTests.swift
git commit -m "feat(remote-ssh): TerminalPanelState.connectRemote opens a remote session"
```

---

## Task 4: RemoteSSHSettingsSection view

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Settings/RemoteSSHSettingsSection.swift`

SwiftUI views aren't unit-tested in this codebase (the logic it calls —
`SSHConfig.discover`, `RemoteHost.subtitle`, `connectRemote` — is already
covered by Tasks 1–3). This task is verified by a successful build; the
end-to-end smoke test is in Task 5.

- [ ] **Step 1: Create the view**

Create `mac/Sources/LlmIdeMac/Views/Settings/RemoteSSHSettingsSection.swift`:

```swift
import SwiftUI

/// Lists SSH hosts discovered from ~/.ssh/config and connects to one by
/// opening a remote shell in the terminal panel. Read-only: hosts are managed
/// by editing ~/.ssh/config. Auth is delegated entirely to ssh/config.
struct RemoteSSHSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @Environment(TerminalPanelState.self) private var terminal

    @State private var hosts: [RemoteHost] = []

    var body: some View {
        SettingsSectionCard(icon: "network", title: "Remote / SSH") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                if hosts.isEmpty {
                    SettingsHint("No connectable hosts found in ~/.ssh/config. Add Host entries there to connect.")
                } else {
                    ForEach(hosts) { host in
                        hostRow(host)
                        if host.id != hosts.last?.id { Divider() }
                    }
                }

                HStack {
                    Button("Refresh") { hosts = SSHConfig.discover() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    Spacer()
                }
                .padding(.top, Spacing.xs)

                SettingsHint("Hosts are read from ~/.ssh/config (Include directives aren't expanded). Connecting opens a remote shell in the Terminal panel using your existing ssh keys/agent.")
            }
        }
        .onAppear { if hosts.isEmpty { hosts = SSHConfig.discover() } }
    }

    @ViewBuilder
    private func hostRow(_ host: RemoteHost) -> some View {
        HStack(spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(host.alias)
                    .font(Typography.bodyStrong)
                    .foregroundStyle(theme.current.text)
                Text(host.subtitle)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer()
            Button("Connect") { terminal.connectRemote(host: host) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.vertical, 2)
    }
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd mac && swift build`
Expected: "Build complete!" with no errors.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/RemoteSSHSettingsSection.swift
git commit -m "feat(remote-ssh): RemoteSSHSettingsSection lists hosts + Connect"
```

---

## Task 5: Register the section + end-to-end verification

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/SettingsView.swift`

- [ ] **Step 1: Register the section in the App group**

In `mac/Sources/LlmIdeMac/Views/SettingsView.swift`, inside the first
`Group { … }` (the "App" group), add `RemoteSSHSettingsSection()` right after
the `ConnectionsSettingsSection(api: api).id("connections")` line:

```swift
                        ConnectionsSettingsSection(api: api).id("connections")
                        RemoteSSHSettingsSection().id("remote-ssh")
                        AppearanceSettingsSection()
```

- [ ] **Step 2: Build + run the full test suite**

Run: `cd mac && swift build && swift test`
Expected: "Build complete!" and "Test run with N tests ... passed" (N = prior count + 12 new: 9 SSHConfig + 3 TerminalRemote).

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SettingsView.swift
git commit -m "feat(remote-ssh): register Remote/SSH settings section"
```

- [ ] **Step 4: Manual smoke test**

Run: `cd mac && bash Scripts/build.sh && open LlmIdeMac.app`
Then:
1. Open **Settings** → expand **Remote / SSH**.
2. Confirm hosts from your `~/.ssh/config` are listed (alias + `user@host:port`).
   If your config has none, the empty-state hint shows instead.
3. Click **Connect** on a reachable host → the terminal panel opens with a
   `ssh: <alias>` tab and the remote shell prompt (answer any host-key /
   passphrase prompt inline).
4. Close the tab → `ssh` exits, the tab disappears.

---

## Self-Review

**Spec coverage:**
- Discover hosts from ~/.ssh/config (read-only) → Task 1 (`SSHConfig`).
- Remote/SSH Settings section, Connect per host, Refresh, empty state → Tasks 4 + 5.
- Connect opens `ssh -t <alias>` in the terminal → Tasks 2 + 3.
- Disconnect = close tab → existing `closeTab` (unchanged; verified in Task 5 smoke).
- Wildcard exclusion / mixed-pattern / case-insensitive keys / missing file → Task 1 tests.
- No secrets / Keychain / AppConfig changes → confirmed (no such code in any task).
- Error handling (no config, ssh missing) → empty state (Task 4) + `spawnError` (Task 2).

**Placeholder scan:** None — every step has full code/commands.

**Type consistency:** `RemoteHost(alias:hostName:user:port:)`, `SSHConfig.parse(_:)`/`.discover(configURL:)`, `RemoteSSHCommand.sshPath`/`.args(forAlias:)`, `TerminalSession(number:workingDirectory:remoteAlias:)` + `.remoteAlias`/`.title`, `TerminalPanelState.connectRemote(host:)` — all used consistently across tasks and tests.
