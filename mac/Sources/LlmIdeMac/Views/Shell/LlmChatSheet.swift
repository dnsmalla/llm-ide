import SwiftUI
import os.log

/// Global LLM Chat sheet — same `/kb/agent/ask` transcript the iPhone uses via
/// `llmide_chat`. History is server-persisted so Mac and iPhone stay in sync.
struct LlmChatSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    @State private var transcript: [LlmIdeAPIClient.AgentAskMessage] = []
    @State private var draft: String = ""
    @State private var sending = false
    @State private var lastError: String?
    @State private var loadingHistory = false
    @State private var confirmingClear = false
    @State private var historyRefreshTask: Task<Void, Never>?
    @FocusState private var inputFocused: Bool
    private let log = Logger(subsystem: "com.llmide.macapp", category: "LlmChatSheet")

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            transcriptView
            Divider()
            inputRow
        }
        .frame(minWidth: 520, idealWidth: 580, minHeight: 480, idealHeight: 560)
        .onAppear {
            inputFocused = true
            Task { await loadHistory() }
            historyRefreshTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    await loadHistory()
                }
            }
        }
        .onDisappear {
            historyRefreshTask?.cancel()
            historyRefreshTask = nil
        }
        .onReceive(NotificationCenter.default.publisher(for: .llmChatTranscriptChanged)) { _ in
            Task { await loadHistory() }
        }
        .confirmationDialog(
            "Clear the conversation?",
            isPresented: $confirmingClear,
            titleVisibility: .visible
        ) {
            Button("Clear", role: .destructive) {
                Task { await clearHistory() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the shared LLM Chat transcript from the server. iPhone and Mac will both start fresh.")
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .foregroundStyle(theme.current.accent)
            Text("llm-chat")
                .font(.headline)
            if loadingHistory {
                ProgressView().controlSize(.small)
            }
            Spacer()
            Text("Synced with iPhone")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                confirmingClear = true
            } label: {
                Label("Clear", systemImage: "trash")
            }
            .disabled(transcript.isEmpty)
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var transcriptView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if transcript.isEmpty {
                        emptyState
                    }
                    ForEach(transcript) { msg in
                        bubble(for: msg)
                            .id(msg.id)
                    }
                    if sending {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Thinking…").font(.callout).foregroundStyle(.secondary)
                        }
                        .padding(.leading, 10)
                    }
                    if let err = lastError {
                        Text(err)
                            .font(.callout)
                            .foregroundStyle(theme.current.danger)
                            .padding(.horizontal, 10)
                    }
                }
                .padding(14)
            }
            .onChange(of: transcript.count) { _, _ in
                if let last = transcript.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Ask LLM-IDE anything. Messages here are shared with the iPhone Chat tab.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Examples:")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .padding(.top, 6)
            Group {
                examplePrompt("Summarize my last meeting notes.")
                examplePrompt("What should I follow up on this week?")
                examplePrompt("Explain the active project's architecture.")
            }
        }
    }

    private func examplePrompt(_ text: String) -> some View {
        Button {
            draft = text
            inputFocused = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.right.circle")
                    .foregroundStyle(.secondary)
                Text(text)
                    .font(.callout)
                    .foregroundStyle(theme.current.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer()
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    private func bubble(for msg: LlmIdeAPIClient.AgentAskMessage) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: msg.role == .user ? "person.fill" : "bubble.left.fill")
                .foregroundStyle(msg.role == .user ? Color.accentColor : theme.current.accent)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(msg.role == .user ? "You" : "LLM-IDE")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                Text(msg.content)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(msg.role == .user ? Color.accentColor.opacity(0.08) : theme.current.accent.opacity(0.08))
        .cornerRadius(8)
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message llm-chat…", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .focused($inputFocused)
                .onSubmit { Task { await send() } }
            Button {
                Task { await send() }
            } label: {
                if sending {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
            }
            .buttonStyle(.plain)
            .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Send (⌘↩)")
        }
        .padding(14)
    }

    // MARK: - Actions

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        lastError = nil
        defer { sending = false }

        let userMsg = LlmIdeAPIClient.AgentAskMessage(role: .user, content: text)
        transcript.append(userMsg)
        draft = ""

        do {
            let reply = try await api.askAgent(message: text, history: transcript.dropLast().map { $0 })
            transcript.append(.init(role: .assistant, content: reply))
            NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
        } catch {
            lastError = error.localizedDescription
            transcript.removeLast()
            draft = text
        }
    }

    private func loadHistory() async {
        guard !sending else { return }
        loadingHistory = true
        defer { loadingHistory = false }
        do {
            let items = try await api.listAgentAskHistory(limit: 50)
            transcript = items.map { item in
                let role: LlmIdeAPIClient.AgentAskMessage.Role =
                    (item.role == "assistant") ? .assistant : .user
                return LlmIdeAPIClient.AgentAskMessage(role: role, content: item.content)
            }
        } catch {
            log.error("Failed to load LLM Chat history: \(error.localizedDescription, privacy: .public)")
            lastError = "Could not load shared conversation: \(error.localizedDescription)"
        }
    }

    private func clearHistory() async {
        do {
            _ = try await api.clearAgentAskHistory()
            transcript.removeAll()
            NotificationCenter.default.post(name: .llmChatTranscriptChanged, object: nil)
        } catch {
            lastError = error.localizedDescription
        }
    }
}
