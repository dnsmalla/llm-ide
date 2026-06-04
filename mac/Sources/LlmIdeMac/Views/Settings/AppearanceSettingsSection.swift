import SwiftUI

struct AppearanceSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    var body: some View {
        SettingsSectionCard(icon: "paintbrush", title: "Appearance") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
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
                SettingsHint("Visual style. Changes apply immediately and persist across launches.")
            }
        }
    }
}
