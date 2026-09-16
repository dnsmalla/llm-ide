import SwiftUI

/// GitLab + GitHub credentials and saved repos in one tabbed card.
struct RepoSettingsSection: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    private enum ProviderTab: String, CaseIterable, Identifiable {
        case gitlab, github
        var id: String { rawValue }
        var label: String {
            switch self {
            case .gitlab: return "GitLab"
            case .github: return "GitHub"
            }
        }
    }

    @State private var tab: ProviderTab = .gitlab

    var body: some View {
        SettingsSectionCard(icon: "arrow.triangle.branch", title: "Repositories") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Picker("Provider", selection: $tab) {
                    ForEach(ProviderTab.allCases) { provider in
                        Text(provider.label).tag(provider)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                switch tab {
                case .gitlab:
                    GitLabSettingsSection(embedded: true)
                case .github:
                    GitHubSettingsSection(embedded: true, api: api)
                }
            }
        }
        .onAppear {
            tab = defaultTab
        }
    }

    /// Open on whichever provider already has a token, preferring the configured primary.
    private var defaultTab: ProviderTab {
        if config.preferredRepoProvider == .github { return .github }
        if config.preferredRepoProvider == .gitlab { return .gitlab }
        if !config.gitHubToken.isEmpty && config.gitLabToken.isEmpty { return .github }
        return .gitlab
    }
}
