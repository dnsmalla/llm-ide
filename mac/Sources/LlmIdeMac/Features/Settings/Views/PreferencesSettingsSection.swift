import SwiftUI

struct PreferencesSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @State private var language: String = ""
    /// Round-tripped untouched: the server still stores it (the Chrome
    /// extension keeps its own toggle in chrome.storage), but no Mac surface
    /// reads it, so it is not shown here.
    @State private var prefsBilingual: Bool = false
    @State private var prefsNativePlugins: Bool = true
    @State private var prefsLoaded: Bool = false
    @State private var prefsBusy: Bool = false
    @State private var prefsStatus: String?
    /// Bumped per save so only the latest one clears `prefsBusy` / reports.
    @State private var saveGeneration = 0

    private static let offeredLanguages: Set<String> = ["en", "ja", "zh-CN", "ko", "es", "fr", "de"]

    var body: some View {
        SettingsSectionCard(icon: "globe", title: "General") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Appearance")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.textMuted)
                Picker("", selection: Binding(
                    get: { theme.current.id },
                    set: { id in
                        theme.apply(id: id)
                        config.themeID = id
                    }
                )) {
                    ForEach(Theme.all) { t in Text(t.name).tag(t.id) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                // Extra top padding so the uniform VStack spacing doesn't leave
                // this heading equidistant between the theme picker above and
                // its own toggle below — it must read as opening this group.
                Text("Menu bar")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.top, Spacing.xs)
                Toggle(isOn: $config.menuBarChatEnabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Show menu-bar chat icon")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("Shows or hides the chat bubble in the menu bar. Its popover's \"Quit \(L.App.name)\" button closes the whole app — use this to hide just the icon, and to bring it back without restarting.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .toggleStyle(.switch)

                Divider().padding(.vertical, Spacing.xs)

                Text("Preferences (synced)")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.textMuted)

                HStack(spacing: Spacing.md) {
                    Text("Language")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 110, alignment: .leading)
                    // Edits save on change: with an explicit Save button, leaving the
                    // pane silently dropped them while the controls looked instant.
                    Picker("", selection: Binding(
                        get: { language },
                        set: { newValue in
                            let previous = language
                            language = newValue
                            Task { await savePrefs(rollback: { language = previous }) }
                        }
                    )) {
                        // A server value outside the offered tags (e.g. zh-TW)
                        // would render the Picker blank — keep it selectable.
                        if !language.isEmpty, !Self.offeredLanguages.contains(language) {
                            Text(language).tag(language)
                        }
                        Text("English").tag("en")
                        Text("日本語").tag("ja")
                        Text("简体中文").tag("zh-CN")
                        Text("한국어").tag("ko")
                        Text("Español").tag("es")
                        Text("Français").tag("fr")
                        Text("Deutsch").tag("de")
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .disabled(!prefsLoaded || prefsBusy)
                }
                Toggle(isOn: Binding(
                    get: { prefsNativePlugins },
                    set: { newValue in
                        let previous = prefsNativePlugins
                        prefsNativePlugins = newValue
                        Task { await savePrefs(rollback: { prefsNativePlugins = previous }) }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Let plugins load natively")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("Claude-format plugins are loaded by the agent engine itself, so their skills, commands, agents and hooks work exactly as their author intended. Turn this off to fall back to LLM-IDE's own hook handling. Either way, a plugin's hooks only run once you trust them, and its MCP servers still need your consent.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .toggleStyle(.switch)
                .disabled(!prefsLoaded || prefsBusy)
                HStack {
                    if prefsBusy {
                        Text("Saving…")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    if !prefsLoaded, prefsStatus != nil {
                        Button("Retry") { Task { await loadPrefs() } }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    if let s = prefsStatus {
                        Text(s)
                            .font(Typography.caption)
                            .foregroundStyle(s.hasPrefix("✓") ? theme.current.text : theme.current.danger)
                    }
                }
                SettingsHint("Theme applies immediately on this Mac. Language and plugin changes save automatically. Language drives every LLM output (notes, plans, agent questions) and applies on both this app and the Chrome extension once signed in.")
            }
        }
        .task { await loadPrefs() }
    }

    private func loadPrefs() async {
        do {
            let p = try await api.getUserPrefs()
            language = p.language ?? "en"
            prefsBilingual = p.bilingual ?? false
            // Unset means on — mirror the server's default rather than
            // defaulting the switch off and silently turning it off on save.
            prefsNativePlugins = p.nativePlugins ?? true
            // Mirror locally for the synchronous consumers (ProjectScaffolder
            // stamps this into new projects' docs and can't await the server).
            config.preferredLanguage = language
            prefsStatus = nil
            prefsLoaded = true
        } catch {
            // Stay unloaded: Save was enabled after a failed load and sent
            // the placeholder defaults, overwriting the real server prefs.
            prefsStatus = "Could not load: \(error.localizedDescription)"
        }
    }

    /// `rollback` restores the control the user just changed if the save fails,
    /// so the UI never shows a value the server and `config` don't have.
    private func savePrefs(rollback: @escaping () -> Void) async {
        saveGeneration += 1
        let generation = saveGeneration
        prefsBusy = true
        prefsStatus = nil
        // WHY generation: two quick edits start two saves; the first to finish
        // must not clear the busy flag while the later one is still running.
        defer { if generation == saveGeneration { prefsBusy = false } }
        let sentLanguage = language
        do {
            _ = try await api.setUserPrefs(.init(language: sentLanguage,
                                                 bilingual: prefsBilingual,
                                                 nativePlugins: prefsNativePlugins))
            guard generation == saveGeneration else { return }
            config.preferredLanguage = sentLanguage
            prefsStatus = "✓ Saved."
        } catch {
            guard generation == saveGeneration else { return }
            rollback()
            prefsStatus = "Failed: \(error.localizedDescription) (change reverted)"
        }
    }
}
