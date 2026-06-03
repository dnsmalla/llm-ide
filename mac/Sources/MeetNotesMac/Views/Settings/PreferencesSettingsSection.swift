import SwiftUI

struct PreferencesSettingsSection: View {
    let api: MeetNotesAPIClient
    @EnvironmentObject var theme: ThemeStore

    @State private var language: String = ""
    @State private var prefsBilingual: Bool = false
    @State private var prefsLoaded: Bool = false
    @State private var prefsBusy: Bool = false
    @State private var prefsStatus: String?

    var body: some View {
        SettingsSectionCard(icon: "globe", title: "Preferences (synced)") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
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
                SettingsHint("Language drives every LLM output (notes, plans, agent questions) and applies on both this app and the Chrome extension once signed in.")
            }
        }
        .task { await loadPrefs() }
    }

    private func loadPrefs() async {
        do {
            let p = try await api.getUserPrefs()
            language = p.language ?? "en"
            prefsBilingual = p.bilingual ?? false
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
            _ = try await api.setUserPrefs(.init(language: language, bilingual: prefsBilingual))
            prefsStatus = "✓ Saved."
        } catch {
            prefsStatus = "Failed: \(error.localizedDescription)"
        }
    }
}
