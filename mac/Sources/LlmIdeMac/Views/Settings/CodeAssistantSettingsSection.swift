import SwiftUI

/// Code Assistant settings — today just the Agent engine (beta) toggle.
/// Local-only (`@AppStorage`): the engine choice is a Mac-client behavior,
/// not a synced preference, because it gates which TRANSPORT the Mac's chat
/// engines use (see `AgentV2Selection` / `ChatTransportFactory`).
struct CodeAssistantSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @AppStorage(AgentV2Selection.toggleKey) private var useAgentV2 = false

    var body: some View {
        SettingsSectionCard(icon: "sparkles", title: "Code Assistant") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Toggle(isOn: $useAgentV2) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Agent engine (beta)")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("Uses the new Claude engine for new chats (Anthropic provider only).")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                .toggleStyle(.switch)
                SettingsHint("The Agent engine answers AskUserQuestion cards mid-turn and keeps its own server-side session per chat. Chats on other providers, and this Mac's phone-driven background chats, keep using the classic engine. If the server hasn't been updated yet, turns automatically fall back.")
            }
        }
    }
}
