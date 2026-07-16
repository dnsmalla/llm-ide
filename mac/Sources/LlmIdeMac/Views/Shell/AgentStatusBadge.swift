import SwiftUI

/// Compact agent-state chip for the global status bar. Tap opens a
/// popover with dispatch / stop controls + a "Configure" link into
/// Settings. The badge itself shows running count + a subtle pulse
/// when active, so the user can scan the bottom row from anywhere
/// in the app and know whether the meeting agent is doing work.
struct AgentStatusBadge: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var runs: AgentRunsStore
    @EnvironmentObject var theme: ThemeStore
    @Environment(ShellState.self) private var shell

    @State private var showingPopover = false
    @State private var dispatching = false
    @State private var stopping = false
    @State private var lastError: String?
    // Quick-ask state. Lives in-popover only — the answer renders
    // inline (truncated) so users can fire off a one-liner without
    // opening the full sheet. Both the question and the reply are
    // still persisted server-side via /kb/agent/ask, so opening the
    // full sheet later shows them in the unified transcript.
    @State private var quickAskDraft: String = ""
    @State private var quickAskReply: String?
    @State private var quickAsking = false
    @FocusState private var quickAskFocused: Bool

    var body: some View {
        Button {
            Task { await runs.refresh() }
            showingPopover.toggle()
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(runs.hasRunning ? theme.current.success : theme.current.textMuted)
                    .frame(width: 7, height: 7)
                    .modifier(PulseModifier(active: runs.hasRunning))
                Image(systemName: "sparkle")
                    .font(.system(size: 10))
                Text(label)
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(theme.current.surface.opacity(0.6))
            .cornerRadius(4)
        }
        .buttonStyle(.plain)
        .help("Meeting agent — click to dispatch, stop, or configure")
        .popover(isPresented: $showingPopover, arrowEdge: .top) {
            popoverBody
                .frame(width: 280)
        }
    }

    private var label: String {
        if runs.hasRunning {
            return "Agent · \(runs.runningCount) running"
        }
        return "Agent · idle"
    }

    @ViewBuilder
    private var popoverBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Meeting agent").font(.headline)
                Spacer()
                if runs.refreshing { ProgressView().controlSize(.small) }
            }
            statusLine
            Divider()
            quickAskRow
            if let reply = quickAskReply {
                quickAskReplyBlock(reply)
            }
            Divider()
            actions
            if let err = lastError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(theme.current.danger)
                    .lineLimit(2)
            }
        }
        .padding(14)
    }

    @ViewBuilder
    private var statusLine: some View {
        if runs.runs.isEmpty {
            Text("No agent runs.").font(.callout).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(runs.runs.prefix(3)) { run in
                    HStack(spacing: 6) {
                        Circle().fill(isRunRunning(run) ? theme.current.success : theme.current.textMuted)
                            .frame(width: 6, height: 6)
                        Text(run.sessionId.prefix(8) + "…")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                        if let plan = run.planId {
                            Text("· plan \(plan.prefix(6))…")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                }
                if runs.runs.count > 3 {
                    Text("+ \(runs.runs.count - 3) more")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Single-line text field + send button. ⌘↩ to send. Submit on
    /// plain Return too because there's no multi-line concern here —
    /// long-form questions should use the full sheet.
    @ViewBuilder
    private var quickAskRow: some View {
        HStack(spacing: 6) {
            TextField("Quick ask…", text: $quickAskDraft)
                .textFieldStyle(.roundedBorder)
                .focused($quickAskFocused)
                .onSubmit { Task { await quickAsk() } }
                .disabled(quickAsking)
            Button {
                Task { await quickAsk() }
            } label: {
                if quickAsking {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title3)
                }
            }
            .buttonStyle(.plain)
            .disabled(quickAsking || quickAskDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Ask (↩)")
        }
    }

    /// Inline reply pane — capped at 4 lines with a "Open full chat"
    /// link that lifts the user into the sheet for the full thread.
    /// The reply is also persisted server-side so the sheet will show
    /// the same exchange when reopened.
    private func quickAskReplyBlock(_ reply: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: "sparkle").foregroundStyle(.purple).font(.caption2)
                Text("Agent").font(.caption2.bold()).foregroundStyle(.secondary)
                Spacer()
                Button {
                    showingPopover = false
                    NotificationCenter.default.post(name: .openAskAgentSheet, object: nil)
                } label: {
                    Text("Open full chat")
                        .font(.caption2)
                }
                .buttonStyle(.link)
            }
            Text(reply)
                .font(.callout)
                .lineLimit(4)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(8)
        .background(Color.purple.opacity(0.06))
        .cornerRadius(6)
    }

    @ViewBuilder
    private var actions: some View {
        HStack {
            Button {
                Task { await dispatch() }
            } label: {
                if dispatching {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Dispatch", systemImage: "play.fill")
                }
            }
            .disabled(dispatching || runs.hasRunning)

            Button(role: .destructive) {
                Task { await stopAll() }
            } label: {
                if stopping {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Stop all", systemImage: "stop.fill")
                }
            }
            .disabled(stopping || !runs.hasRunning)

            Spacer()
            Button {
                showingPopover = false
                NotificationCenter.default.post(name: .openAskAgentSheet, object: nil)
            } label: {
                Image(systemName: "bubble.left.and.bubble.right")
            }
            .help("Ask the agent (⌘⇧A)")
        }
    }

    private func isRunRunning(_ run: LlmIdeAPIClient.AgentRun) -> Bool {
        let now = Date().timeIntervalSince1970
        return (run.lastTickAt ?? run.startedAt) > now - 180
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

    /// Fire-and-display one-shot ask. No client-side history is
    /// passed — quick-ask is intentionally context-free so it stays
    /// snappy. The exchange IS persisted server-side, so the full
    /// sheet will show it the next time it opens.
    private func quickAsk() async {
        let text = quickAskDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !quickAsking else { return }
        quickAsking = true
        lastError = nil
        defer { quickAsking = false }
        do {
            let reply = try await api.askAgent(message: text, history: [])
            quickAskReply = reply
            quickAskDraft = ""
        } catch {
            lastError = error.localizedDescription
            // Leave the draft intact so the user can edit and retry.
        }
    }

    private func stopAll() async {
        stopping = true
        lastError = nil
        defer { stopping = false }
        for run in runs.runs where isRunRunning(run) {
            _ = try? await api.stopAgent(sessionId: run.sessionId)
        }
        await runs.refresh()
    }
}

/// Subtle pulse on the green dot when the agent is active.
private struct PulseModifier: ViewModifier {
    let active: Bool
    @State private var on = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(on && active ? 1.25 : 1.0)
            .opacity(on && active ? 0.6 : 1.0)
            .onAppear { restart() }
            .onChange(of: active) { _, _ in restart() }
    }

    private func restart() {
        on = false
        guard active else { return }
        withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) {
            on = true
        }
    }
}
