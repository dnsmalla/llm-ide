import SwiftUI

struct CLISettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    var body: some View {
        SettingsSectionCard(icon: "terminal", title: "CLI Tool") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Active AI CLI and default model used in Code & Doc Review chat.")

                VStack(spacing: 2) {
                    ForEach(AICliTool.selectable) { cli in
                        cliRow(cli)
                    }
                }
                .onAppear(perform: normalizeActiveCLI)

                Divider().background(theme.current.border)

                if let cli = AICliTool(rawValue: config.activeCLI) {
                    HStack(spacing: Spacing.md) {
                        Text("Default model")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.textMuted)
                            .frame(width: 130, alignment: .leading)
                        Picker("", selection: $config.defaultModelId) {
                            ForEach(cli.models) { model in
                                Text(model.displayName).tag(model.id)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
            }
        }
    }

    /// If a previously-persisted tool is no longer selectable (e.g. the
    /// user had Cursor/Gemini selected before they were hidden), fall
    /// back to Claude so the picker has a valid active row.
    private func normalizeActiveCLI() {
        guard !AICliTool.selectable.contains(where: { $0.rawValue == config.activeCLI }) else { return }
        config.activeCLI = AICliTool.claudeCode.rawValue
        config.defaultModelId = AICliTool.claudeCode.defaultModelId
    }

    private func cliRow(_ cli: AICliTool) -> some View {
        let isActive = config.activeCLI == cli.rawValue
        return Button {
            config.activeCLI = cli.rawValue
            config.defaultModelId = cli.defaultModelId
        } label: {
            HStack(spacing: Spacing.md) {
                Image(systemName: isActive ? "circle.inset.filled" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(isActive ? theme.current.accent : theme.current.textMuted)

                Image(systemName: cli.icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isActive ? theme.current.accent : theme.current.textMuted)
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(cli.displayName)
                        .font(Typography.bodyStrong)
                        .foregroundStyle(isActive ? theme.current.text : theme.current.textMuted)
                    Text(cli.description)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }

                Spacer()

                Text(cli.models.prefix(3).map(\.displayName).joined(separator: " · "))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted.opacity(0.7))
                    .lineLimit(1)

                if isActive {
                    Text("Active")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.current.accent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(theme.current.accent.opacity(0.12))
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isActive ? theme.current.accent.opacity(0.06) : Color.clear)
        .cornerRadius(6)
    }
}
