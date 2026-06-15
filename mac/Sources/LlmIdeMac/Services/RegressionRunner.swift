// Phase D driver. Iterates all `status: fixed` FaultReports under
// <repo>/.understand-anything/memory/faults/, re-asks the agent each
// question, and compares the new answer to the one saved on the
// fault. Verdicts publish via @Published so the view can stream them
// as work progresses.
//
// The agent invocation is abstracted via the RegressionPrompter
// protocol so tests can swap in a deterministic fake (and so we
// can later replace LlmIdeAPIClient without touching this file).

import Foundation

/// Minimal interface the runner needs. Production binds this to
/// `LlmIdeAPIClient.codeAssist`; tests bind a fake.
protocol RegressionPrompter: AnyObject {
    func ask(prompt: String) async throws -> String
}

@MainActor
final class RegressionRunner: ObservableObject {
    enum Verdict: Equatable {
        case pending
        case unchanged
        case regressed
        /// CLI / network error — surfaces in the UI as "couldn't run".
        case failed(String)
    }

    struct Result: Identifiable, Equatable {
        let id = UUID()
        let faultURL: URL
        let prompt: String
        let originalAnswer: String
        var currentAnswer: String?
        var verdict: Verdict
        /// True when this run flipped the fault's frontmatter from
        /// `status: fixed` back to `status: open` because the verdict
        /// came back `.regressed`. The badge in RegressionView uses
        /// this so the user can tell the auto-fix-up happened.
        var autoReopened: Bool = false
    }

    @Published private(set) var results: [Result] = []
    @Published private(set) var running: Bool = false
    @Published private(set) var log: [LogLine] = []
    /// URL of the faults registry CSV exported at the end of the last
    /// run. nil when no run has completed or the export failed (the
    /// export is best-effort and never blocks the run).
    @Published private(set) var lastCSVURL: URL?

    /// One line of streaming run output, surfaced in the Regression
    /// view's Log pane. Newest entries appended.
    struct LogLine: Identifiable, Equatable {
        enum Level: Equatable { case info, warn, error }
        let id = UUID()
        let at: Date
        let level: Level
        let text: String
    }

    func clearLog() { log.removeAll() }

    private let prompter: RegressionPrompter
    private let store: MemoryStore
    /// Optional handle to the app's config so completed runs can
    /// publish their summary to the menu-bar pill. Set once after
    /// init by the owning view (since @EnvironmentObject is not
    /// available in StateObject init). Tests leave it nil.
    weak var config: AppConfig?

    init(prompter: RegressionPrompter,
         store: MemoryStore = MemoryStore(),
         config: AppConfig? = nil) {
        self.prompter = prompter
        self.store = store
        self.config = config
    }

    /// Execute the run. Safe to call repeatedly — resets state each
    /// call. Bails out cleanly when there are no fixed faults (or none
    /// in the `only` filter).
    ///
    /// - Parameters:
    ///   - repoRoot: repo to scan for `faults/*.md` files.
    ///   - only: when non-nil, restrict the run to faults whose URL
    ///     appears in the set. When nil, every `status: fixed` fault
    ///     is re-asked.
    ///   - autoReopen: when true, a `.regressed` verdict flips the
    ///     fault's frontmatter from `fixed` back to `open` on disk.
    ///     Default `false` — the verdict comparison is heuristic
    ///     (text-difference), so a run must NOT silently mutate files
    ///     unless the user explicitly opts in.
    func run(at repoRoot: URL, only: Set<URL>? = nil, autoReopen: Bool = false) async {
        running = true
        let startedAt = Date()
        defer {
            running = false
            let regressed = results.filter { $0.verdict == .regressed }.count
            config?.lastRegressionRegressedCount = regressed
            config?.lastRegressionRunAt = Date()
        }
        let urls = store.listFaults(at: repoRoot)
        // /tmp/ vs /private/tmp/ and other symlink prefixes mean URL
        // identity isn't reliable. Match by canonical filesystem path.
        let onlyPaths: Set<String>? = only.map { Set($0.map { $0.standardizedFileURL.path }) }
        let fixed: [(URL, FaultReport)] = urls.compactMap { url in
            guard let fault = try? store.loadFault(at: url) else { return nil }
            guard fault.status == .fixed else { return nil }
            if let onlyPaths,
               !onlyPaths.contains(url.standardizedFileURL.path) { return nil }
            return (url, fault)
        }
        results = fixed.map {
            Result(faultURL: $0.0,
                   prompt: $0.1.prompt,
                   originalAnswer: $0.1.response,
                   currentAnswer: nil,
                   verdict: .pending)
        }
        let selectedNote = only == nil ? "all fixed faults" : "\(fixed.count) selected"
        appendLog(.info, "Run started · \(fixed.count) to check (\(selectedNote))")
        for (idx, pair) in fixed.enumerated() {
            let preview = String(pair.1.prompt.prefix(60))
            appendLog(.info, "[\(idx + 1)/\(fixed.count)] asking: \(preview)")
            do {
                let reply = try await prompter.ask(prompt: pair.1.prompt)
                let v = Self.verdict(originalAnswer: pair.1.response, currentAnswer: reply)
                results[idx].currentAnswer = reply
                results[idx].verdict = v
                switch v {
                case .unchanged: appendLog(.info, "  → unchanged")
                case .regressed:
                    if autoReopen, (try? store.updateFaultStatus(at: pair.0, to: .open)) != nil {
                        results[idx].autoReopened = true
                        appendLog(.warn, "  → REGRESSED · auto-reopened")
                    } else {
                        appendLog(.warn, "  → REGRESSED")
                    }
                case .pending, .failed: break
                }
            } catch {
                results[idx].verdict = .failed(error.localizedDescription)
                appendLog(.error, "  → failed: \(error.localizedDescription)")
            }
        }
        let summary = "Run complete · regressed: \(results.filter { $0.verdict == .regressed }.count) · unchanged: \(results.filter { $0.verdict == .unchanged }.count) · failed: \(results.filter { if case .failed = $0.verdict { return true }; return false }.count) · elapsed: \(String(format: "%.1fs", Date().timeIntervalSince(startedAt)))"
        appendLog(.info, summary)

        // Refresh the faults registry CSV so it always reflects the
        // post-run state. When auto-reopen is on, regressed faults were
        // flipped to `open` above and that shows here. Best-effort — a
        // failed export must not fail the run.
        lastCSVURL = try? store.exportFaultsCSV(at: repoRoot)
    }

    private func appendLog(_ level: LogLine.Level, _ text: String) {
        log.append(LogLine(at: Date(), level: level, text: text))
    }

    /// Exact-match comparison after normalising runs of whitespace
    /// (incl. newlines/tabs) to single spaces and trimming the ends.
    /// Cosmetic re-flow doesn't count as regression; semantic edits
    /// do.
    static func verdict(originalAnswer: String, currentAnswer: String) -> Verdict {
        if normalise(originalAnswer) == normalise(currentAnswer) {
            return .unchanged
        }
        return .regressed
    }

    private static func normalise(_ s: String) -> String {
        let parts = s.split(whereSeparator: { $0.isWhitespace })
        return parts.joined(separator: " ")
    }
}

/// Production adapter — binds the protocol to LlmIdeAPIClient.
/// Lives next to the runner so callers don't reach into the API
/// surface directly.
final class CodeAssistPrompter: RegressionPrompter {
    let api: LlmIdeAPIClient
    let language: String
    let model: String?
    let agent: String

    init(api: LlmIdeAPIClient, language: String = "en",
         model: String? = nil, agent: String = "claude_code") {
        self.api = api
        self.language = language
        self.model = model
        self.agent = agent
    }

    func ask(prompt: String) async throws -> String {
        let resp = try await api.codeAssist(
            message: prompt,
            language: language,
            model: model,
            history: [],
            attachments: [],
            agentContext: nil
        )
        return resp.reply
    }
}
