import SwiftUI

/// Settings → Optional components. Large runtime pieces the app does not ship
/// and installs only on request. Today that is mermaid (diagram rendering in
/// markdown previews); the markdown previews offer the same install through
/// `MermaidInstallBanner` when a document actually needs it.
///
/// Settings' own card, not a registry slot: everything it touches lives in
/// Core (`MermaidRuntime`), so no feature or Shell type is named here.
struct OptionalComponentsSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @ObservedObject private var runtime = MermaidRuntime.shared

    var body: some View {
        SettingsSectionCard(icon: "puzzlepiece.extension", title: "Optional components") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Downloaded only when you ask, so the app stays small and works offline. "
                             + "Each download is checked against a pinned checksum before it is used.")
                mermaidRow
            }
        }
    }

    private var mermaidRow: some View {
        HStack(alignment: .center, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Diagrams (mermaid \(Mermaid.version))")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Text(statusText)
                    .font(Typography.caption)
                    .foregroundStyle(isFailed ? Color.red : theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if runtime.isInstalled {
                Button("Remove", role: .destructive) { runtime.remove() }
                    .controlSize(.small)
                    .help("Delete the downloaded copy. Diagrams show as code until it is installed again.")
            } else {
                MermaidInstallControl(runtime: runtime)
            }
        }
    }

    private var statusText: String {
        switch runtime.state {
        case .installed:
            return "Installed. ```mermaid blocks in markdown previews render as diagrams."
        case .notInstalled:
            return "Not installed (\(MermaidInstallControl.sizeLabel)). ```mermaid blocks show as code."
        case .downloading(let fraction):
            return "Downloading… \(Int((fraction * 100).rounded()))%"
        case .failed(let message):
            return message
        }
    }

    private var isFailed: Bool {
        if case .failed = runtime.state { return true }
        return false
    }
}
