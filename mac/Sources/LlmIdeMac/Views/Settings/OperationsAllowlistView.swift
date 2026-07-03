import SwiftUI

/// Per-provider checklist of allowed repo operations. An unchecked op is
/// skipped by automation and its manual button is disabled. Rendered at the
/// bottom of GitHubSettingsSection / GitLabSettingsSection.
struct OperationsAllowlistView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    let provider: RepoBackendKind

    private func binding(for op: RepoOperation) -> Binding<Bool> {
        Binding(
            get: { config.isAllowed(op, provider: provider) },
            set: { config.setAllowed(op, provider: provider, $0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("AUTOMATION & ACTIONS", size: 10, tracking: 1.2)
            Text("Unchecked operations are skipped automatically and disabled in the UI.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)

            ForEach(RepoOperation.groups, id: \.0) { group in
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.0.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(theme.current.textMuted)
                    ForEach(group.1, id: \.self) { op in
                        Toggle(op.label, isOn: binding(for: op))
                            .toggleStyle(.checkbox)
                            .font(Typography.caption)
                    }
                }
            }
        }
    }
}
