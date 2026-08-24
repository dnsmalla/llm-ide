import SwiftUI

struct PreferencesSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @State private var language: String = ""
    @State private var prefsBilingual: Bool = false
    @State private var prefsNativePlugins: Bool = true
    @State private var prefsLoaded: Bool = false
    @State private var prefsBusy: Bool = false
    @State private var prefsStatus: String?

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

                Divider().padding(.vertical, Spacing.xs)

                Text("Preferences (synced)")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.textMuted)

                HStack(spacing: Spacing.md) {
                    Text("Language")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 110, alignment: .leading)
                    Picker("", selection: $language) {
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
                Toggle(isOn: $prefsBilingual) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Bilingual transcript display")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("Show captions + translations side by side. Off by default.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                .toggleStyle(.switch)
                .disabled(!prefsLoaded || prefsBusy)
                Toggle(isOn: $prefsNativePlugins) {
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
                    Button(prefsBusy ? "Saving…" : "Save") {
                        Task { await savePrefs() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!prefsLoaded || prefsBusy)
                    if let s = prefsStatus {
                        Text(s)
                            .font(Typography.caption)
                            .foregroundStyle(s.hasPrefix("✓") ? theme.current.text : theme.current.danger)
                    }
                }
                SettingsHint("Theme applies immediately on this Mac. Language drives every LLM output (notes, plans, agent questions) and applies on both this app and the Chrome extension once signed in.")
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
        } catch {
            prefsStatus = "Could not load: \(error.localizedDescription)"
        }
        prefsLoaded = true
    }

    private func savePrefs() async {
        prefsBusy = true
        prefsStatus = nil
        defer { prefsBusy = false }
        do {
            _ = try await api.setUserPrefs(.init(language: language,
                                                 bilingual: prefsBilingual,
                                                 nativePlugins: prefsNativePlugins))
            config.preferredLanguage = language
            prefsStatus = "✓ Saved."
        } catch {
            prefsStatus = "Failed: \(error.localizedDescription)"
        }
    }
}
