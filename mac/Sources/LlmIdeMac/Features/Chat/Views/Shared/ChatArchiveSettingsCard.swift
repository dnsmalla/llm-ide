import SwiftUI

/// The small Settings card for the live-then-archive chat lifecycle (shown only when `lta.mode` is not off): the
/// explicit "Claim older chats" action, how many extension chats the archive kept on the server for a decision, and
/// how many delete tombstones are still owed. No silent claim ever happens: older chats stay visible to everyone
/// signed in on this Mac until this button is pressed.
struct ChatArchiveSettingsCard: View {
    @EnvironmentObject var theme: ThemeStore
    @State private var status: ChatArchiveStatus?
    @State private var busy = false
    @State private var claimed: Int?
    @StateObject private var attention = ChatArchiveAttentionModel(host: ChatArchiveHost.shared)

    var body: some View {
        Group {
            if let s = status, s.mode != .off {
                SettingsSectionCard(icon: "archivebox", title: "Chat archive") {
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        SettingsHint("Chats are kept on this Mac and tagged with the account that made them; another account never sees them.")
                        if s.unowned > 0, s.userId != nil {
                            HStack {
                                Text("\(s.unowned) older chat\(s.unowned == 1 ? "" : "s") belong to no account yet.")
                                    .font(Typography.caption)
                                Spacer()
                                Button("Claim \(s.unowned) older chat\(s.unowned == 1 ? "" : "s")") {
                                    Task { await claim() }
                                }
                                .buttonStyle(.bordered).controlSize(.small).disabled(busy)
                            }
                        }
                        if let claimed {
                            Text("Claimed \(claimed) chat\(claimed == 1 ? "" : "s").").font(Typography.caption)
                        }
                        if s.attention > 0 {
                            Text("\(s.attention) extension chat\(s.attention == 1 ? "" : "s") kept on the server: the archive is incomplete or a file on this Mac differs.")
                                .font(Typography.caption).foregroundStyle(theme.current.danger)
                        }
                        attentionList
                        if s.pendingDeletes > 0 {
                            Text("\(s.pendingDeletes) deleted chat\(s.pendingDeletes == 1 ? "" : "s") still being removed from the server; retried at every start.")
                                .font(Typography.caption)
                        }
                    }
                }
            }
        }
        .task {
            status = await ChatArchiveHost.shared.status()
            await attention.reload()
        }
        .confirmationDialog(
            "Archive as is?",
            isPresented: Binding(get: { attention.confirming != nil }, set: { if !$0 { attention.cancelConfirm() } }),
            titleVisibility: .visible
        ) {
            Button("Archive as is", role: .destructive) {
                Task { await attention.confirmArchiveAsIs(); status = await ChatArchiveHost.shared.status() }
            }
            Button("Cancel", role: .cancel) { attention.cancelConfirm() }
        } message: {
            Text(ChatArchiveAttentionWording.confirmMessage)
        }
    }

    @ViewBuilder
    private var attentionList: some View {
        ForEach(attention.items) { item in
            VStack(alignment: .leading, spacing: 2) {
                Text(ChatArchiveAttentionWording.displayTitle(item)).font(Typography.body)
                Text(ChatArchiveAttentionWording.counts(item)).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                Text(ChatArchiveAttentionWording.reason(item)).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    if item.canArchiveAsIs {
                        Button("Archive as is") { attention.requestArchiveAsIs(item.serverId) }
                            .accessibilityLabel("Archive \(ChatArchiveAttentionWording.displayTitle(item)) as is")
                    }
                    Button("Keep on server") {
                        Task { await attention.keepOnServer(item.serverId); status = await ChatArchiveHost.shared.status() }
                    }
                    .accessibilityLabel("Keep \(ChatArchiveAttentionWording.displayTitle(item)) on the server")
                }
                .buttonStyle(.bordered).controlSize(.small)
                .disabled(attention.busy.contains(item.serverId))
            }
        }
        if let message = attention.message {
            Text(message).font(Typography.caption).foregroundStyle(theme.current.warning)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func claim() async {
        busy = true
        claimed = await ChatArchiveHost.shared.claimOlderChats()
        status = await ChatArchiveHost.shared.status()
        busy = false
    }
}
