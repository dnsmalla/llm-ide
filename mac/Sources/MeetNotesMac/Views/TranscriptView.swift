import SwiftUI

/// Live transcript pane.  Shows captions from BOTH:
///   1. The local `CaptionOrchestrator` (AX scraping of Zoom/Teams desktop)
///   2. The `LiveSessionMirror` (server-polled stream from other clients —
///      most commonly the Chrome extension capturing from Meet/Teams web,
///      or our own server-side meeting agent when dispatched)
///
/// Both are merged into one chronological list so the user sees a unified
/// transcript regardless of which surface caught the words.  Each line
/// carries a small badge identifying its origin.
struct TranscriptView: View {
    let api: MeetNotesAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var capture: CaptionOrchestrator
    @EnvironmentObject var liveMirror: LiveSessionMirror

    @State private var lastSeenCount = 0
    @State private var dispatchBusy = false
    @State private var dispatchError: String?
    @State private var activeAgentSessionId: String?
    @State private var activeAgentRun: MeetNotesAPIClient.AgentRun?
    @State private var agentPollBackoffNs: UInt64 = 0

    // Dispatch sheet — opens when the user wants to provide a meeting
    // URL so the bot actually joins the call.  Empty URL → co-pilot
    // mode (private to this app).
    @State private var showingDispatchSheet = false
    @State private var dispatchURL = ""
    /// True when the most recent dispatch put a real bot-worker
    /// participant in the meeting (vs. co-pilot mode).  Surfaced in
    /// the agent bar so the user can tell which mode they're in.
    @State private var botInRoom = false
    /// Local cache of feedback already submitted in this session, so
    /// the popover buttons fade out once the user has voted instead
    /// of inviting double-submission.  Keyed by the row id.

    /// Unified row for rendering — wraps either source so the body
    /// doesn't have to branch per item.
    private struct Row: Identifiable {
        let id: String
        let speaker: String
        let text: String
        let timestamp: Date
        let origin: Origin
        let meta: MeetNotesAPIClient.LiveCaptionMeta?
        enum Origin {
            case local
            case remote(String?)
            case agent(AgentKind)
        }
        enum AgentKind { case system, relay, question }
    }

    private static func agentKind(for source: String) -> Row.AgentKind? {
        switch source {
        case "agent-system":   return .system
        case "agent-relay":    return .relay
        case "agent-question": return .question
        default: return nil
        }
    }

    private var rows: [Row] {
        var combined: [Row] = capture.captions.map { c in
            Row(id: "local-\(c.id.uuidString)",
                speaker: c.speaker, text: c.text, timestamp: c.timestamp,
                origin: .local, meta: nil)
        }
        // Only include captions from CC / mic / extension sources.
        // Agent messages (agent-system, agent-relay, agent-question)
        // are not spoken words — keep the transcript clean.
        combined.append(contentsOf: liveMirror.captions.compactMap { c in
            guard Self.agentKind(for: c.source) == nil else { return nil }
            return Row(id: "remote-\(c.id)",
                       speaker: c.speaker, text: c.text, timestamp: c.timestamp,
                       origin: .remote(liveMirror.activeSession?.meetingTitle),
                       meta: nil)
        })
        combined.sort { $0.timestamp < $1.timestamp }
        return combined
    }

    var body: some View {
        VStack(spacing: 0) {
            agentBar
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if !rows.isEmpty { liveBanner }
                        if rows.isEmpty {
                            emptyState
                        } else {
                            ForEach(rows) { row in
                                line(for: row).id(row.id)
                            }
                        }
                    }
                    .padding(12)
                }
                .background(theme.current.body)
                .onChange(of: rows.count) { _, count in
                    guard count != lastSeenCount, let last = rows.last else { return }
                    lastSeenCount = count
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
        .task { await refreshActiveAgent() }
        .sheet(isPresented: $showingDispatchSheet) { dispatchSheet }
    }

    @ViewBuilder
    private var dispatchSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Send agent")
                .font(Typography.title)
            Text("To put a real participant in the meeting, paste the meeting URL (Google Meet / Teams / Zoom). Leave blank to run in co-pilot mode — the agent will only show questions in this app.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://meet.google.com/abc-defg-hij", text: $dispatchURL)
                .textFieldStyle(.roundedBorder)
            if let err = dispatchError {
                Text(err)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Cancel") { showingDispatchSheet = false }
                Spacer()
                Button("Co-pilot only") {
                    Task { await dispatch(meetingUrl: nil) }
                }
                .disabled(dispatchBusy)
                Button(dispatchBusy ? "Sending…" : "Send to meeting") {
                    Task { await dispatch(meetingUrl: dispatchURL.trimmingCharacters(in: .whitespacesAndNewlines)) }
                }
                .disabled(dispatchURL.trimmingCharacters(in: .whitespaces).isEmpty || dispatchBusy)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    // ── Agent button bar ──────────────────────────────────────────────

    @ViewBuilder
    private var agentBar: some View {
        HStack(spacing: 8) {
            if let sid = activeAgentSessionId {
                Circle().fill(theme.current.danger)
                    .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(botInRoom ? "Agent in meeting" : "Agent attached")
                            .font(Typography.captionStrong)
                            .foregroundStyle(theme.current.text)
                        Text(botInRoom ? "· bot is a participant" : "· co-pilot mode")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                        Text("· session \(sid.suffix(6))")
                            .font(Typography.mono)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Text(formatTickStatus(activeAgentRun))
                        .font(Typography.mono)
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                Button(dispatchBusy ? "…" : "Stop agent") {
                    Task { await stopAgent() }
                }
                .disabled(dispatchBusy)
            } else {
                Text("Meeting agent")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.textMuted)
                if let err = dispatchError {
                    Text("· \(err)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .lineLimit(1)
                }
                Spacer()
                Button(dispatchBusy ? "Attaching…" : "Send agent…") {
                    dispatchURL = ""
                    dispatchError = nil
                    showingDispatchSheet = true
                }
                .disabled(dispatchBusy || !canDispatch)
                .help(canDispatch
                      ? "Open the dispatch sheet (with optional meeting URL for in-room bot)"
                      : "Start a capture in the extension or this app first")
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 6)
        .background(theme.current.surface)
        .overlay(Divider(), alignment: .bottom)
    }

    /// Can attach when SOME live capture is in flight — either ours
    /// (CaptionOrchestrator running) or a remote one mirrored in.
    private var canDispatch: Bool {
        capture.isRunning || liveMirror.activeSession != nil
    }

    private func dispatch(meetingUrl: String? = nil) async {
        dispatchBusy = true
        dispatchError = nil
        defer { dispatchBusy = false }
        do {
            // Pass the mirror's session id when we have one — that's
            // the extension's capture.  Otherwise let the server pick.
            let sid = liveMirror.activeSession?.sessionId
            let url = (meetingUrl?.isEmpty == false) ? meetingUrl : nil
            let r = try await api.dispatchAgent(
                sessionId: sid,
                language: preferredLanguage(),
                meetingUrl: url,
            )
            activeAgentSessionId = r.sessionId
            botInRoom = r.botInRoom ?? false
            showingDispatchSheet = false
            // If the server tried to launch a bot but the bot-worker
            // failed (or isn't running), dispatch still attaches in
            // co-pilot mode — show the bootError so the user knows
            // why nobody joined.
            if let boot = r.bootError, !boot.isEmpty {
                dispatchError = "Bot launch failed: \(boot.prefix(140))"
            }
        } catch {
            dispatchError = error.localizedDescription
        }
    }

    /// Best-guess meeting language for this dispatch.  Reads the
    /// system's preferred languages (accepts macOS's "ja-JP", server
    /// understands "ja").  Server side will fall back to English for
    /// any code we haven't translated.
    private func preferredLanguage() -> String {
        let codes = Locale.preferredLanguages
        let first = codes.first ?? "en"
        // Strip region — server I18N table is keyed on base codes.
        return String(first.split(separator: "-").first ?? "en")
    }

    private func stopAgent() async {
        guard let sid = activeAgentSessionId else { return }
        dispatchBusy = true
        defer { dispatchBusy = false }
        _ = try? await api.stopAgent(sessionId: sid)
        activeAgentSessionId = nil
        activeAgentRun = nil
        botInRoom = false
    }

    private func refreshActiveAgent() async {
        // Poll every 4s while attached so the "watching · last: …"
        // status line stays current.  When detached we still poll
        // (less often) so a remote attach from the side panel
        // surfaces here too.
        // On network error, exponential backoff applies: 2s → 4s → 8s → ... → 60s cap.
        // On success, backoff resets.
        while !Task.isCancelled {
            if let runs = try? await api.listAgentRuns() {
                activeAgentRun = runs.first
                activeAgentSessionId = runs.first?.sessionId
                agentPollBackoffNs = 0
            } else {
                agentPollBackoffNs = agentPollBackoffNs == 0
                    ? 2_000_000_000
                    : min(agentPollBackoffNs * 2, 60_000_000_000)
            }
            let base: UInt64 = activeAgentSessionId == nil ? 10_000_000_000 : 4_000_000_000
            let sleep = max(base, agentPollBackoffNs)
            try? await Task.sleep(nanoseconds: sleep)
        }
    }

    /// "watching · last: cooldown 12s left (3s ago)" — keeps the
    /// user oriented on what the loop is actually doing every tick.
    private func formatTickStatus(_ run: MeetNotesAPIClient.AgentRun?) -> String {
        guard let run else { return "starting up…" }
        guard let ts = run.lastTickAt, let d = run.lastDecision else {
            return "just attached, waiting for first tick…"
        }
        let ageSec = max(0, Int((Date().timeIntervalSince1970 - ts / 1000.0).rounded()))
        let age = ageSec < 60 ? "\(ageSec)s ago" : "\(ageSec / 60)m ago"
        return "watching · last: \(d.reason) (\(age))"
    }

    @ViewBuilder
    private var liveBanner: some View {
        if let live = liveMirror.activeSession, !capture.isRunning {
            HStack(spacing: 6) {
                Circle()
                    .fill(theme.current.danger)
                    .frame(width: 8, height: 8)
                Text("Live from Chrome extension")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.text)
                if let title = live.meetingTitle, !title.isEmpty {
                    Text("·").foregroundStyle(theme.current.textMuted)
                    Text(title)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                Text("session \(live.sessionId.suffix(6))")
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.textMuted)
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, 6)
            .background(theme.current.accent.opacity(theme.current.isDark ? 0.18 : 0.10))
            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No captions yet.")
                .font(Typography.bodyStrong)
                .foregroundStyle(theme.current.textMuted)
            Text("Start recording from the Chrome extension on Meet / Teams web, or click Start in this app while Zoom or Teams desktop has captions enabled.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 24)
    }

    @ViewBuilder
    private func line(for row: Row) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(row.speaker)
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.accent2)
                Text(timeString(for: row.timestamp))
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.textMuted)
                originBadge(for: row.origin)
            }
            Text(row.text)
                .font(Typography.body)
                .foregroundStyle(theme.current.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.current.surface)
        .cornerRadius(4)
    }

    @ViewBuilder
    private func originBadge(for origin: Row.Origin) -> some View {
        switch origin {
        case .local:
            badge("desktop", color: theme.current.accent3)
        case .remote:
            badge("chrome", color: theme.current.accent)
        case .agent(let kind):
            switch kind {
            case .system:   badge("agent",  color: theme.current.textMuted)
            case .relay:    badge("via bot", color: theme.current.accent)
            case .question: badge("agent ?", color: theme.current.danger)
            }
        }
    }

    @ViewBuilder
    private func badge(_ label: String, color: Color) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.18))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private func timeString(for date: Date) -> String {
        AppDateFormatter.hourMinuteSecond(date)
    }
}
