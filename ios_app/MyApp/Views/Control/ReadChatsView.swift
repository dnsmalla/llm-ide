import SwiftUI
import SharedProtocol

/// Host API v1 `read`: the user's chats on the host, a usage strip, and one chat's history. Read-only:
/// nothing here sends a message or changes which chat the Chat tab talks to.
struct ReadChatsView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var usageStore: UsageStore
    @EnvironmentObject var syncStore: SyncStore

    private var state: HostApiReadState { connection.readState }
    private var live: Bool { connection.servesV1Read && connection.connectionStatus == .connected }

    var body: some View {
        List {
            if !live { SyncOfflineSections() }
            else {
            if let error = state.error, state.open == nil {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger)
                }
            }
            usageStrip
            Section("Chats") {
                if state.sessions.isEmpty {
                    Text(state.loading ? "Loading chats…" : "No chats on this host yet.")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
                ForEach(state.sessions, id: \.id) { s in
                    if s.phoneChat == true {
                        row(s, live: true)
                    } else {
                        NavigationLink { ReadChatHistoryView(id: s.id, title: s.title) } label: { row(s, live: false) }
                            .accessibilityHint("Opens this chat read-only")
                    }
                }
                if state.nextOffset != nil {
                    Button("More chats") { Task { await connection.reads.moreSessions() } }
                        .disabled(state.loading)
                }
            }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("History")
        .refreshable {
            if live { usageStore.refresh(); await connection.reads.refresh() } else { await syncStore.refresh() }
        }
        .task {
            if usageStore.state == nil { usageStore.refresh() }
            if state.sessions.isEmpty { await connection.reads.refresh() }
        }
    }

    @ViewBuilder private var usageStrip: some View {
        if let models = usageStore.state?.models, !models.isEmpty {
            Section("Usage") {
                ForEach(Array(models.prefix(3).enumerated()), id: \.offset) { _, m in
                    HStack {
                        Text(m.name).font(DesignSystem.Typography.subheadlineFont).lineLimit(2)
                        Spacer()
                        Text(m.pct.map { "\(Int($0))%" } ?? "No cap")
                            .font(DesignSystem.Typography.subheadlineFont.monospacedDigit())
                            .foregroundColor(m.state == "ok" ? DesignSystem.Colors.textSecondary : DesignSystem.Colors.danger)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(m.name): \(m.detail)")
                }
                NavigationLink("All usage") { UsageView() }
            }
        }
    }

    private func row(_ s: HostApiChatSessionsResultSessionsItem, live: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: s.title).font(DesignSystem.Typography.bodyFont).lineLimit(2)
            Text(live ? "Live chat · on the Chat tab"
                      : Date(epochSeconds: Double(s.updatedAt) / 1000).relativeTimeShort())
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One host chat, read-only. Shown only while `readState.open` is this chat, so a late reply for another
/// chat never paints here.
struct ReadChatHistoryView: View {
    let id: String
    let title: String
    @EnvironmentObject var connection: ConnectionService

    private var open: HostApiOpenChat? { connection.readState.open?.id == id ? connection.readState.open : nil }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: DesignSystem.Spacing.sm) {
                if let error = connection.readState.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger)
                }
                if open?.nextBeforeSeq != nil {
                    Button("Show older") { Task { await connection.reads.older() } }
                        .disabled(connection.readState.loading)
                }
                if let open {
                    ForEach(open.messages, id: \.seq) { m in
                        let assistant = m.role == "assistant"
                        ChatBubble(message: ChatMessage(historyIndex: m.seq, role: assistant ? .assistant : .user, text: m.content))
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel((assistant ? "Assistant: " : "You: ") + m.content)
                    }
                } else if connection.readState.loading {
                    ProgressView("Loading chat…").font(DesignSystem.Typography.footnoteFont)
                }
            }
            .padding(DesignSystem.Spacing.md)
        }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(verbatim: title).font(DesignSystem.Typography.headlineFont).lineLimit(1)
                    Text("Read-only").font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(title), read-only")
            }
        }
        .task { await connection.reads.open(id: id, title: title) }
        .onDisappear { connection.reads.close() }
    }
}
