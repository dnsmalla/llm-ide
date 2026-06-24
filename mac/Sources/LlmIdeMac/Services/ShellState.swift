import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class ShellState {
    enum Section: String, Hashable, CaseIterable {
        case library, live, explorer, search, plans, conflicts, sourceControl, issues, gantt, visual, docGen, autoCode, codeGraph, regression, settings

        /// User-friendly label — single source of truth so the sidebar
        /// row, the settings toggle and any future menu item agree.
        var label: String {
            switch self {
            case .library:   return "Library"
            case .live:      return "Live"
            case .explorer:  return "Explorer"
            case .search:    return "Search"
            case .plans:     return "Review Doc"
            case .conflicts: return "Review Conflicts"
            case .sourceControl: return "Source Control"
            case .issues:    return "Issues"
            case .gantt:     return "Gantt"
            case .visual:    return "Visual"
            case .docGen:    return "Doc Gen"
            case .autoCode:  return "Auto Tasks"
            case .codeGraph: return "Code Graph"
            case .regression: return "Regression"
            case .settings:  return "Settings"
            }
        }

        var systemImage: String {
            switch self {
            case .library:   return "books.vertical"
            case .live:      return "waveform"
            case .explorer:  return "folder"
            case .search:    return "magnifyingglass"
            case .plans:     return "doc.text.magnifyingglass"
            case .conflicts: return "exclamationmark.triangle"
            case .sourceControl: return "arrow.triangle.branch"
            case .issues:    return "checklist"
            case .gantt:     return "chart.bar.doc.horizontal"
            case .visual:    return "photo.on.rectangle.angled"
            case .docGen:    return "wand.and.stars"
            case .autoCode:  return "arrow.triangle.2.circlepath.circle"
            case .codeGraph: return "point.3.connected.trianglepath.dotted"
            case .regression: return "arrow.uturn.backward.circle"
            case .settings:  return "gearshape"
            }
        }

        /// Sections the user is allowed to hide. Library is the landing
        /// fallback when hidden sections are selected; Settings is the
        /// only way back if everything else is hidden — neither can be
        /// turned off. `.live` is already conditional on capture state
        /// so it doesn't appear here either.
        static let userHideable: [Section] = [
            .explorer, .search, .plans, .conflicts, .sourceControl, .issues, .gantt, .visual, .docGen, .autoCode, .codeGraph, .regression
        ]
    }

    enum LibrarySelection: Hashable {
        case meeting(String)
        case file(URL)
        /// A persona/agent row. String is the persona slug. We only
        /// have one persona today ("default") but the slug keeps the
        /// door open for multi-persona without churning the enum.
        case agent(String)
        /// A plugin row. String is the plugin's `name` field.
        case plugin(String)
        /// A built-in (non-deletable) agent row — "meeting-assistant"
        /// or "ask-agent". These are always present and locked.
        case builtinAgent(String)
        /// A skill row (built-in or plugin-contributed). String is the
        /// skill `name` from its frontmatter.
        case skill(String)
    }

    var section: Section = .library
    /// Whether the Explorer's chat panel is open. Lives here (app-session
    /// scope) rather than as ExplorerView @State so it survives navigating
    /// away and back — ExplorerView is torn down on a section switch, which
    /// would otherwise reset it. A fresh ShellState per app launch resets it.
    var exploreChatVisible: Bool = false
    var librarySelection: LibrarySelection?
    var libraryFilter: String = ""

    var selectedMeetingId: String? {
        get { if case .meeting(let id) = librarySelection { return id }; return nil }
        set { librarySelection = newValue.map { .meeting($0) } }
    }

    /// Set by the Library list's "Re-summarize" context action. The meeting
    /// detail consumes it once its view model has loaded for this id (and
    /// clears it), so the action works even when that meeting's detail pane
    /// isn't open yet — surviving the async mount a notification can't.
    var pendingResummarizeMeetingId: String?

    var selectedFileURL: URL? {
        if case .file(let url) = librarySelection { return url }
        return nil
    }
}

extension ShellState.Section {
    /// Map a deep-link tab name (as published by `DeepLinkRouter`) to a
    /// section, without modifying the router.  Returns `nil` for
    /// unknown tabs so callers can fall back to the default landing.
    init?(deepLinkTabName name: String) {
        switch name {
        case "transcript": self = .live
        case "history":    self = .library
        case "visual":     self = .visual
        case "plan":       self = .plans
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
        case .plans:      return Color(red: 0.30, green: 0.65, blue: 0.55) // teal-green
        case .conflicts:  return Color(red: 0.50, green: 0.72, blue: 0.30) // lime-green
        case .sourceControl: return Color(red: 0.30, green: 0.70, blue: 0.45) // green
        case .autoCode:   return .teal
        case .codeGraph:  return Color(red: 0.15, green: 0.68, blue: 0.65) // cyan-green
        case .regression: return Color(red: 0.40, green: 0.75, blue: 0.50) // mint-green

        // ── Data (purple family) ─────────────────────────
        case .issues:     return .purple
        case .gantt:      return .indigo
        case .visual:     return Color(red: 0.62, green: 0.40, blue: 0.90) // violet

        // ── Neutral ──────────────────────────────────────
        case .settings:   return .gray
        }
    }
}
