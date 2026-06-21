import SwiftUI

struct SettingsView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    var body: some View {
        // ScrollViewReader so Library's "Manage in Settings" deep-link
        // can jump to a specific card. Anchor id matches the string posted
        // with `.scrollSettingsToCard` ("plugins" today; agent moved
        // entirely to Library → Agents).
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    // App-wide settings — apply regardless of which project
                    // (if any) is open.
                    Group {
                        Text("App")
                            .font(Typography.title)
                            .foregroundStyle(theme.current.textMuted)
                        AccountSettingsSection()
                        RecordingSettingsSection(api: api)
                        ServerSettingsSection()
                        BackendSettingsSection()
                        ConnectionsSettingsSection(api: api).id("connections")
                        RemoteSSHSettingsSection().id("remote-ssh")
                        AppearanceSettingsSection()
                        SidebarVisibilitySection()
                        UpdatesSettingsSection()
                        AboutSettingsSection()
                    }

                    // Project-scoped settings — only visible when a project is
                    // active. Welcome screen suppresses Settings entry anyway,
                    // but defensive: if a user lands here via deep-link with
                    // no active project, they only see the App group.
                    if let activeId = projectStore.activeProject?.bundle.id {
                        // Single id-modified wrapper so all Project-scoped
                        // sections re-mount on project switch. Without this,
                        // @State that lives on SettingsView (prefsLanguage)
                        // bleeds across projects — A's language briefly
                        // shows in B's Preferences card on switch.
                        VStack(alignment: .leading, spacing: Spacing.lg) {
                            Group {
                                Divider().padding(.vertical, Spacing.md)
                                Text("Project")
                                    .font(Typography.title)
                                    .foregroundStyle(theme.current.textMuted)
                                PathsSettingsSection()
                                GitLabSettingsSection()
                                GitHubSettingsSection()
                                ProvidersSettingsSection(api: api)
                                PreferencesSettingsSection(api: api)
                            }
                            Group {
                                // AgentSettingsSection used to live here.
                                // Removed — agent CRUD now happens in
                                // Library → Agents detail view, since
                                // the agent runs server-side (and
                                // primarily off Chrome-extension capture)
                                // and "browse personas" already lives in
                                // Library.
                                AutoCodeSettingsSection()
                                PluginsSettingsSection(api: api).id("plugins")
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
