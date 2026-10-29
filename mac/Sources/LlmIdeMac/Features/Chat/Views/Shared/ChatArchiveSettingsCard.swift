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
                        if s.pendingDeletes > 0 {
                            Text("\(s.pendingDeletes) deleted chat\(s.pendingDeletes == 1 ? "" : "s") still being removed from the server; retried at every start.")
                                .font(Typography.caption)
                        }
                    }
                }
            }
        }
        .task { status = await ChatArchiveHost.shared.status() }
    }

    private func claim() async {
        busy = true
        claimed = await ChatArchiveHost.shared.claimOlderChats()
        status = await ChatArchiveHost.shared.status()
        busy = false
    }
}
