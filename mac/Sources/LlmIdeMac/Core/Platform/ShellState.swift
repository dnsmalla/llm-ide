import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class ShellState {
    /// Compatibility name for the Core-owned `ShellSection`. The enum moved to
    /// `Core/Contracts/ShellSection.swift` so Core code could name a section
    /// while `ShellState` still lived in Shell; this alias keeps every
    /// existing `ShellState.Section` call site compiling unchanged. New code
    /// should prefer `ShellSection`.
    typealias Section = ShellSection

    /// Compatibility name for the Core-owned `LibrarySelection` (moved to
    /// `Core/Contracts/LibrarySelection.swift` for the same reason as
    /// `Section`). New code should prefer `LibrarySelection`.
    typealias LibrarySelection = LlmIdeMacLib.LibrarySelection

    /// Pre-seed value only — `ShellState()` is created as `@State` before any
    /// environment (config, registry) is reachable, so it can't resolve the
    /// real landing at init time. `AppShell` overwrites this with
    /// `Section.resolveHome(...)` right after a project becomes active (see
    /// `existingShellContent`'s `onAppear`), so this default never actually
    /// renders once a project is open.
    var section: Section = .explorer
    var librarySelection: LibrarySelection?

    var selectedMeetingId: String? {
        get { if case .meeting(let id) = librarySelection { return id }; return nil }
        set { librarySelection = newValue.map { .meeting($0) } }
    }

    /// Bumped whenever a Library DETAIL pane mutates something the sidebar
    /// lists (MCP consent/enable/remove, and anything else that changes a row's
    /// state). The sidebar and the detail column are siblings under AppShell —
    /// neither can call the other — so the list watches this token and reloads.
    /// Monotonic on purpose: a toggled-then-toggled-back value must still read
    /// as "changed", or the second mutation would show stale.
    private(set) var libraryDirtyToken = 0

    func markLibraryDirty() { libraryDirtyToken += 1 }

    /// Set by the Library list's "Re-summarize" context action. The meeting
    /// detail consumes it once its view model has loaded for this id (and
    /// clears it), so the action works even when that meeting's detail pane
    /// isn't open yet — surviving the async mount a notification can't.
    var pendingResummarizeMeetingId: String?

    /// Set by the Explorer's "Find in Folder" action: the `SearchView` "files
    /// to include" glob to apply on its next appearance.
    ///
    /// A property rather than a `Notification`, for the same reason
    /// `pendingResummarizeMeetingId` is one: switching sections is what MOUNTS
    /// `SearchView`, so a notification posted at switch time would be
    /// delivered before any observer existed.
    var pendingSearchInclude: String?

    /// Read and clear in one step, so a handoff applies exactly once and does
    /// not re-narrow the search every time the user returns to the panel.
    ///
    /// Note `""` is a REAL value here — it is what
    /// `ExplorerPaths.includeGlob` returns for the root itself, meaning
    /// "search everything" — so absence is `nil` and only `nil`.
    func takePendingSearchInclude() -> String? {
        defer { pendingSearchInclude = nil }
        return pendingSearchInclude
    }
}

// Feature-runtime members of `ShellSection`: these name `AppFeature`
// (Core/FeatureToggles), and are kept out of `Core/Contracts/ShellSection.swift`
// so that contract file stays Foundation-only plain data.
extension ShellSection {
    /// The excludable `AppFeature` that gates this section, if any. Single
    /// source of truth for "which build-time/runtime feature does this
    /// section need" — AppShell's toolbar filter, its feature-change
    /// reconciliation, and the Settings "Home opens" picker all read this
    /// instead of keeping three copies of the same switch in sync.
    var backingFeature: AppFeature? {
        switch self {
        case .codeGraph: return .codeGraph3D
        case .autoCode, .loopEngine: return .autoTasks
        case .issues, .gantt: return .ganttIssues
        case .docGen, .visual: return .docGen
        case .explorer, .sourceControl, .search: return .fileExplorer
        default: return nil
        }
    }

    /// Resolve the effective Home landing: the chosen section if it's a real
    /// case, not currently hidden, and its `backingFeature` (if any) is
    /// compiled into this build, else `.library` (always visible — Library
    /// isn't in `userHideable` and carries no `backingFeature`). Pure so the
    /// shell and tests share one definition of "where Home goes." `compiled`
    /// is a parameter rather than a `FeatureRegistry.shared` read so this
    /// stays trivially testable — callers pass
    /// `FeatureRegistry.shared.compiledFeatures`. Without this check, a
    /// lite build whose home section names a compiled-out feature (e.g.
    /// `.explorer` with Explorer excluded) would land on the "not
    /// installed" placeholder instead of a usable page.
    static func resolveHome(_ rawValue: String, hidden: Set<String>, compiled: Set<AppFeature>) -> ShellSection {
        guard let chosen = ShellSection(rawValue: rawValue),
              !hidden.contains(chosen.rawValue) else { return .library }
        if let feature = chosen.backingFeature, !compiled.contains(feature) {
            return .library
        }
        return chosen
    }
}

// Theme-aware tint for the section's SF Symbol. Lives on the enum so
// the sidebar row and the Sidebar settings card can never drift. Kept out of
// `Core/Contracts/ShellSection.swift` so that file stays Foundation-only plain
// data; this is presentation for the shell's chrome.
extension ShellSection {
    func tint(_ theme: Theme) -> Color {
        switch self {
        // ── Notes (blue family) ──────────────────────────
        case .library:    return .blue
        case .live:       return Color(red: 0.20, green: 0.45, blue: 0.95) // vivid blue; red dot overlays when recording
        case .docGen:     return Color(red: 0.35, green: 0.55, blue: 0.95) // soft blue

        // ── Code (green family) ──────────────────────────
        case .explorer:   return Color(red: 0.25, green: 0.68, blue: 0.40) // forest green
        case .search:     return Color(red: 0.35, green: 0.72, blue: 0.42) // green
        case .conflicts:  return Color(red: 0.50, green: 0.72, blue: 0.30) // lime-green
        case .sourceControl: return Color(red: 0.30, green: 0.70, blue: 0.45) // green
        case .autoCode:   return .teal
        case .codeGraph:  return Color(red: 0.15, green: 0.68, blue: 0.65) // cyan-green
        case .loopEngine: return Color(red: 0.35, green: 0.70, blue: 0.55) // mint-teal

        // ── Data (purple family) ─────────────────────────
        case .issues:     return .purple
        case .gantt:      return .indigo
        case .visual:     return Color(red: 0.62, green: 0.40, blue: 0.90) // violet

        // ── Neutral ──────────────────────────────────────
        case .settings:   return .gray
        case .system:     return Color(red: 0.42, green: 0.50, blue: 0.92) // indigo-slate, Home landing
        }
    }
}
