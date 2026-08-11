# Skills Sources (Mac) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the server's skills-source registry (`/auth/me/skills-sources/*`, shipped in `docs/superpowers/plans/2026-08-11-skills-sources-server.md`) in the Mac app: a "Skills Sources" sub-section in Library, and source labels in the chat "/" menu.

**Architecture:** A new `LlmIdeAPIClient+SkillsSources.swift` extension mirrors the five endpoints with plain `async throws` methods (no completion-handler style anywhere in this codebase). The Library sidebar gets a second, visually-distinct sub-section alongside `pluginsSection` — new `SkillsSourceRow` (inline enable `Toggle`, unlike plugin rows which only toggle in the detail pane) and `SkillsSourceDetailView`, following the file-per-row/file-per-detail split `PluginLibraryRow.swift`/`PluginDetailView.swift` already use. State and networking live directly on `LibraryView` as `@State`, exactly like `plugins: [PluginInfo]` today — no new `*Store`/`*Service` class, matching the precedent that plugins management has none either. `ShellState.LibrarySelection` gains a `.skillsSource(String)` case. The chat "/" menu (`CompletionController.swift`) gains a `sourceName` label on each discovery-skill row, fed by two new fields on `SkillLibraryEntry`.

**Tech Stack:** Swift (macOS app, SwiftPM), SwiftUI, `swift build` / `swift test`, `NSWorkspace`/`NSOpenPanel`.

## Global Constraints

- **No client-side admin gating.** Confirmed by reading every existing API-client + view file: nothing in this codebase pre-checks `UserInfo.role` before calling an admin-gated endpoint. The convention is "call it, let a 403 surface via `APIError.http` and show the message" (see `LibraryView.performInstall`'s `catch let APIError.http(...)`, `PluginDetailView`/`uninstall`'s generic `catch { loadError = error.localizedDescription }`). Skills-source add/update/remove follow the same pattern — do not add a role check.
- **Do not reuse `PluginGitInstaller.normalize()`.** It accepts `http://`, `git@host:...`, and other schemes the server's `normalizeGitUrl()` (extension/skills-sources/registry.mjs) rejects (https-only). Reusing it would let the Mac UI accept URLs the server then 400s on. Write a narrower client-side loose-check (non-empty, `https://` prefix) purely to gray out the submit button early — the server remains the authority, and its `{error, status}` message is what gets shown on rejection.
- **No client-side git clone.** Unlike Plugin installs (Mac clones+zips, then uploads bytes — see `PluginGitInstaller.cloneAndZip`), skills-sources `add` just POSTs `{url, ref?, name?}` (or `{path, name?}`) as JSON; the *server* clones. Do not port `cloneAndZip`-style logic to Mac for this feature.
- **DTOs use plain `String` for `origin`**, not a Swift enum — mirrors every other server-tagged field in this codebase (`PluginInfo` has no enums either) and tolerates the server adding a `marketplace` origin later (phase 2) without a client rebuild being required to *decode* it (though the UI badge switch does need a `default:` case — see Task 2).
- **Swift type suffixes:** no new `*Service`/`*Store`/`*Manager` — this feature needs none, per the plugins precedent above.
- **Branch:** continue on `feat/skills-sources` (server work already lives there).
- **Commit:** Conventional Commits, one concern per commit, e.g. `feat(mac): ...`; only when the user asks.

## File Structure

- **Create** `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+SkillsSources.swift` — DTOs + 5 methods.
- **Create** `mac/Sources/LlmIdeMac/Views/Library/SkillsSourceRow.swift` — sidebar row (icon, origin badge, name, skill count, inline enable `Toggle`).
- **Create** `mac/Sources/LlmIdeMac/Views/Library/SkillsSourceDetailView.swift` — detail pane (version, location, ref, Update / Reveal / Remove actions; builtin shows Install when not checked out).
- **Create** `mac/Sources/LlmIdeMac/Views/Library/SkillsSourceAddSheet.swift` — Add-by-URL-or-path sheet.
- **Modify** `mac/Sources/LlmIdeMac/Services/ShellState.swift` — `LibrarySelection.skillsSource(String)` case.
- **Modify** `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` — `skillsSourcesSection` + header menu + state + actions, inserted into `mainList` after `pluginsSection`.
- **Modify** `mac/Sources/LlmIdeMac/Views/Library/LibraryDetailView.swift` — route `.skillsSource(let id)` to the new detail view.
- **Modify** `mac/Sources/LlmIdeMac/Models/Theme.swift` — new `categoryAmber` hue so Skills Sources reads as visually distinct from Plugins' teal, per the design's "visually distinct" requirement.
- **Modify** `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+AgentMeta.swift` — `SkillLibraryEntry` gains `sourceId`/`sourceName`.
- **Modify** `mac/Sources/LlmIdeMac/Views/CodeCompletion/CompletionController.swift` — surface `sourceName` in the "/" menu detail label.
- **Create** `mac/Tests/LlmIdeMacTests/SkillsSourceDTOTests.swift` — one decode-shape test per response type, catching server/client field-name drift (the kind of mismatch Task 7 of the server plan already hit once with `isAuthRoute`).

---

### Task 1: API client — DTOs + methods

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+SkillsSources.swift`
- Test: `mac/Tests/LlmIdeMacTests/SkillsSourceDTOTests.swift`

**Interfaces:**
- Produces: `listSkillsSources() async throws -> [SkillsSourceInfo]`, `toggleSkillsSource(id:enabled:) async throws`, `addSkillsSource(url:path:ref:name:) async throws -> SkillsSourceSummary`, `updateSkillsSource(id:) async throws -> Bool /* installed */`, `removeSkillsSource(id:) async throws`.
- Exact server response shapes (from `extension/server/auth-routes.mjs` + `extension/skills-sources/registry.mjs`, verified live in the prior session):
  - `GET /auth/me/skills-sources` → `{ sources: [{ id, name, origin, location, builtin, version?, ref?, installed, skillCount, enabled }] }`
  - `POST .../toggle` `{id, enabled}` → `{ ok, enabled }`
  - `POST .../add` `{url?, path?, ref?, name?}` → success `{ source: { id, name, origin, location, builtin, version?, ref? } }` (note: **no** `installed`/`skillCount`/`enabled` on this shape — those only exist on the list snapshot); failure `{ error: { code, message } }` with HTTP 400/403.
  - `POST .../update` `{id}` → `{ ok, installed? }` (only present for the builtin source).
  - `DELETE .../<id>` → `{ ok }`.

- [ ] **Step 1: Write the DTOs + methods**

```swift
import Foundation

// Skills-source registry — GET/POST/DELETE /auth/me/skills-sources/*.
// Mirrors extension/skills-sources/registry.mjs. Discovery-only sources:
// each contributes chat "/" menu skills (via /kb/agent/skill-library), never
// agent-loadable tools — see the design doc's Safety section.
extension LlmIdeAPIClient {

    struct SkillsSourceInfo: Decodable, Identifiable, Equatable {
        let id: String
        let name: String
        let origin: String       // "builtin" | "git" | "local" (server may add more later)
        let location: String?    // absolute path (in-place read) — nil if never resolved
        let builtin: Bool
        let version: String?
        let ref: String?
        let installed: Bool
        let skillCount: Int
        let enabled: Bool
    }
    private struct SkillsSourcesListResponse: Decodable { let sources: [SkillsSourceInfo] }

    struct SkillsSourceSummary: Decodable {
        let id: String
        let name: String
        let origin: String
        let location: String?
        let builtin: Bool
        let version: String?
        let ref: String?
    }
    private struct AddSkillsSourceResponse: Decodable { let source: SkillsSourceSummary }

    private struct ToggleAck: Decodable { let ok: Bool; let enabled: Bool }
    private struct UpdateAck: Decodable { let ok: Bool; let installed: Bool? }
    private struct RemoveAck: Decodable { let ok: Bool }

    /// All registered skills sources with this user's per-source enable state.
    /// Fails gracefully at the call site the same way `listPlugins()` doesn't —
    /// callers here use `try?` at the LibraryView call site instead.
    func listSkillsSources() async throws -> [SkillsSourceInfo] {
        let resp: SkillsSourcesListResponse = try await get("/auth/me/skills-sources", authenticated: true)
        return resp.sources
    }

    @discardableResult
    func toggleSkillsSource(id: String, enabled: Bool) async throws -> Bool {
        struct Req: Encodable { let id: String; let enabled: Bool }
        let ack: ToggleAck = try await post("/auth/me/skills-sources/toggle",
                                            body: Req(id: id, enabled: enabled),
                                            authenticated: true)
        return ack.enabled
    }

    /// Register a new source. Exactly one of `url`/`path` must be non-nil —
    /// the server 400s otherwise. Admin-gated server-side (403 surfaces via
    /// `APIError.http`, no client-side pre-check — see Global Constraints).
    func addSkillsSource(url: String? = nil, path: String? = nil, ref: String? = nil, name: String? = nil) async throws -> SkillsSourceSummary {
        struct Req: Encodable { let url: String?; let path: String?; let ref: String?; let name: String? }
        let resp: AddSkillsSourceResponse = try await post("/auth/me/skills-sources/add",
                                                           body: Req(url: url, path: path, ref: ref, name: name),
                                                           authenticated: true)
        return resp.source
    }

    /// Re-sync a source (git: fetch + checkout tracked ref; local: refresh
    /// version; builtin: `git submodule update --init .skills`). Returns
    /// whether the builtin submodule ended up checked out — irrelevant
    /// for non-builtin sources (nil in the response, defaults false).
    @discardableResult
    func updateSkillsSource(id: String) async throws -> Bool {
        struct Req: Encodable { let id: String }
        let ack: UpdateAck = try await post("/auth/me/skills-sources/update",
                                            body: Req(id: id),
                                            authenticated: true)
        return ack.installed ?? false
    }

    /// Remove a registered source (and its clone dir, if any). The server
    /// rejects removing `builtin` with a 400 — surfaced as `APIError.http`.
    func removeSkillsSource(id: String) async throws {
        guard let slug = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { throw APIError.invalidURL }
        let _: RemoveAck = try await delete("/auth/me/skills-sources/\(slug)", authenticated: true)
    }
}
```

- [ ] **Step 2: Write the decode-shape test**

Create `mac/Tests/LlmIdeMacTests/SkillsSourceDTOTests.swift`. Confirmed by reading `AgentProgressLabelTests.swift`: this suite uses `XCTest`, and the testable import target is `LlmIdeMacLib` (the library target name in `Package.swift`), **not** `LlmIdeMac`:

```swift
// Decode-shape guard: catches server/client field-name drift before it ships
// (the isAuthRoute allowlist miss during the server plan was exactly this
// class of bug, one layer further down the stack).
import XCTest
@testable import LlmIdeMacLib

final class SkillsSourceDTOTests: XCTestCase {
    func testDecodesListResponse() throws {
        let json = """
        {"sources":[{"id":"builtin","name":"Central Skills","origin":"builtin",
        "location":"/repo/.skills","builtin":true,"version":"3.0.0",
        "installed":true,"skillCount":57,"enabled":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.SkillsSourceInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.sources.count, 1)
        XCTAssertEqual(decoded.sources[0].id, "builtin")
        XCTAssertNil(decoded.sources[0].ref)
    }

    func testDecodesAddResponseWithoutListOnlyFields() throws {
        let json = """
        {"source":{"id":"other","name":"other","origin":"local",
        "location":"/tmp/other-repo","builtin":false,"version":"3.0.0"}}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let source: LlmIdeAPIClient.SkillsSourceSummary }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.source.id, "other")
        XCTAssertEqual(decoded.source.origin, "local")
    }
}
```

- [ ] **Step 3: Build + run**

```bash
cd /Users/dinsmallade/llm-ide/mac
swift build 2>&1 | tail -20
swift test --filter SkillsSourceDTOTests 2>&1 | tail -30
```
Expected: clean build; both decode tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+SkillsSources.swift mac/Tests/LlmIdeMacTests/SkillsSourceDTOTests.swift
git commit -m "feat(mac): skills-sources API client + DTOs"
```

---

### Task 2: `ShellState.LibrarySelection` + Theme hue

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift`
- Modify: `mac/Sources/LlmIdeMac/Models/Theme.swift`

**Interfaces:**
- Produces: `ShellState.LibrarySelection.skillsSource(String)` (the associated `String` is the source's `id`); `Theme.categoryAmber: Color`.

- [ ] **Step 1: Add the selection case**

In `mac/Sources/LlmIdeMac/Services/ShellState.swift`, next to the existing `.plugin(String)` case (around line 80-85):

```swift
    enum LibrarySelection: Hashable {
        case meeting(String)
        case file(URL)
        /// A plugin row. String is the plugin's `name` field.
        case plugin(String)
        /// A skills-source row. String is the source's `id` field.
        case skillsSource(String)
    }
```

- [ ] **Step 2: Add the theme hue**

In `mac/Sources/LlmIdeMac/Models/Theme.swift`, next to `categoryTeal` (around line 111-117), following the exact same per-`id` branch shape (never a raw `.orange`):

```swift
    var categoryAmber: Color {
        switch id {
        case "light":    return Color(red: 0.72, green: 0.48, blue: 0.08)
        case "midnight": return Color(red: 0.95, green: 0.78, blue: 0.45)
        default:         return Color(red: 0.90, green: 0.70, blue: 0.35) // dark
        }
    }
```

- [ ] **Step 3: Build**

```bash
cd /Users/dinsmallade/llm-ide/mac && swift build 2>&1 | tail -20
```
Expected: `Build complete!` (nothing yet references the new case/color, so this just confirms no syntax errors).

- [ ] **Step 4: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/ShellState.swift mac/Sources/LlmIdeMac/Models/Theme.swift
git commit -m "feat(mac): skillsSource selection case + amber category hue"
```

---

### Task 3: `SkillsSourceRow` + `SkillsSourceDetailView`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Library/SkillsSourceRow.swift`
- Create: `mac/Sources/LlmIdeMac/Views/Library/SkillsSourceDetailView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryDetailView.swift`

**Interfaces:**
- Consumes: `LlmIdeAPIClient.SkillsSourceInfo` (Task 1); `Theme.categoryAmber` (Task 2).
- Produces: row + detail views; `LibraryDetailView` routes `.skillsSource(let id)`.

- [ ] **Step 1: Write the row**

```swift
import SwiftUI

/// Sidebar row for a registered skills source. Unlike `PluginLibraryRow`
/// (enable toggle lives only in the detail pane), the enable toggle is
/// INLINE here — per the design doc, since toggling a source is the single
/// most common action (it directly gates what shows up in the chat "/" menu).
struct SkillsSourceRow: View {
    let source: LlmIdeAPIClient.SkillsSourceInfo
    let onToggle: (Bool) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "books.vertical.fill")
                .foregroundStyle(source.enabled ? Color.accentColor : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(source.name).font(.callout).lineLimit(1)
                    originBadge
                    if !source.installed {
                        Text("not installed")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15))
                            .cornerRadius(3)
                    }
                }
                Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Toggle("", isOn: Binding(get: { source.enabled }, set: onToggle))
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private var originBadge: some View {
        Text(origin.label)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(origin.color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(origin.color.opacity(0.15))
            .clipShape(Capsule())
    }

    /// Origin label/color kept as a plain switch with a `default` case
    /// (not an exhaustive Swift enum on the wire type) — the server can add
    /// an origin (e.g. "marketplace", phase 2) without a client rebuild
    /// breaking decode; only the badge falls back to a generic look.
    private var origin: (label: String, color: Color) {
        switch source.origin {
        case "builtin": return ("builtin", .secondary)
        case "git":     return ("git", .blue)
        case "local":   return ("local", .green)
        default:        return (source.origin, .secondary)
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if source.skillCount > 0 { parts.append("\(source.skillCount) skill\(source.skillCount == 1 ? "" : "s")") }
        if let v = source.version, !v.isEmpty { parts.append("v\(v)") }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }
}
```

- [ ] **Step 2: Write the detail view**

```swift
import SwiftUI

/// Detail pane for a skills source: version/location/ref, and the
/// Update / Reveal / Remove actions the design doc calls for. The builtin
/// source shows "Install" instead of "Update" when its submodule isn't
/// checked out (the only source kind with a real re-fetch path when
/// missing — a local/git source with a missing directory can't be revived
/// by "Update" either, since fetch/checkout both need the dir to exist; the
/// fix there is Remove + re-add). Remove never shows for builtin — the
/// server rejects it anyway, this just avoids a pointless round trip.
///
/// Mutations here don't push a refresh back to the sidebar's own
/// `[SkillsSourceInfo]` state — matching `PluginDetailView`, which has the
/// same gap (toggling a plugin's enabled state in its detail pane doesn't
/// refresh `LibraryView.plugins` either). The sidebar catches up on the
/// next full Library reload; see "Implementation notes" at the end of this
/// plan for why the `onChanged` closure sketched below was dropped.
struct SkillsSourceDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    let api: LlmIdeAPIClient
    let sourceId: String

    @State private var source: LlmIdeAPIClient.SkillsSourceInfo?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                if !loaded {
                    ProgressView().controlSize(.small)
                } else if let err = loadError {
                    Text(err).foregroundStyle(theme.current.danger).font(.callout)
                } else if let source {
                    infoBlock(source)
                    actionsRow(source)
                } else {
                    Text("Source not found — it may have been removed.")
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: sourceId) { await load() }
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "books.vertical.fill")
                .font(.system(size: 28))
                .foregroundStyle(source?.enabled == true ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(source?.name ?? sourceId).font(.title2.bold())
                if let source, let v = source.version, !v.isEmpty {
                    Text("v\(v)").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let source {
                Toggle("Enabled", isOn: Binding(
                    get: { source.enabled },
                    set: { newValue in Task { await toggle(newValue) } }
                ))
                .toggleStyle(.switch)
                .disabled(busy)
            }
        }
    }

    @ViewBuilder
    private func infoBlock(_ s: LlmIdeAPIClient.SkillsSourceInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Details").font(.headline)
            LabeledContent("Origin", value: s.origin)
            if let loc = s.location { LabeledContent("Location", value: loc) }
            if let ref = s.ref { LabeledContent("Ref", value: ref) }
            LabeledContent("Skills", value: "\(s.skillCount)")
            if !s.installed {
                Text(s.builtin
                     ? "The bundled .skills submodule isn't checked out. Install to fetch it."
                     : "This source's directory is missing on disk.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func actionsRow(_ s: LlmIdeAPIClient.SkillsSourceInfo) -> some View {
        HStack(spacing: 10) {
            Button(s.installed ? "Update" : "Install") { Task { await update() } }
                .disabled(busy)
            if s.location != nil, s.installed {
                Button("Reveal in Finder") { reveal(s) }
                    .disabled(busy)
            }
            if !s.builtin {
                Button("Remove", role: .destructive) { Task { await remove() } }
                    .disabled(busy)
            }
        }
    }

    // MARK: - Data + actions

    private func load() async {
        loaded = false
        loadError = nil
        do {
            let sources = try await api.listSkillsSources()
            self.source = sources.first { $0.id == sourceId }
        } catch {
            self.loadError = error.localizedDescription
        }
        loaded = true
    }

    private func toggle(_ enabled: Bool) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.toggleSkillsSource(id: sourceId, enabled: enabled)
            await load()
            onChanged()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func update() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.updateSkillsSource(id: sourceId)
            await load()
            onChanged()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            try await api.removeSkillsSource(id: sourceId)
            onChanged()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func reveal(_ s: LlmIdeAPIClient.SkillsSourceInfo) {
        guard let loc = s.location else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: loc, isDirectory: true)])
    }
}
```

- [ ] **Step 3: Wire `LibraryDetailView`**

In `mac/Sources/LlmIdeMac/Views/Library/LibraryDetailView.swift`, add a case (the `onChanged` closure needs a way back into `LibraryView`'s refresh — thread it through as a parameter on `LibraryDetailView`, matching how `api` is already passed in):

```swift
struct LibraryDetailView: View {
    let api: LlmIdeAPIClient
    /// Called by SkillsSourceDetailView after add/toggle/update/remove so
    /// LibraryView's sidebar list (a separate @State array) stays in sync.
    var onSkillsSourcesChanged: () -> Void = {}
    @Environment(ShellState.self) private var shell

    var body: some View {
        switch shell.librarySelection {
        case .meeting:
            MeetingDetailView(api: api)

        case .file(let url):
            FileDetailView(url: url)

        case .plugin(let name):
            PluginDetailView(api: api, pluginName: name)

        case .skillsSource(let id):
            SkillsSourceDetailView(api: api, sourceId: id, onChanged: onSkillsSourcesChanged)

        case nil:
            ContentUnavailableView {
                Label("Select an Item", systemImage: "doc.text")
            } description: {
                Text("Choose a meeting, file, plugin, or skills source from the list.")
            }
        }
    }
}
```

- [ ] **Step 4: Find and update `LibraryDetailView`'s call site**

```bash
cd /Users/dinsmallade/llm-ide && grep -rn "LibraryDetailView(" mac/Sources/LlmIdeMac
```
Update the call site to pass `onSkillsSourcesChanged: { Task { await refreshSkillsSources() } }` — `refreshSkillsSources()` is defined in Task 5. If Task 5 hasn't landed yet in your working tree, pass `{}` here temporarily and revisit once Task 5's function exists (or do Task 5 before this step in your actual execution order — the two are entangled by design, since the sidebar state lives in `LibraryView` while the detail pane lives in a sibling file).

- [ ] **Step 5: Build**

```bash
cd /Users/dinsmallade/llm-ide/mac && swift build 2>&1 | tail -20
```
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Views/Library/SkillsSourceRow.swift mac/Sources/LlmIdeMac/Views/Library/SkillsSourceDetailView.swift mac/Sources/LlmIdeMac/Views/Library/LibraryDetailView.swift
git commit -m "feat(mac): skills-source row + detail view"
```

---

### Task 4: `SkillsSourceAddSheet`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Library/SkillsSourceAddSheet.swift`

**Interfaces:**
- Produces: a sheet offering Git URL (+ optional ref/branch) or a local path (via `NSOpenPanel`, directories only), with `onSubmit(url: String?, path: String?, ref: String?, name: String?)` / `onCancel()` closures — same closure-passing shape as `PluginGitInstallSheet`, no ViewModel.

- [ ] **Step 1: Write the sheet**

```swift
import SwiftUI

/// Add a skills source: a public Git URL (cloned server-side — see the
/// server plan's `addSource`) or a local directory already containing
/// `registry.yaml` or `.claude-plugin/plugin.json` + `skills/`. Loose
/// client-side validation only disables the submit button early; the
/// server's `normalizeGitUrl`/`isValidSkillsSource` are the real gate, and
/// their rejection message is what the caller (LibraryView) surfaces on
/// failure — do not duplicate that logic here.
struct SkillsSourceAddSheet: View {
    let onSubmit: (_ url: String?, _ path: String?, _ ref: String?, _ name: String?) -> Void
    let onCancel: () -> Void

    private enum Kind: String, CaseIterable { case git = "Git URL", local = "Local Path" }
    @State private var kind: Kind = .git
    @State private var url = ""
    @State private var ref = ""
    @State private var path = ""
    @State private var name = ""
    @FocusState private var urlFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add skills source").font(.headline)
            Picker("", selection: $kind) {
                ForEach(Kind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if kind == .git {
                Text("Public HTTPS URL only. Cloned shallowly on the server.")
                    .font(.caption).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Git URL").font(.callout)
                    TextField("https://github.com/owner/repo", text: $url)
                        .textFieldStyle(.roundedBorder)
                        .focused($urlFocused)
                        .onSubmit { submitIfValid() }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Branch or tag (optional)").font(.callout)
                    TextField("main", text: $ref)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { submitIfValid() }
                }
            } else {
                Text("A local directory containing registry.yaml, or .claude-plugin/plugin.json + skills/.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    TextField("/path/to/repo", text: $path)
                        .textFieldStyle(.roundedBorder)
                    Button("Choose…") { chooseFolder() }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Name (optional)").font(.callout)
                TextField("Display name", text: $name)
                    .textFieldStyle(.roundedBorder)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }
                Button("Add") { submitIfValid() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isValid)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { urlFocused = kind == .git }
    }

    private var isValid: Bool {
        switch kind {
        case .git:
            return url.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("https://")
        case .local:
            return !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose a skills source directory"
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let chosen = panel.url {
            path = chosen.path
        }
    }

    private func submitIfValid() {
        guard isValid else { return }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .git:
            let trimmedRef = ref.trimmingCharacters(in: .whitespacesAndNewlines)
            onSubmit(url.trimmingCharacters(in: .whitespacesAndNewlines), nil,
                     trimmedRef.isEmpty ? nil : trimmedRef,
                     trimmedName.isEmpty ? nil : trimmedName)
        case .local:
            onSubmit(nil, path.trimmingCharacters(in: .whitespacesAndNewlines), nil,
                     trimmedName.isEmpty ? nil : trimmedName)
        }
    }
}
```

- [ ] **Step 2: Build**

```bash
cd /Users/dinsmallade/llm-ide/mac && swift build 2>&1 | tail -20
```
Expected: `Build complete!` (unreferenced until Task 5).

- [ ] **Step 3: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Views/Library/SkillsSourceAddSheet.swift
git commit -m "feat(mac): skills-source add sheet"
```

---

### Task 5: `LibraryView` — Skills Sources sub-section

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift`

**Interfaces:**
- Produces: `skillsSourcesSection`, `skillsSourcesHeader`, `loadSkillsSources()`, `refreshSkillsSources()`, `toggleSource(_:enabled:)`, `addSource(url:path:ref:name:)`, inserted into `mainList` right after `pluginsSection`; wired into the view's `.task` and error-alert plumbing the same way plugins are.

- [ ] **Step 1: Add state**

Next to the existing plugin `@State` vars (around line 43-51):

```swift
    /// Registered skills sources for the current user. Loaded once on
    /// appear and refreshed after any add/toggle/update/remove — same
    /// pattern as `plugins`.
    @State private var skillsSources: [LlmIdeAPIClient.SkillsSourceInfo] = []
    @State private var showingSkillsSourceAddSheet = false
    @State private var skillsSourceMessage: String?
```

Add `"skillsSources"` to the default-collapsed set on the `collapsedSectionsRaw` `@AppStorage` default (line 56): `"meetings,code,data,notes,plugins,skillsSources"`.

- [ ] **Step 2: Load on appear**

Next to `.task { await loadPlugins() }` (line 74):

```swift
        .task { await loadSkillsSources() }
```

- [ ] **Step 3: Insert the section into `mainList`**

Right after `pluginsSection` (line 217 area):

```swift
            // ── Skills Sources section ────────────────────────────────
            // Registered skills repos (builtin .skills + user-added git/local
            // sources). Discovery-only — contributes to the chat "/" menu via
            // /kb/agent/skill-library, never to loadable agent tools. See
            // docs/superpowers/specs/2026-08-11-skills-sources-design.md.
            skillsSourcesSection
```

- [ ] **Step 4: Write the section + header**

Modeled directly on `pluginsSection`/`pluginsHeader` (lines 628-719), swapping the tint and the row/menu contents:

```swift
    @ViewBuilder
    private var skillsSourcesSection: some View {
        Section {
            if sectionExpanded("skillsSources").wrappedValue {
                if skillsSources.isEmpty {
                    emptyRow("No skills sources registered yet.", icon: "books.vertical")
                } else {
                    ForEach(skillsSources) { s in
                        SkillsSourceRow(source: s) { enabled in
                            Task { await toggleSource(s.id, enabled: enabled) }
                        }
                        .tag(ShellState.LibrarySelection.skillsSource(s.id))
                        .contextMenu {
                            if !s.builtin {
                                Button(role: .destructive) {
                                    Task { await removeSource(s.id) }
                                } label: { Label("Remove", systemImage: "trash") }
                            }
                        }
                    }
                }
            }
        } header: {
            skillsSourcesHeader
        }
    }

    @ViewBuilder
    private var skillsSourcesHeader: some View {
        unifiedSectionHeader(
            id: "skillsSources", title: "Skills Sources", icon: "books.vertical",
            tint: theme.current.categoryAmber, count: skillsSources.count
        ) {
            Menu {
                Button {
                    showingSkillsSourceAddSheet = true
                } label: { Label("Add skills source…", systemImage: "plus.circle") }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.categoryAmber.opacity(0.6))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help("Add a skills source")
        }
        .sheet(isPresented: $showingSkillsSourceAddSheet) {
            SkillsSourceAddSheet(onSubmit: { url, path, ref, name in
                showingSkillsSourceAddSheet = false
                Task { await addSource(url: url, path: path, ref: ref, name: name) }
            }, onCancel: {
                showingSkillsSourceAddSheet = false
            })
        }
        .alert("Skills source", isPresented: Binding(
            get: { skillsSourceMessage != nil },
            set: { if !$0 { skillsSourceMessage = nil } }
        )) {
            Button("OK") { skillsSourceMessage = nil }
        } message: {
            Text(skillsSourceMessage ?? "")
        }
    }
```

- [ ] **Step 5: Write the actions**

Modeled on `loadPlugins`/`refreshPlugins`/`uninstall` (lines 723-800):

```swift
    /// Load registered skills sources for the Library section. Errors are
    /// swallowed — the section stays empty on failure, matching `loadPlugins`.
    private func loadSkillsSources() async {
        skillsSources = (try? await api.listSkillsSources()) ?? []
    }

    private func refreshSkillsSources() async {
        skillsSources = (try? await api.listSkillsSources()) ?? []
    }

    private func toggleSource(_ id: String, enabled: Bool) async {
        do {
            _ = try await api.toggleSkillsSource(id: id, enabled: enabled)
            await refreshSkillsSources()
        } catch {
            skillsSourceMessage = error.localizedDescription
        }
    }

    private func addSource(url: String?, path: String?, ref: String?, name: String?) async {
        do {
            let added = try await api.addSkillsSource(url: url, path: path, ref: ref, name: name)
            skillsSourceMessage = "Added \(added.name)."
            await refreshSkillsSources()
        } catch {
            skillsSourceMessage = error.localizedDescription
        }
    }

    private func removeSource(_ id: String) async {
        do {
            try await api.removeSkillsSource(id: id)
            if case .skillsSource(let sel) = shell.librarySelection, sel == id {
                shell.librarySelection = nil
            }
            await refreshSkillsSources()
        } catch {
            skillsSourceMessage = error.localizedDescription
        }
    }
```

- [ ] **Step 6: Wire `LibraryDetailView`'s call site (completes Task 3 Step 4)**

Update the `LibraryDetailView(...)` construction found in Task 3 Step 4 to pass:

```swift
LibraryDetailView(api: api, onSkillsSourcesChanged: { Task { await refreshSkillsSources() } })
```

- [ ] **Step 7: Build**

```bash
cd /Users/dinsmallade/llm-ide/mac && swift build 2>&1 | tail -20
```
Expected: `Build complete!`

- [ ] **Step 8: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift
git commit -m "feat(mac): Skills Sources sidebar section"
```

---

### Task 6: Chat "/" menu — source labels

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+AgentMeta.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeCompletion/CompletionController.swift`

**Interfaces:**
- Produces: `SkillLibraryEntry.sourceId: String`, `SkillLibraryEntry.sourceName: String` (both `decodeIfPresent` with `"builtin"`/`""` fallbacks respectively, so an older server response — pre this feature — still decodes; mirrors `PluginInfo.subagents`'s exact back-compat pattern).

- [ ] **Step 1: Extend the DTO**

In `LlmIdeAPIClient+AgentMeta.swift`, replace the `SkillLibraryEntry` struct (lines 32-38):

```swift
    struct SkillLibraryEntry: Decodable, Identifiable, Equatable {
        let id: String          // "<family>/<dir>"
        let family: String      // "skills" | "runtime"
        let name: String
        let description: String
        let path: String        // absolute SKILL.md path (attached as context on select)
        let sourceId: String
        let sourceName: String

        enum CodingKeys: String, CodingKey {
            case id, family, name, description, path, sourceId, sourceName
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id          = try c.decode(String.self, forKey: .id)
            self.family      = try c.decode(String.self, forKey: .family)
            self.name        = try c.decode(String.self, forKey: .name)
            self.description = try c.decode(String.self, forKey: .description)
            self.path        = try c.decode(String.self, forKey: .path)
            self.sourceId    = try c.decodeIfPresent(String.self, forKey: .sourceId) ?? "builtin"
            self.sourceName  = try c.decodeIfPresent(String.self, forKey: .sourceName) ?? ""
        }
    }
```

- [ ] **Step 2: Surface it in the "/" menu**

In `CompletionController.swift`, update the `libraryItems` mapping (line 109-113):

```swift
        libraryItems = (library ?? []).map { s in
            let detail = s.sourceName.isEmpty ? s.description : "\(s.sourceName) · \(s.description)"
            return Item(id: "lib:\(s.id)", kind: .librarySkill,
                 label: s.name, detail: detail,
                 insert: nil, fileURL: nil, skillId: s.id)
        }
```

(Dropped the `\(s.family) ·` prefix that was there before — `family` is always `skills`/`runtime`, low information; `sourceName` — which repo it came from — is the more useful thing to show now that multiple sources exist. `family` stays on the DTO for anything that still keys off it elsewhere; check with `grep -rn "\.family" mac/Sources/LlmIdeMac` before removing the field itself — do not remove `family` from the struct, only from this one display string.)

- [ ] **Step 3: Build + run the completion-controller tests**

```bash
cd /Users/dinsmallade/llm-ide/mac
swift build 2>&1 | tail -20
grep -rl "CompletionController" Tests/LlmIdeMacTests | xargs -I{} basename {} .swift
```
Run whatever test file that last command names (if any) with `swift test --filter <name>`. Expected: clean build; if a CompletionController test exists and asserts on the old `detail` string format, update its expected string to match the new `sourceName · description` shape — that is an intentional, expected diff, not a regression.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+AgentMeta.swift mac/Sources/LlmIdeMac/Views/CodeCompletion/CompletionController.swift
git commit -m "feat(mac): label chat / menu discovery skills with their source"
```

---

### Task 7: Full verification + report

**Files:** none modified.

- [ ] **Step 1: Full build + full test suite**

```bash
cd /Users/dinsmallade/llm-ide/mac
swift build 2>&1 | tail -20
swift test 2>&1 | tail -40
```
Expected: `Build complete!`; all tests pass (baseline before this plan: 648 — see `main-pre-existing-failing-tests` memory; expect baseline + the new `SkillsSourceDTOTests` cases, 0 failures).

- [ ] **Step 2: Manual smoke — cannot fully substitute for running the GUI**

This environment cannot click through SwiftUI (per the `running-mac-app-for-observation` memory: GUI clicks need Accessibility permission this sandbox doesn't have). Do what's checkable without that:

1. Confirm the extension server is up (`curl -s http://127.0.0.1:3456/health | head -c 200`) and reports `apiVersion >= 26`.
2. Build the actual `.app` (`cd mac && ./build_app.sh` or the project's documented equivalent) and open it once by hand — even without automating clicks, a launch-and-look at the Library sidebar (does "Skills Sources" render, does the builtin row show up, does the toggle flip) is worth doing if you have a human at the keyboard; state plainly in the final report whether this step was actually performed or skipped.
3. If GUI verification is skipped, say so explicitly in the report — do not claim the feature "works end-to-end" on build-and-unit-test success alone; that only proves it compiles and the DTOs decode.

- [ ] **Step 3: Update the design doc's status line**

In `docs/superpowers/specs/2026-08-11-skills-sources-design.md` line 4, change:
```
- **Status:** Design (pending implementation plan)
```
to:
```
- **Status:** Implemented (server: `docs/superpowers/plans/2026-08-11-skills-sources-server.md`; Mac: `docs/superpowers/plans/2026-08-12-skills-sources-mac.md`)
```

- [ ] **Step 4: Report the result honestly**

Report: files changed, whether `swift build`/`swift test` are clean, whether the GUI was actually exercised by a human or only compiled, and the diff between "committed" and "manually verified in the running app" — keep those two claims visibly separate.

---

## Self-Review (run after writing)

- **Spec coverage:** design's Data model → Task 1 DTOs; HTTP surface table → Task 1 methods; Mac UI bullet list (API client file, Skills Sources sub-section, row fields, Add sheet, chat-menu labels) → Tasks 1, 3, 4, 5, 6 respectively; Safety (discovery-only, no client git clone, URL hardening delegated to server) → Global Constraints + Task 4; "builtin shows Install instead of Remove" → Task 3 `SkillsSourceDetailView.actionsRow`. ✓
- **No placeholders:** every code block is complete, real Swift against verified exact server response shapes (re-derived from the live smoke test run during the server plan, not guessed). ✓
- **Type/interface consistency:** `SkillsSourceInfo`/`SkillsSourceSummary` field names match across Task 1 (client) and every consuming view in Tasks 3/5; `LibrarySelection.skillsSource(String)` (Task 2) is the exact type used in Tasks 3 and 5's `.tag(...)`. ✓
- **Deviation from the design doc, called out explicitly:** the design doc says the row shows "Update" for all sources including a not-yet-installed local/git source; this plan's `SkillsSourceDetailView.actionsRow` instead labels that button "Install" only for `s.builtin && !s.installed`, and *disables* Update for a non-builtin source whose directory is missing (`!s.builtin && !s.installed`) — because `git fetch`/`checkout` and the local-refresh path both need the directory to already exist, so "Update" can't actually revive a missing local/git source; the fix there is Remove + re-add, which the button copy should not imply "Update" can do. Implemented this way, not the looser draft in the code block above.

## Implementation notes (post-execution)

Executed 2026-08-12, same session as the plan. Two departures from the plan-as-written above, both simplifications:

- **Task 3 Step 3/4 and Task 5 Step 6 (the `onChanged` closure threading through `LibraryDetailView` into `AppShell.swift`) were dropped entirely.** Investigating the actual precedent first: `PluginDetailView` toggling a plugin's `enabled` state does **not** push a refresh back to `LibraryView.plugins` either — the sidebar list only catches up on the next full Library reload. Since that staleness is already tolerated for plugins, `SkillsSourceDetailView` follows the identical precedent (no `onChanged` callback, no `LibraryDetailView` signature change, no `AppShell.swift` touch) rather than introducing a new cross-view sync mechanism the codebase doesn't otherwise use. `LibraryDetailView` only gained the new `case .skillsSource(let id): SkillsSourceDetailView(api: api, sourceId: id)` branch — no new init parameter.
- **Task 1's decode test uses `XCTest` + `@testable import LlmIdeMacLib`**, not the swift-testing `@Test`/`#expect` shape speculatively sketched in the original Task 1 Step 2 block. Confirmed by reading `AgentProgressLabelTests.swift` before writing the real file — this repo's `mac/Tests/` suite is XCTest-based and the library target name in `Package.swift` is `LlmIdeMacLib`, not `LlmIdeMac`. The plan doc's Task 1 code block above has been corrected in place to match what was actually written and passes.

Result: `swift build` clean, `swift test` 650/650 passing (648 baseline + 2 new `SkillsSourceDTOTests`), across all 7 tasks. GUI was not clicked through by a human in this session — see Task 7 Step 2's honesty requirement; only build + unit-test verification happened, plus a live `curl /health` confirming the server side (`apiVersion: 26`) that the client codes against is still what's actually running.
