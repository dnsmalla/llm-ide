import SwiftUI
import UIKit
import SharedProtocol

/// Native iOS view for the Mac-side "explorer chat" sessions: browse/create/load
/// persistent sessions, read their transcript, and send new turns. Mirrors the
/// Mac's explorer chat through the same ControlService bridge Task 4 wired.
///
/// Styling mirrors `LlmIdeControlView` (DesignSystem colors/typography, bubble
/// layout, input bar) so the two chats feel like one surface. The session list
/// is a sheet so the transcript stays the focus.
struct ExplorerChatView: View {
    @EnvironmentObject var controlService: ControlService
    @Environment(\.dismiss) private var dismiss

    @State private var inputText: String = ""
    @State private var showSessionPicker: Bool = false
    @FocusState private var isInputFocused: Bool

    private var isConnected: Bool { controlService.connectionStatus == .connected }
    private var hasSession: Bool { controlService.exploreCurrent != nil }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !isConnected { connectionBanner }
                if let err = controlService.errorMessage { errorBanner(err) }
                chatTranscript
                inputBar
            }
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .animation(.easeInOut(duration: 0.2), value: isConnected)
            .animation(.easeInOut(duration: 0.2), value: controlService.errorMessage)
            .navigationTitle(controlService.exploreCurrent?.title ?? "Explorer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSessionPicker = true
                        controlService.exploreListSessions()
                    } label: { Image(systemName: "sidebar.left") }
                }
            }
        }
        .sheet(isPresented: $showSessionPicker) {
            sessionPicker
                .environmentObject(controlService)
        }
        .onAppear { controlService.exploreListSessions() }
    }

    // MARK: — Session picker (sheet)

    private var sessionPicker: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        controlService.exploreNewSession()
                        showSessionPicker = false
                    } label: {
                        Label("New chat", systemImage: "plus.circle.fill")
                            .foregroundColor(DesignSystem.Colors.primary)
                    }
                }
                Section(controlService.exploreSessions.isEmpty ? "No sessions yet" : "Recent") {
                    ForEach(controlService.exploreSessions, id: \.id) { session in
                        sessionRow(session)
                    }
                    .onDelete { indexSet in
                        for idx in indexSet {
                            controlService.exploreDeleteSession(controlService.exploreSessions[idx].id)
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
            .onAppear { controlService.exploreListSessions() }
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: ExploreSessionSummary) -> some View {
        Button {
            controlService.exploreLoadSession(session.id)
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
                    Text(Self.relativeTime(from: session.lastUsedAt))
                        .font(.system(size: DesignSystem.Typography.footnote))
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
                Spacer(minLength: 0)
                if controlService.exploreCurrent?.id == session.id {
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
                    if let current = controlService.exploreCurrent {
                        if current.history.isEmpty {
                            emptyState(title: current.title)
                        }
                        ForEach(current.history) { msg in
                            bubble(msg).id(msg.id)
                        }
                    } else {
                        noSessionState
                    }
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: controlService.exploreCurrent?.history.last?.text) { _ in
                if let last = controlService.exploreCurrent?.history.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private func emptyState(title: String) -> some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 34))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text("Ask anything about this session")
                .font(.system(size: DesignSystem.Typography.callout, weight: .medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Text("Type a question below to start.")
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

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
                controlService.exploreListSessions()
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

    @ViewBuilder
    private func bubble(_ msg: ChatMessage) -> some View {
        let isUser = msg.role == .user
        let isThinking = !isUser && msg.text.isEmpty
        HStack {
            if isUser { Spacer(minLength: 40) }
            Group {
                if isThinking {
                    HStack(spacing: 8) {
                        ProgressView().scaleEffect(0.8)
                        Text("Thinking…")
                            .font(.system(size: DesignSystem.Typography.body))
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                    }
                } else {
                    Text(msg.text)
                        .font(.system(size: DesignSystem.Typography.body))
                        .foregroundColor(isUser ? .white : DesignSystem.Colors.textPrimary)
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 10)
            .background(isUser ? DesignSystem.Colors.primary : DesignSystem.Colors.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
                    .stroke(isUser ? Color.clear : DesignSystem.Colors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
            if !isUser { Spacer(minLength: 40) }
        }
    }

    // MARK: — Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: DesignSystem.Spacing.sm) {
                TextField(hasSession ? "Message explorer" : "Select a session first",
                          text: $inputText, axis: .vertical)
                    .font(.system(size: DesignSystem.Typography.body))
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused($isInputFocused)
                    .padding(.horizontal, DesignSystem.Spacing.md)
                    .padding(.vertical, 10)
                    .background(DesignSystem.Colors.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL)
                            .stroke(DesignSystem.Colors.border, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL))
                    .onSubmit(send)

                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundColor(canSend ? DesignSystem.Colors.primary : DesignSystem.Colors.textTertiary)
                }
                .disabled(!canSend)
            }
            .padding(DesignSystem.Spacing.md)
            .background(DesignSystem.Colors.surfaceSecondary)
        }
    }

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && isConnected
            && hasSession
            && !controlService.llmStreaming   // one question at a time (shared flag)
    }

    // MARK: — Banners (mirror LlmIdeControlView)

    private var connectionBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash").font(.system(size: 13))
            Text(controlService.connectionStatus == .connecting
                 ? "Connecting to your Mac…" : "Not connected to your Mac")
                .font(.system(size: DesignSystem.Typography.footnote, weight: .medium))
            Spacer()
        }
        .foregroundColor(.white)
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.vertical, 8)
        .background(DesignSystem.Colors.textTertiary)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundColor(DesignSystem.Colors.danger)
            Text(message)
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button { controlService.errorMessage = nil } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.vertical, 8)
        .background(DesignSystem.Colors.danger.opacity(0.12))
    }

    // MARK: — Actions

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let id = controlService.exploreCurrent?.id else { return }
        controlService.sendExploreChat(text, sessionId: id)
        inputText = ""
        isInputFocused = false
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // MARK: — Helpers

    /// `lastUsedAt` arrives as epoch seconds (Mac sends `timeIntervalSince1970`).
    private static func relativeTime(from epochSeconds: Double) -> String {
        let date = Date(timeIntervalSince1970: epochSeconds)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
