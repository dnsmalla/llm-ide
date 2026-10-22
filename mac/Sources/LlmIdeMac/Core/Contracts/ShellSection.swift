import Foundation

/// The app's top-level sections — one per toolbar/sidebar entry.
///
/// Lives in Core (not nested in `ShellState`) because Core code has to name a
/// section without naming Shell: the "/" slash-command catalog maps commands
/// to sections, `AppConfig` sanitizes the persisted hidden/home sections, and
/// `RegressionRunner` links its activity entry to the Loop section. Core is a
/// leaf, so the enum moved here and Shell keeps `ShellState.Section` as a
/// typealias for its existing call sites.
///
/// Only members that are pure data belong here. Anything that needs a Shell
/// or Feature type (`backingFeature` → `AppFeature`, `resolveHome` → the
/// compiled-feature set) or SwiftUI (`tint(_:)` → `Theme`/`Color`) is an
/// `extension ShellSection` in `Shell/ShellState.swift`.
///
/// Raw values are persisted (`hiddenSidebarSections`, `homeSection` in
/// UserDefaults) and sent as activity links, so renaming a case is a data
/// migration, not a refactor.
enum ShellSection: String, Hashable, CaseIterable {
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
    static let userHideable: [ShellSection] = [
        .explorer, .search, .conflicts, .sourceControl, .issues, .gantt, .visual,
        .docGen, .autoCode, .codeGraph, .loopEngine
    ]

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
