import SwiftUI

struct SettingsView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    var body: some View {
        // ScrollViewReader so Library's "Open in Settings" deep-link can
        // jump to a specific card. Anchor id matches the string posted with
        // `.scrollSettingsToCard` ("connections" today). Plugin install/
        // browse lives in Library → Plugins.
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    // App-wide settings — apply regardless of which project
                    // (if any) is open.
                    Group {
                        Text("App")
                            .font(Typography.title)
                            .foregroundStyle(theme.current.textMuted)
                        FeatureProfileSettingsSection()
                        BackendSettingsSection()
                        ConnectionsSettingsSection(api: api).id("connections")
                        UpdatesSettingsSection()
                        if let mobile = FeatureCatalog.mobileControlSettingsSection() {
                            mobile
                        }
                        PreferencesSettingsSection(api: api)
                        // App-scoped, not project-scoped: an "Always Allow"
                        // grant is per-(user, tool) and outlives any project,
                        // so it must be revocable from the Welcome shell too
                        // (which renders App settings only).
                        ToolApprovalsSettingsSection(api: api)
                        // Nested, not appended: `ViewBuilder` takes at most 10
                        // children per block and this Group had reached exactly
                        // 10, so the next card added here would have failed to
                        // type-check with a message that names neither the
                        // limit nor this line. Add new App cards inside a
                        // nested Group like this one.
                        Group {
                            ProvidersSettingsSection(api: api)
                            CustomProvidersSection(api: api)
                        }
                    }

                    // Project-scoped settings — only visible when a project is
                    // active. Without a project the Welcome shell shows App
                    // settings only (via welcomeShell + standalone AppEnvironment).
                    if let activeId = projectStore.activeProject?.bundle.id {
                        VStack(alignment: .leading, spacing: Spacing.lg) {
                            Group {
                                Divider().padding(.vertical, Spacing.md)
                                Text("Project")
                                    .font(Typography.title)
                                    .foregroundStyle(theme.current.textMuted)
                                PathsSettingsSection()
                                RepoSettingsSection(api: api)
                                // Memory listing stays here (not on a feature
                                // page) because it has no other home. The
                                // graph-specific card (auto-update cadence,
                                // upload-truncation banner) is nil when Code
                                // Graph is compiled out — dropping it from
                                // Settings would orphan the only UI for
                                // GraphAutoUpdater's interval when it IS built.
                                MemorySettingsSection()
                                if let graphSettings = FeatureCatalog.graphSettingsSection() {
                                    graphSettings
                                }
                            }
                        }
                        .id(activeId)
                    }
                }
                .padding(Spacing.lg)
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .background(theme.current.body)
            .onReceive(NotificationCenter.default.publisher(for: .scrollSettingsToCard)) { note in
                guard let anchor = note.object as? String else { return }
                // Defer one runloop so the section re-mount (from a
                // project switch or first navigation in) finishes
                // before we scroll. Without this, the anchor id may
                // not yet exist in the layout tree.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(50))
                    withAnimation(.easeOut(duration: 0.25)) {
                        proxy.scrollTo(anchor, anchor: .top)
                    }
                }
            }
        }
    }
}
