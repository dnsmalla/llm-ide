import Foundation
import SharedProtocol

/// Offline demo of the whole app, with no Mac and no network.
///
/// WHY THIS EXISTS: every screen in this app is a mirror of a Mac running
/// LLM-IDE. Without one paired, the app stops dead at `ConnectView` — which
/// makes it unreviewable. An App Store reviewer has no Mac running Mobile
/// Control, cannot pair, and under App Review Guideline 2.1 an app that
/// cannot be exercised is rejected. It is also the honest answer for anyone
/// who installs the app before setting up their Mac.
///
/// HOW IT WORKS: `ConnectionService` funnels every outbound frame through
/// `sendTextFrame` and every inbound frame through `handleMessage`. In demo
/// mode the socket is simply never opened, and this class is spliced between
/// those two: it parses the outbound JSON and emits the canned reply frames
/// the Mac would have sent. Everything downstream — the stores, the streaming
/// chat machinery, the heartbeat, the reconnect banner — runs its real code
/// against real wire types. That is deliberate: a demo built by faking the
/// STORES instead would exercise none of the app's actual behaviour, and
/// would drift silently the moment the protocol changed. Here, a protocol
/// change that breaks the demo breaks the build.
///
/// Nothing here touches the Keychain, UserDefaults, or the network.
@MainActor
final class DemoResponder {
    /// Sends one JSON frame back up into `ConnectionService.handleMessage`.
    private let emit: (String) -> Void

    /// The name shown wherever the paired Mac's name would be. Says "Demo"
    /// out loud — the demo must never be mistakable for a real paired Mac.
    static let macName = "Demo Mac"

    init(emit: @escaping (String) -> Void) {
        self.emit = emit
    }

    // MARK: — Mutable demo state
    //
    // Not constants: toggling a task, starting the loop, or creating an
    // explorer session has to actually change what the next snapshot says,
    // or the demo falls apart the moment a reviewer taps twice.

    private var autoTasksEnabled: [String: Bool] = [
        "meetingNotes": true, "codeReview": true, "docSync": false, "loopEngineering": true,
    ]
    private var masterEnabled = true
    private var loopRunning = false
    private var loopIteration = 0
    private var loopLog: [String] = [
        "[stage 1/5] plan-structure-index — ok (2.1s)",
        "[stage 2/5] regression sweep — 676 tests, 0 failures (48.3s)",
        "[stage 3/5] build — ok (31.7s)",
    ]
    private var exploreSessions: [ExploreSessionSummary] = [
        .init(id: "demo-s1", title: "Caption scraper timing", lastUsedAt: Date().addingTimeInterval(-3_600).timeIntervalSince1970),
        .init(id: "demo-s2", title: "Where does dispatch pick a provider?", lastUsedAt: Date().addingTimeInterval(-86_400).timeIntervalSince1970),
        .init(id: "demo-s3", title: "Add a migration", lastUsedAt: Date().addingTimeInterval(-172_800).timeIntervalSince1970),
    ]
    private var exploreHistories: [String: [ChatTurn]] = [
        "demo-s1": [
            .init(role: "user", content: "Why is SCRAPE_INTERVAL_MS 800?"),
            .init(role: "assistant", content: "It is the caption poll cadence in `extension/src/content/caption-scraper.ts`. Faster polling duplicated in-progress captions; slower dropped short ones like `はい。` entirely, because the platform replaces the node before the next snapshot."),
        ],
        "demo-s2": [
            .init(role: "user", content: "Where does dispatch pick a provider?"),
            .init(role: "assistant", content: "`extension/providers/dispatch.mjs`. It resolves three different notions of \"provider\" — the model vendor, the CLI binary, and the per-user custom entry addressed as `custom:<uuid>` — then hands off to the CLI spawn layer."),
        ],
    ]

    // MARK: — Inbound dispatch

    /// Handle one outbound frame and emit whatever the Mac would have replied.
    /// Unknown types are ignored, exactly as an older Mac would ignore a frame
    /// it does not implement.
    func handle(_ json: String) {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {
        case MobileProtocol.Tag.pairing:
            // The demo "pairs" instantly, and issues NO token: a token would be
            // written to the Keychain and would let a later launch try to
            // reconnect to a Mac that does not exist.
            send(Connected(deviceName: Self.macName, token: nil, deviceId: nil))

        case MobileProtocol.Tag.heartbeat:
            sendRaw(["type": MobileProtocol.Tag.heartbeatAck])

        case MobileProtocol.Tag.macStatusList:
            send(macStatus())

        // MARK: llm-ide chat
        case MobileProtocol.Tag.llmIdeChat:
            guard let commandId = obj["commandId"] as? String else { return }
            stream(commandId: commandId, reply: Self.reply(to: obj["text"] as? String ?? ""))

        case MobileProtocol.Tag.llmIdeChatHistoryList:
            send(LlmIdeChatHistoryReply(messages: [
                .init(role: "user", content: "What changed on main today?"),
                .init(role: "assistant", content: "Four commits, all from the planning train:\n\n- `fix(mac)` — re-seed the project after the kit arrives\n- `feat(server)` — read templates and commands from `doc/` and `vis/`\n- `feat(mac)` — return to Auto mode when work finishes\n- `feat(agent)` — treat the plan's write step as a stage"),
            ]))

        case MobileProtocol.Tag.llmIdeChatHistoryClear:
            send(LlmIdeChatHistoryClearAck(ok: true))

        case MobileProtocol.Tag.llmIdeCancel, MobileProtocol.Tag.exploreCancel:
            break   // nothing in flight that a cancel could reach

        // MARK: Explorer
        case MobileProtocol.Tag.exploreListSessions:
            send(ExploreSessionList(sessions: exploreSessions))

        case MobileProtocol.Tag.exploreLoadSession:
            guard let id = obj["sessionId"] as? String else { return }
            let title = exploreSessions.first { $0.id == id }?.title ?? "Session"
            send(ExploreSessionHistory(sessionId: id, title: title, history: exploreHistories[id] ?? []))

        case MobileProtocol.Tag.exploreNewSession:
            let id = "demo-\(UUID().uuidString.prefix(8))"
            exploreSessions.insert(.init(id: id, title: "New session", lastUsedAt: Date().timeIntervalSince1970), at: 0)
            exploreHistories[id] = []
            send(ExploreSessionCreated(sessionId: id))
            send(ExploreSessionList(sessions: exploreSessions))

        case MobileProtocol.Tag.exploreDeleteSession:
            guard let id = obj["sessionId"] as? String else { return }
            exploreSessions.removeAll { $0.id == id }
            exploreHistories[id] = nil
            send(ExploreSessionList(sessions: exploreSessions))

        case MobileProtocol.Tag.exploreRenameSession:
            guard let id = obj["sessionId"] as? String, let title = obj["title"] as? String else { return }
            if let i = exploreSessions.firstIndex(where: { $0.id == id }) {
                exploreSessions[i] = .init(id: id, title: title, lastUsedAt: exploreSessions[i].lastUsedAt)
            }
            send(ExploreSessionRenamed(sessionId: id, title: title))
            send(ExploreSessionList(sessions: exploreSessions))

        case MobileProtocol.Tag.exploreChat:
            guard let commandId = obj["commandId"] as? String else { return }
            stream(commandId: commandId, reply: Self.reply(to: obj["text"] as? String ?? ""))

        case MobileProtocol.Tag.exploreSearchFiles:
            let query = (obj["query"] as? String ?? "").lowercased()
            let all = [
                ExploreWorkspaceEntry(path: "extension/server.mjs", name: "server.mjs", isDirectory: false),
                ExploreWorkspaceEntry(path: "extension/routes/router.mjs", name: "router.mjs", isDirectory: false),
                ExploreWorkspaceEntry(path: "extension/kb/db.mjs", name: "db.mjs", isDirectory: false),
                ExploreWorkspaceEntry(path: "extension/src/content/caption-scraper.ts", name: "caption-scraper.ts", isDirectory: false),
                ExploreWorkspaceEntry(path: "mac/Sources/LlmIdeMac", name: "LlmIdeMac", isDirectory: true),
            ]
            send(ExploreSearchReply(
                workspaceRoot: "~/llm-ide",
                matches: query.isEmpty ? all : all.filter { $0.name.lowercased().contains(query) || $0.path.lowercased().contains(query) },
                error: nil))

        case MobileProtocol.Tag.exploreSearchSkills:
            send(ExploreSkillListReply(matches: [
                .init(id: "skills/writing-plans", name: "writing-plans", description: "Turn a spec into a step-by-step implementation plan.", kind: "library", directive: nil),
                .init(id: "skills/systematic-debugging", name: "systematic-debugging", description: "Work a bug from symptom to root cause before proposing a fix.", kind: "library", directive: nil),
                .init(id: "skill:review", name: "code-review", description: "Review the current diff for correctness and simplification.", kind: "builtin", directive: "/review"),
            ], error: nil))

        // MARK: Auto Tasks
        case MobileProtocol.Tag.autoTaskList:
            send(autoTaskState())

        case MobileProtocol.Tag.autoTaskToggle:
            let enabled = obj["enabled"] as? Bool ?? false
            if let task = obj["task"] as? String {
                autoTasksEnabled[task] = enabled
            } else {
                masterEnabled = enabled          // nil task = the master switch
            }
            send(AutoTaskAck(ok: true, message: nil))
            send(autoTaskState())

        case MobileProtocol.Tag.autoTaskRun:
            send(AutoTaskAck(ok: true, message: "Started in demo mode — no work is actually run."))
            send(autoTaskState())

        case MobileProtocol.Tag.autoTaskStop:
            send(AutoTaskAck(ok: true, message: nil))
            send(autoTaskState())

        case MobileProtocol.Tag.autoTaskHistory:
            send(AutoTaskHistoryReply(entries: [
                .init(actionText: "Re-seed the project after the skills kit lands", status: "implemented", lastUpdated: Date().addingTimeInterval(-5_400).timeIntervalSince1970),
                .init(actionText: "Read doc templates from the doc/ folder", status: "implemented", lastUpdated: Date().addingTimeInterval(-9_000).timeIntervalSince1970),
                .init(actionText: "Return to Auto mode when a run finishes", status: "created", lastUpdated: Date().addingTimeInterval(-12_600).timeIntervalSince1970),
            ]))

        case MobileProtocol.Tag.autoTaskLogsList:
            send(AutoTaskLogsReply(currentTask: nil, tasks: [
                .init(id: "codeReview", label: "Code Review", lines: [
                    logLine("Scanning changed files on main", ago: 300),
                    logLine("12 files changed, 4 reviewed", ago: 280),
                    logLine("No blocking findings", ago: 240),
                ]),
                .init(id: "meetingNotes", label: "Meeting Notes", lines: [
                    logLine("No new meetings since last run", ago: 1_800),
                ]),
            ]))

        case MobileProtocol.Tag.autoTaskSetupList:
            send(AutoTaskSetupReply(
                hasProject: true,
                projectName: "llm-ide",
                templates: [
                    .init(id: "t-review", name: "Code review", body: "Review the current diff for correctness bugs and simplification opportunities."),
                    .init(id: "t-notes", name: "Meeting notes", body: "Summarise the transcript into decisions, actions, and open questions."),
                ],
                configs: [
                    .init(taskId: "codeReview", inputPath: "src/", outputPath: "llm-doc/reviews/", skillName: "requesting-code-review", templateId: "t-review"),
                ],
                skills: [
                    .init(name: "requesting-code-review", description: "Verify work meets requirements before merging."),
                    .init(name: "writing-plans", description: "Turn a spec into a step-by-step plan."),
                ],
                folders: ["src/", "docs/", "llm-doc/", "llm-doc/reviews/"]))

        // MARK: Loop
        case MobileProtocol.Tag.loopStatusList:
            send(loopState())

        case MobileProtocol.Tag.loopStart, MobileProtocol.Tag.loopStartStage:
            guard !loopRunning else {
                send(LoopAck(accepted: false, message: "A run is already in flight."))
                return
            }
            send(LoopAck(accepted: true, message: "Started"))
            runDemoLoop(singleStage: type == MobileProtocol.Tag.loopStartStage)

        case MobileProtocol.Tag.loopStop:
            loopRunning = false
            loopLog.append("[stopped] run cancelled from iPhone")
            send(LoopAck(accepted: true, message: "Stopped"))
            send(loopState())

        case MobileProtocol.Tag.loopHistory:
            send(LoopHistoryReply(runs: [
                .init(id: "r-3", startedAt: Date().addingTimeInterval(-7_200).timeIntervalSince1970, durationSeconds: 412, iterationsUsed: 2, statusCode: "success", statusSummary: "All stages green", trigger: "phone"),
                .init(id: "r-2", startedAt: Date().addingTimeInterval(-93_600).timeIntervalSince1970, durationSeconds: 903, iterationsUsed: 5, statusCode: "givenUp", statusSummary: "Regression sweep still failing after 5 iterations", trigger: "schedule"),
                .init(id: "r-1", startedAt: Date().addingTimeInterval(-180_000).timeIntervalSince1970, durationSeconds: 268, iterationsUsed: 1, statusCode: "success", statusSummary: "All stages green", trigger: "desktop"),
            ]))

        default:
            break
        }
    }

    // MARK: — Snapshots

    private func macStatus() -> MacStatus {
        MacStatus(projectName: "llm-ide", gitBranch: "main", workspacePath: "~/llm-ide",
                  backendUp: true, mobileControlUp: true)
    }

    private func autoTaskState() -> AutoTaskState {
        AutoTaskState(
            masterEnabled: masterEnabled,
            isRunning: false,
            currentTask: nil,
            currentStep: nil,
            statusMessage: "Demo data — nothing is scheduled or run.",
            lastRunDate: Date().addingTimeInterval(-5_400).timeIntervalSince1970,
            createdCount: 9, implementedCount: 7, failedCount: 1,
            tasks: [
                .init(id: "meetingNotes", label: "Meeting Notes", enabled: autoTasksEnabled["meetingNotes"] ?? true, lastError: nil),
                .init(id: "codeReview", label: "Code Review", enabled: autoTasksEnabled["codeReview"] ?? true, lastError: nil),
                .init(id: "docSync", label: "Doc Sync", enabled: autoTasksEnabled["docSync"] ?? false, lastError: "Last run: no docs/ folder in this project"),
                .init(id: "loopEngineering", label: "Loop", enabled: autoTasksEnabled["loopEngineering"] ?? true, lastError: nil),
            ])
    }

    private func loopState() -> LoopState {
        LoopState(
            configured: true,
            projectName: "llm-ide",
            running: loopRunning,
            startedHere: loopRunning,
            iteration: loopIteration,
            maxIterations: 5,
            logTail: loopLog.suffix(40).map { $0 },
            lastStatusSummary: loopRunning ? nil : "All stages green",
            lastFinishedAt: loopRunning ? nil : Date().addingTimeInterval(-7_200).timeIntervalSince1970,
            stages: [
                .init(name: "Plan structure index", kind: "skillRun", severity: "blocking", enabled: true, order: 0, stageId: "st-1"),
                .init(name: "Regression sweep", kind: "regressionSweep", severity: "blocking", enabled: true, order: 1, stageId: "st-2"),
                .init(name: "Build", kind: "shellCommand", severity: "blocking", enabled: true, order: 2, stageId: "st-3"),
                .init(name: "Lint", kind: "shellCommand", severity: "warning", enabled: true, order: 3, stageId: "st-4"),
                .init(name: "Docs check", kind: "shellCommand", severity: "warning", enabled: false, order: 4, stageId: "st-5"),
            ],
            queuedCount: 0)
    }

    private func logLine(_ text: String, ago: TimeInterval) -> AutoTaskLogLine {
        AutoTaskLogLine(id: UUID().uuidString,
                        timestamp: Date().addingTimeInterval(-ago).timeIntervalSince1970,
                        level: "info", text: text)
    }

    // MARK: — Scripted activity

    /// Walk the loop through a few stages so Start/Stop and the live log are
    /// actually exercised, then land on a finished run.
    private func runDemoLoop(singleStage: Bool) {
        loopRunning = true
        loopIteration = 1
        loopLog = ["[run] started from iPhone (demo)"]
        send(loopState())

        let steps = singleStage
            ? ["[stage] regression sweep — running…", "[stage] regression sweep — 676 tests, 0 failures (48.3s)"]
            : ["[stage 1/5] plan-structure-index — ok (2.1s)",
               "[stage 2/5] regression sweep — running…",
               "[stage 2/5] regression sweep — 676 tests, 0 failures (48.3s)",
               "[stage 3/5] build — ok (31.7s)",
               "[stage 4/5] lint — ok (4.9s)"]

        Task { [weak self] in
            for step in steps {
                try? await Task.sleep(nanoseconds: 900_000_000)
                guard let self, self.loopRunning else { return }   // Stop was tapped
                self.loopLog.append(step)
                self.send(self.loopState())
            }
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard let self, self.loopRunning else { return }
            self.loopRunning = false
            self.loopLog.append("[done] all stages green")
            self.send(self.loopState())
        }
    }

    /// Stream a reply the way the Mac streams a real one — chunked `output`
    /// frames, then a final `done`. This exercises the stores' actual
    /// streaming path rather than dropping a finished string in.
    private func stream(commandId: String, reply: String) {
        let chunks = Self.chunk(reply)
        Task { [weak self] in
            for chunk in chunks {
                try? await Task.sleep(nanoseconds: 45_000_000)
                guard let self else { return }
                self.send(Output(commandId: commandId, payload: .init(stream: chunk, done: false)))
            }
            guard let self else { return }
            self.send(Output(commandId: commandId, payload: .init(stream: nil, done: true)))
        }
    }

    /// Split on words, keeping the separators, so the reply arrives in
    /// token-sized pieces like a real model stream.
    private static func chunk(_ text: String) -> [String] {
        var out: [String] = []
        var current = ""
        for ch in text {
            current.append(ch)
            if ch == " " || ch == "\n" {
                out.append(current)
                current = ""
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// Canned answers. Keyword-matched so a reviewer typing something
    /// plausible gets a relevant reply rather than the same paragraph every
    /// time — and every answer says it is demo data.
    private static func reply(to text: String) -> String {
        let t = text.lowercased()
        if t.contains("test") || t.contains("regression") {
            return "**Demo reply.** The regression gate is `make regression`. It runs the extension's Node tests, the Mac build, and the docs check. On the Mac this would run for real and stream back here as it went."
        }
        if t.contains("bug") || t.contains("fix") || t.contains("error") {
            return "**Demo reply.** I would start from `docs/explanation/invariants.md` — each invariant there maps to a past regression, so the fix usually belongs next to whichever one the symptom touches.\n\nPair this app with your Mac to ask this against your actual code."
        }
        if t.contains("plan") {
            return "**Demo reply.** Planning runs the `writing-plans` skill on the Mac, which consolidates into `llm-doc/plans/INDEX.md`. You would see each stage stream in here as it completed."
        }
        if t.contains("hello") || t.contains("hi") || t.contains("test message") {
            return "**Demo reply.** You are in demo mode, so this reply is canned — nothing left your phone. Pair with a Mac running LLM-IDE and this same screen talks to Claude on your machine, with your repo in context."
        }
        return "**Demo reply.** In demo mode the app runs against sample data, so every answer here is canned and nothing leaves your phone.\n\nPaired with a Mac running LLM-IDE, this screen sends your message to the agent on that machine — with your repo, your skills, and your auto tasks in context — and streams the answer back."
    }

    // MARK: — Emit

    private func send<T: Encodable>(_ value: T) {
        guard let data = try? JSONEncoder().encode(value),
              let str = String(data: data, encoding: .utf8) else { return }
        emit(str)
    }

    private func sendRaw(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        emit(str)
    }
}
