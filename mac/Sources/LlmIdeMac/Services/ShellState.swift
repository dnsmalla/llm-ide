import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class ShellState {
    enum Section: String, Hashable, CaseIterable {
        case library, live, explorer, search, conflicts, sourceControl, issues, gantt, visual, docGen, autoCode, codeGraph, loopEngine, settings

        /// User-friendly label — single source of truth so the sidebar
        /// row, the settings toggle and any future menu item agree.
        var label: String {
            switch self {
            case .library:   return "Library"
            case .live:      return "Live"
            case .explorer:  return "Explorer"
            case .search:    return "Search"
            case .conflicts: return "Review Conflicts"
            case .sourceControl: return "Source Control"
            case .issues:    return "Issues"
            case .gantt:     return "Gantt"
            case .visual:    return "Visual"
            case .docGen:    return "Doc Gen"
            case .autoCode:  return "Auto Tasks"
            case .codeGraph: return "Code Graph"
            case .loopEngine: return "Loop"
            case .settings:  return "Settings"
            }
        }

        var systemImage: String {
            switch self {
            case .library:   return "books.vertical"
            case .live:      return "waveform"
            case .explorer:  return "folder"
            case .search:    return "magnifyingglass"
            case .conflicts: return "exclamationmark.triangle"
            case .sourceControl: return "arrow.triangle.branch"
            case .issues:    return "checklist"
            case .gantt:     return "chart.bar.doc.horizontal"
            case .visual:    return "photo.on.rectangle.angled"
            case .docGen:    return "wand.and.stars"
            case .autoCode:  return "arrow.triangle.2.circlepath.circle"
            case .codeGraph: return "point.3.connected.trianglepath.dotted"
            case .loopEngine: return "repeat.circle"
            case .settings:  return "gearshape"
            }
        }

        /// Sections the user is allowed to hide from the top bar. Library is the
        /// landing fallback when hidden sections are selected; Settings is the
        /// only way back if everything else is hidden — neither can be
        /// turned off. `.live` is already conditional on capture state
        /// so it doesn't appear here either.
        ///
        /// `.loopEngine` WAS excluded, on the grounds that it is the single
        /// permanent home for regression. Hiding it no longer strands that: the
        /// `.openSection` handler sets the section directly with no visibility
        /// check, so every route into the Loop still works while its toolbar button
        /// is hidden — Settings → Loop's "Open Loop" button, the menu-bar
        /// open-fault and last-regression rows, and the chat loop command. Hiding
        /// removes the button, not the page.
        static let userHideable: [Section] = [
            .explorer, .search, .conflicts, .sourceControl, .issues, .gantt, .visual,
            .docGen, .autoCode, .codeGraph, .loopEngine
        ]

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
        static func resolveHome(_ rawValue: String, hidden: Set<String>, compiled: Set<AppFeature>) -> Section {
            guard let chosen = Section(rawValue: rawValue),
                  !hidden.contains(chosen.rawValue) else { return .library }
            if let feature = chosen.backingFeature, !compiled.contains(feature) {
                return .library
            }
            return chosen
        }
    }

    enum LibrarySelection: Hashable {
        case meeting(String)
        case file(URL)
        /// A plugin row. String is the plugin's `name` field.
        case plugin(String)
        /// An LLM-source row. String is the source's `id` field.
        case llmSource(String)
        /// An MCP-plugin row. String is the plugin's `id` field.
        case mcpPlugin(String)
        /// A connector row. String is the catalog entry's `id` field
        /// (e.g. "box", "slack", "gdrive").
        case connector(String)
    }

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
}

extension ShellState.Section {
    /// The excludable `AppFeature` that gates this section, if any. Single
    /// source of truth for "which build-time/runtime feature does this
    /// section need" — AppShell's toolbar filter, its feature-change
    /// reconciliation, and the Settings "Home opens" picker all read this
    /// instead of keeping three copies of the same switch in sync.
    var backingFeature: AppFeature? {
        switch self {
        case .codeGraph: return .codeGraph3D
        case .autoCode: return .autoTasks
        case .issues, .gantt: return .ganttIssues
        case .docGen: return .docGen
        case .explorer, .sourceControl, .search: return .fileExplorer
        default: return nil
        }
    }

    /// Map a deep-link tab name (as published by `DeepLinkRouter`) to a
    /// section, without modifying the router.  Returns `nil` for
    /// unknown tabs so callers can fall back to the default landing.
    init?(deepLinkTabName name: String) {
        switch name {
        case "transcript": self = .live
        case "history":    self = .library
        case "visual":     self = .visual
        case "settings":   self = .settings
        default:           return nil
        }
    }
}

// Theme-aware tint for the section's SF Symbol. Lives on the enum so
// the sidebar row and the Sidebar settings card can never drift.
extension ShellState.Section {
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
        }
    }
}
