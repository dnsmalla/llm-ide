import SwiftUI
import UIKit
import SharedProtocol

/// Native iOS view for the Mac-side "explorer chat" sessions: browse/create/load
/// persistent sessions, read their transcript, and send new turns. Mirrors the
/// Mac's explorer chat through the same per-feature-store bridge Task 7 wired.
///
/// Styling mirrors `LlmIdeControlView` (DesignSystem colors/typography, bubble
/// layout, input bar) so the two chats feel like one surface. The session list
/// is a sheet so the transcript stays the focus.
struct ExplorerChatView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var explorerStore: ExplorerChatStore
    @Environment(\.dismiss) private var dismiss

    @State private var inputText: String = ""
    @State private var showSessionPicker: Bool = false
    @FocusState private var isInputFocused: Bool

    private var isConnected: Bool { connection.connectionStatus == .connected }
    private var hasSession: Bool { explorerStore.exploreCurrent != nil }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !isConnected {
                    StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
                }
                if let err = connection.errorMessage {
                    StatusBanner(.error(message: err) { connection.errorMessage = nil })
                }
                chatTranscript
                inputBar
            }
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .animation(.easeInOut(duration: 0.2), value: isConnected)
            .animation(.easeInOut(duration: 0.2), value: connection.errorMessage)
            .navigationTitle(explorerStore.exploreCurrent?.title ?? "Explorer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSessionPicker = true
                        explorerStore.exploreListSessions()
                    } label: { Image(systemName: "sidebar.left") }
                }
            }
        }
        .sheet(isPresented: $showSessionPicker) {
            sessionPicker
                .environmentObject(connection)
                .environmentObject(explorerStore)
        }
        .onAppear { explorerStore.exploreListSessions() }
    }

    // MARK: — Session picker (sheet)

    private var sessionPicker: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        explorerStore.exploreNewSession()
                        showSessionPicker = false
                    } label: {
                        Label("New chat", systemImage: "plus.circle.fill")
                            .foregroundColor(DesignSystem.Colors.primary)
                    }
                }
                Section(explorerStore.exploreSessions.isEmpty ? "No sessions yet" : "Recent") {
                    ForEach(explorerStore.exploreSessions, id: \.id) { session in
                        sessionRow(session)
                    }
                    .onDelete { indexSet in
                        for idx in indexSet {
                            explorerStore.exploreDeleteSession(explorerStore.exploreSessions[idx].id)
                        }
                    }
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { showSessionPicker = false }
                }
            }
            .onAppear { explorerStore.exploreListSessions() }
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: ExploreSessionSummary) -> some View {
        Button {
            explorerStore.exploreLoadSession(session.id)
            showSessionPicker = false
        } label: {
            HStack(spacing: DesignSystem.Spacing.sm) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 15))
                    .foregroundColor(DesignSystem.Colors.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title.isEmpty ? "Untitled" : session.title)
                        .font(.system(size: DesignSystem.Typography.body))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                        .lineLimit(1)
                    Text(Date(epochSeconds: session.lastUsedAt).relativeTimeShort())
                        .font(.system(size: DesignSystem.Typography.footnote))
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
                Spacer(minLength: 0)
                if explorerStore.exploreCurrent?.id == session.id {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(DesignSystem.Colors.primary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: — Chat transcript

    private var chatTranscript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: DesignSystem.Spacing.sm) {
                    if let current = explorerStore.exploreCurrent {
                        if current.history.isEmpty {
                            EmptyChatState(
                                icon: "bubble.left.and.text.bubble.right",
                                title: "Ask anything about this session",
                                subtitle: "Type a question below to start."
                            )
                        }
                        ForEach(current.history) { msg in
                            ChatBubble(message: msg).id(msg.id)
                        }
                    } else {
                        noSessionState
                    }
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: explorerStore.exploreCurrent?.history.last?.text) { _ in
                if let last = explorerStore.exploreCurrent?.history.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    /// Left inline — distinct from `EmptyChatState`: different icon, different
    /// copy, and a "Browse sessions" action button. Only appears in the explorer
    /// surface, so factoring it out would add parameters for one caller.
    private var noSessionState: some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: "sidebar.left")
                .font(.system(size: 34))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text("No session selected")
                .font(.system(size: DesignSystem.Typography.callout, weight: .medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Text("Pick or create a session to begin.")
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Button {
                showSessionPicker = true
                explorerStore.exploreListSessions()
            } label: {
                Label("Browse sessions", systemImage: "list.bullet")
                    .font(.system(size: DesignSystem.Typography.body, weight: .medium))
                    .foregroundColor(DesignSystem.Colors.primary)
                    .padding(.horizontal, DesignSystem.Spacing.md)
                    .padding(.vertical, DesignSystem.Spacing.sm)
                    .background(DesignSystem.Colors.primaryLight)
                    .clipShape(Capsule())
            }
            .padding(.top, DesignSystem.Spacing.xs)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    // MARK: — Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            Divider()
            ChatInputBar(
                text: $inputText,
                placeholder: hasSession ? "Message explorer" : "Select a session first",
                canSend: canSend,
                isFocused: $isInputFocused,
                onSend: send
            )
        }
    }

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && isConnected
            && hasSession
            && !explorerStore.isStreaming   // one question at a time (per-surface flag)
    }

    // MARK: — Actions

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let id = explorerStore.exploreCurrent?.id else { return }
        explorerStore.sendExploreChat(text, sessionId: id)
        inputText = ""
        isInputFocused = false
        haptic(.light)
    }
}
