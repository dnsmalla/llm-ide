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

/// Second-stage semantic comparison, consulted only when the fresh
/// answer differs textually from the saved one. LLM answers are
/// nondeterministic — re-asking the same question routinely produces
/// reworded prose — so exact-match alone flags false regressions on
/// nearly every run. The judge asks "same facts and conclusions?"
/// and only a semantic NO counts as a regression.
///
/// Optional by design: tests and offline runs leave it nil and get
/// the original exact-match behaviour.
protocol RegressionJudge: AnyObject {
    /// Returns true when the two answers are semantically equivalent.
    func sameMeaning(prompt: String, original: String, current: String) async throws -> Bool
}

@MainActor
final class RegressionRunner: ObservableObject {
    enum Verdict: Equatable {
        case pending
        case unchanged
        case regressed
        case repaired                 // verify failed → repaired → re-verify passed
        case repairFailed(String)     // repaired but re-verify still failing
        case needsApproval            // has a verify command not yet approved on this machine
        /// CLI / network error — surfaces in the UI as "couldn't run".
        case failed(String)           // couldn't run the check
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
        /// Working-tree paths the repair touched, for the diff-review UI.
        var repairedPaths: [String] = []
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
    private let judge: RegressionJudge?
    private let store: MemoryStore
    private let verifier: FaultVerifier?
    private let repairer: FaultRepairer?
    private let approvals: VerifyApprovalStore
    private var verifyTimeout: TimeInterval
    /// Optional handle to the app's config so completed runs can
    /// publish their summary to the menu-bar pill. Set once after
    /// init by the owning view (since @EnvironmentObject is not
    /// available in StateObject init). Tests leave it nil.
    weak var config: AppConfig?

    init(prompter: RegressionPrompter,
         judge: RegressionJudge? = nil,
         store: MemoryStore = MemoryStore(),
         verifier: FaultVerifier? = nil,
         repairer: FaultRepairer? = nil,
         approvals: VerifyApprovalStore = VerifyApprovalStore(),
         verifyTimeout: TimeInterval = 120,
         config: AppConfig? = nil) {
        self.prompter = prompter
        self.judge = judge
        self.store = store
        self.verifier = verifier
        self.repairer = repairer
        self.approvals = approvals
        self.verifyTimeout = verifyTimeout
        self.config = config
    }

    func applyTimeout(_ t: TimeInterval) { verifyTimeout = max(1, t) }

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
    func run(at repoRoot: URL, only: Set<URL>? = nil,
             autoReopen requestedAutoReopen: Bool = false,
             attemptRepair: Bool = false) async {
        guard !running else { return }
        running = true
        // Auto-reopen mutates files on disk. The exact-match verdict is a
        // heuristic; without a semantic judge to confirm textual drift is a
        // real regression, reopening would corrupt fault files on every
        // reworded LLM answer. Refuse the unsafe combination.
        let autoReopen = requestedAutoReopen && judge != nil
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
            if Task.isCancelled { appendLog(.warn, "Run cancelled"); break }
            let (url, fault) = pair
            let preview = String(fault.prompt.prefix(60))
            appendLog(.info, "[\(idx + 1)/\(fixed.count)] \(preview)")
            if let cmd = fault.verify, !cmd.isEmpty, let verifier {
                await runCommandFault(idx: idx, url: url, command: cmd,
                                      verifier: verifier, repoRoot: repoRoot,
                                      attemptRepair: attemptRepair)
            } else {
                await runAnswerCompareFault(idx: idx, fault: fault, url: url, autoReopen: autoReopen)
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

    /// Command-backed path: approve-gate → verify → (repair → re-verify).
    private func runCommandFault(idx: Int, url: URL, command: String,
                                 verifier: FaultVerifier, repoRoot: URL,
                                 attemptRepair: Bool) async {
        guard approvals.isApproved(repo: repoRoot, faultFile: url.lastPathComponent, command: command) else {
            results[idx].verdict = .needsApproval
            appendLog(.warn, "  → needs approval: \(command)")
            return
        }
        do {
            let first = try await verifier.verify(command: command, repoRoot: repoRoot, timeout: verifyTimeout)
            if first.exitCode == 0 {
                results[idx].verdict = .unchanged
                appendLog(.info, "  → verify passed")
                return
            }
            appendLog(.warn, "  → verify FAILED (exit \(first.exitCode))")
            guard attemptRepair, let repairer else {
                results[idx].verdict = .regressed
                return
            }
            appendLog(.info, "  → repairing…")
            let fault = try store.loadFault(at: url)
            try await repairer.repair(fault: fault, failureOutput: first.output, repoRoot: repoRoot)
            let second = try await verifier.verify(command: command, repoRoot: repoRoot, timeout: verifyTimeout)
            if second.exitCode == 0 {
                results[idx].verdict = .repaired
                results[idx].repairedPaths = (try? store.gitDiff(at: repoRoot).changedPaths) ?? []
                appendLog(.info, "  → repaired · re-verify passed (review diff)")
            } else {
                results[idx].verdict = .repairFailed(String(second.output.suffix(200)))
                appendLog(.error, "  → repair attempted · re-verify still failing")
            }
        } catch let e as VerifyError {
            results[idx].verdict = .failed("\(e)")
            appendLog(.error, "  → \(e)")
        } catch {
            results[idx].verdict = .failed(error.localizedDescription)
            appendLog(.error, "  → failed: \(error.localizedDescription)")
        }
    }

    /// Command-less fallback — re-ask + semantic-judge path.
    private func runAnswerCompareFault(idx: Int, fault: FaultReport, url: URL, autoReopen: Bool) async {
        do {
            let reply = try await prompter.ask(prompt: fault.prompt)
            var v = Self.verdict(originalAnswer: fault.response, currentAnswer: reply)
            if v == .regressed, let judge {
                do {
                    if try await judge.sameMeaning(prompt: fault.prompt, original: fault.response, current: reply) {
                        v = .unchanged
                        appendLog(.info, "  → reworded, semantically unchanged (judge)")
                    }
                } catch {
                    v = .failed("answers differ textually; semantic judge unavailable: \(error.localizedDescription)")
                    appendLog(.error, "  → judge unavailable — verdict undecided")
                }
            }
            results[idx].currentAnswer = reply
            results[idx].verdict = v
            if v == .regressed {
                if autoReopen, (try? store.updateFaultStatus(at: url, to: .open)) != nil {
                    results[idx].autoReopened = true
                    appendLog(.warn, "  → REGRESSED · auto-reopened")
                } else {
                    appendLog(.warn, "  → REGRESSED")
                }
            } else if v == .unchanged {
                appendLog(.info, "  → unchanged")
            }
        } catch {
            results[idx].verdict = .failed(error.localizedDescription)
            appendLog(.error, "  → failed: \(error.localizedDescription)")
        }
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

/// Production semantic judge — one constrained codeAssist call per
/// textually-drifted fault, answered YES/NO. Cheap by construction:
/// inputs are truncated and the reply is a single word, so this uses
/// the deployment's sub-model tier (LLMIDE_SUBAGENT_MODEL) via
/// tier: "subagent" instead of the full chat model.
final class CodeAssistJudge: RegressionJudge {
    enum JudgeError: LocalizedError {
        case ambiguousReply(String)
        var errorDescription: String? {
            if case .ambiguousReply(let raw) = self {
                return "judge returned neither YES nor NO: \(String(raw.prefix(80)))"
            }
            return nil
        }
    }

    let api: LlmIdeAPIClient
    /// Bound so two long answers can't blow the prompt budget.
    private static let maxAnswerChars = 4_000

    init(api: LlmIdeAPIClient) {
        self.api = api
    }

    static func buildPrompt(prompt: String, original: String, current: String) -> String {
        """
        You are comparing two answers to the same question for semantic equivalence.

        Question:
        \(String(prompt.prefix(1_000)))

        Answer A (saved when the fault was marked fixed):
        \(String(original.prefix(maxAnswerChars)))

        Answer B (fresh):
        \(String(current.prefix(maxAnswerChars)))

        Do A and B state the same key facts and conclusions? Differences in \
        wording, ordering, formatting, or level of detail do NOT matter — only \
        contradictions or missing/changed facts do. Reply with exactly one \
        word: YES or NO.
        """
    }

    /// Strict reply parsing: anything that doesn't lead with YES/NO is
    /// an error, not a guess — the runner surfaces it as .failed
    /// rather than silently picking a side.
    static func parseReply(_ raw: String) throws -> Bool {
        let head = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        if head.hasPrefix("YES") { return true }
        if head.hasPrefix("NO") { return false }
        throw JudgeError.ambiguousReply(raw)
    }

    func sameMeaning(prompt: String, original: String, current: String) async throws -> Bool {
        let resp = try await api.codeAssist(
            message: Self.buildPrompt(prompt: prompt, original: original, current: current),
            language: "en",
            model: nil,
            tier: "subagent",
            history: [],
            attachments: [],
            agentContext: nil
        )
        return try Self.parseReply(resp.reply)
    }
}
