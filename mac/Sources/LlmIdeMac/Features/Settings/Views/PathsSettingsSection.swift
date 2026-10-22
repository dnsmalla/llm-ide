// Project folder layout — read-only tree of the active project's canonical
// folders. Shown from Settings → Paths and from Explorer → "Project folders"
// (ProjectPathsSheet) — both present the same ProjectPathsPanel content,
// which lives in Core/DesignSystem/ProjectPathsPanel.swift so neither
// feature has to name the other.

import SwiftUI

/// Settings-card wrapper around `ProjectPathsPanel`. Restored after the
/// Settings consolidation dropped it in favor of the Explorer-only sheet —
/// this view is looked for in Settings often enough to keep both entry
/// points rather than make it Explorer-only.
struct PathsSettingsSection: View {
    var body: some View {
        SettingsSectionCard(icon: "folder.badge.gearshape", title: "Paths") {
            ProjectPathsPanel()
        }
    }
}
