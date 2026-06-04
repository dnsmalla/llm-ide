import SwiftUI
import os.log

/// Global "Ask the Agent" sheet. Opened via Cmd-Shift-A or the
/// AgentStatusBadge's chat button. Top section mirrors the badge
/// popover (status + dispatch/stop). Bottom is a real chat transcript
/// against /kb/agent/ask, which uses the user's persona so the
/// agent answers in its meeting voice. Conversation history lives
/// in-sheet — closing the sheet drops it on purpose (this is a
/// quick check-in tool, not a long-running chat thread).
struct AskAgentSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var runs: AgentRunsStore
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    @State private var transcript: [LlmIdeAPIClient.AgentAskMessage] = []
    @State private var draft: String = ""
    @State private var sending = false
    @State private var lastError: String?
    @State private var dispatching = false
    @State private var stopping = false
    @State private var loadingHistory = false
    @State private var confirmingClear = false
    @FocusState private var inputFocused: Bool
    private let log = Logger(subsystem: "com.llmide.macapp", category: "AskAgentSheet")

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            statusStrip
            Divider()
            transcriptView
            Divider()
            inputRow
        }
        .frame(minWidth: 520, idealWidth: 580, minHeight: 480, idealHeight: 560)
        .onAppear {
            inputFocused = true
            Task { await runs.refresh() }
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
            Text("This removes the saved Ask-the-Agent transcript from the server. Dispatched agent runs are unaffected.")
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "sparkle")
                .foregroundStyle(.purple)
            Text("Ask the agent")
                .font(.headline)
            if loadingHistory {
                ProgressView().controlSize(.small)
            }
            Spacer()
            // Clear is destructive — gated behind a confirmation
            // dialog. Disabled when there's nothing to clear so the
            // button doesn't look interactive on a fresh sheet.
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

    private var statusStrip: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(runs.hasRunning ? Color.green : theme.current.textMuted)
                .frame(width: 8, height: 8)
            Text(runs.hasRunning ? "Agent is running on \(runs.runningCount) session\(runs.runningCount == 1 ? "" : "s")" : "Agent is idle")
                .font(.callout)
            Spacer()
            Button {
                Task { await dispatch() }
            } label: {
                if dispatching { ProgressView().controlSize(.small) }
                else { Label("Dispatch", systemImage: "play.fill") }
            }
            .disabled(dispatching || runs.hasRunning)

            Button(role: .destructive) {
                Task { await stopAll() }
            } label: {
                if stopping { ProgressView().controlSize(.small) }
                else { Label("Stop all", systemImage: "stop.fill") }
            }
            .disabled(stopping || !runs.hasRunning)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
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
                            .foregroundStyle(.red)
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
            Text("Ask the agent anything. It answers in the voice you configured in Library → Agents (active persona).")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Examples:")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .padding(.top, 6)
            Group {
                examplePrompt("What persona are you using right now?")
                examplePrompt("Summarise what you'd watch for in a kickoff meeting.")
                examplePrompt("Give me three follow-up questions for a status review.")
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
            Image(systemName: msg.role == .user ? "person.fill" : "sparkle")
                .foregroundStyle(msg.role == .user ? Color.accentColor : .purple)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(msg.role == .user ? "You" : "Agent")
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
        .background(msg.role == .user ? Color.accentColor.opacity(0.08) : Color.purple.opacity(0.06))
        .cornerRadius(8)
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask the agent…", text: $draft, axis: .vertical)
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
        } catch {
            // Roll the user's prompt back into the draft so they can
            // edit and retry — losing their typing on failure is
            // annoying.
            lastError = error.localizedDescription
            transcript.removeLast()
            draft = text
        }
    }

    /// Fetch persisted Ask-the-Agent transcript and seed the
    /// in-memory list. Failure is non-fatal — the sheet still works
    /// fresh; we just lose continuity for this open.
    private func loadHistory() async {
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
            log.error("Failed to load Ask Agent history: \(error.localizedDescription, privacy: .public)")
            lastError = "Could not load saved conversation: \(error.localizedDescription)"
            return
        }
    }

    /// Wipe server-side history and the in-memory list. Confirmation
    /// already happened in the parent dialog before this fires.
    private func clearHistory() async {
        do {
            _ = try await api.clearAgentAskHistory()
            transcript.removeAll()
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func dispatch() async {
        dispatching = true
        lastError = nil
        defer { dispatching = false }
        do {
            _ = try await api.dispatchAgent()
            await runs.refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func stopAll() async {
        stopping = true
        lastError = nil
        defer { stopping = false }
        var failedRuns = 0
        for run in runs.runs {
            do {
                _ = try await api.stopAgent(sessionId: run.sessionId)
            } catch {
                failedRuns += 1
                log.error("Failed to stop agent run \(run.sessionId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        await runs.refresh()
        if failedRuns > 0 {
            lastError = failedRuns == 1
                ? "Failed to stop 1 agent run. Check the backend logs and try again."
                : "Failed to stop \(failedRuns) agent runs. Check the backend logs and try again."
        }
    }
}
