import Foundation

/// Extracts a numeric failure count from a test runner's output.
///
/// Why the loop needs this: without a score, `LoopEngineRunner` can only ask
/// "is this failure byte-identical to the last one?" (`LoopEngineRunner.hash`).
/// That cannot tell "7 failures → 3 failures" (real progress, keep going) apart
/// from "7 failures → 7 different failures" (thrashing, stop) — both look like
/// "a different failure". A monotonically shrinking count is the canonical
/// evidence a repair is working, so the loop steers on it when it can, and the
/// repair prompt quotes it back to the agent as evidence.
///
/// Returns `nil` for output this parser does not recognise. `nil` is a
/// first-class answer, not a failure: the runner falls back to hash comparison,
/// which is exactly today's behaviour, so an unrecognised runner is never made
/// worse by this existing.
public enum StageOutputParser {
    /// One recognised runner: the regex, and which capture group holds the
    /// failure count.
    private struct Pattern {
        let regex: String
        let group: Int
    }

    /// XCTest: "Executed 12 tests, with 3 failures (0 unexpected) in 0.5 seconds"
    /// (with skips: "…, with 1 test skipped and 3 failures"). XCTest prints one
    /// such line PER SUITE; only the one right after the run-wide
    /// "Test Suite 'All tests' / 'Selected tests' passed|failed" header is the
    /// total. A per-suite line is never used as the score: when the run
    /// crashed (or the total was elided) the count is UNKNOWN, not partial.
    private static let xctestLine =
        #"Executed \d+ tests?, with (?:\d+ tests? skipped and )?(\d+) failures?"#
    private static let xctestTotal =
        #"Test Suite '(?:All|Selected) tests' (?:passed|failed)[^\n]*\n\s*"# + xctestLine
    /// swift-testing: "✘ Test run with 12 tests [in 3 suites] failed after 0.5
    /// seconds with 3 issues." and, on success, "... passed after ...".
    private static let swiftTestingFailed =
        #"Test run with \d+ tests?(?: in \d+ suites?)? failed after .*? with (\d+) issues?"#
    private static let swiftTestingPassed =
        #"Test run with \d+ tests?(?: in \d+ suites?)? passed after"#

    /// Other runners, ordered most-specific first. Every pattern is anchored on
    /// wording that only appears in that runner's summary line.
    private static let patterns: [Pattern] = [
        // node --test TAP summary: "# fail 3"
        Pattern(regex: #"(?m)^#\s*fail\s+(\d+)\s*$"#, group: 1),
        // pytest: "=== 3 failed, 9 passed in 1.2s ==="
        Pattern(regex: #"(\d+) failed"#, group: 1),
        // jest: "Tests:  3 failed, 9 passed, 12 total"
        Pattern(regex: #"Tests:\s+(\d+) failed"#, group: 1),
        // go test: "FAIL\tpkg/foo\t0.5s" — no count in the output, so each
        // failing package line counts as one.
        Pattern(regex: #"(?m)^--- FAIL: "#, group: 0)
    ]

    /// The number of failing tests in `output`, or `nil` when unrecognised.
    ///
    /// A recognised runner reporting zero failures returns `0` (distinct from
    /// `nil`): a stage that exits non-zero while reporting `0 failures` failed
    /// for some other reason — a compile error, a crash — and the loop should
    /// know the count is genuinely zero rather than unknown.
    ///
    /// `swift test` runs XCTest AND swift-testing and prints a summary for
    /// each; when both are present the failures are their SUM (returning the
    /// XCTest number alone hid every swift-testing failure).
    ///
    /// Pure and not actor-bound: the runner calls it off the main actor on the
    /// verifier's already-capped output.
    static func parseFailureCount(_ output: String) -> Int? {
        let xctest = lastCapture(xctestTotal, group: 1, in: output)
        // XCTest ran (per-suite lines) but reported no total: a crash or an
        // elided tail. Any number would be a partial count — say "unknown".
        if xctest == nil, matchCount(xctestLine, in: output) > 0 { return nil }
        var swiftTesting = lastCapture(swiftTestingFailed, group: 1, in: output)
        if swiftTesting == nil, matchCount(swiftTestingPassed, in: output) > 0 { swiftTesting = 0 }
        if xctest != nil || swiftTesting != nil {
            return (xctest ?? 0) + (swiftTesting ?? 0)
        }
        for pattern in patterns {
            if pattern.group == 0 {
                // Counting pattern: the number of matches IS the score.
                let count = matchCount(pattern.regex, in: output)
                if count > 0 { return count }
                continue
            }
            if let value = firstCapture(pattern.regex, group: pattern.group, in: output) {
                return value
            }
        }
        return nil
    }

    /// The score the stall detector steers on: the runner's own failure count,
    /// else the number of failing test ids extracted from a failing output, so a
    /// runner with no recognised summary still distinguishes "2 failing -> 4
    /// failing" (worse) from "4 -> 2" (better). `nil` when neither is available.
    static func failureScore(_ output: String) -> Int? {
        if let count = parseFailureCount(output) { return count }
        let ids = TestFailureExtractor.extract(output).ids.count
        return ids > 0 ? ids : nil
    }

    private static func lastCapture(_ regex: String, group: Int, in text: String) -> Int? {
        guard let re = try? NSRegularExpression(pattern: regex) else { return nil }
        let matches = re.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard let match = matches.last, match.numberOfRanges > group,
              let range = Range(match.range(at: group), in: text)
        else { return nil }
        return Int(text[range])
    }

    private static func firstCapture(_ regex: String, group: Int, in text: String) -> Int? {
        guard let re = try? NSRegularExpression(pattern: regex),
              let match = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > group,
              let range = Range(match.range(at: group), in: text)
        else { return nil }
        return Int(text[range])
    }

    private static func matchCount(_ regex: String, in text: String) -> Int {
        guard let re = try? NSRegularExpression(pattern: regex) else { return 0 }
        return re.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
    }

    private static func firstStringCapture(_ regex: String, group: Int, in text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: regex),
              let match = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > group,
              let range = Range(match.range(at: group), in: text)
        else { return nil }
        return String(text[range])
    }

    /// The first `limit` lines that are error REPORTS — compiler/runner
    /// `error:` lines, `fatal error` / `Fatal error` traps, `FAIL:`-style
    /// markers — or the first non-empty lines when none are. A bare substring
    /// "error" is not enough: it matches test names (`testErrorHandling`) and
    /// "0 errors" summaries. Quoted in the repair prompt when a change stopped
    /// the tests from running, where the FIRST error is the cause.
    static func firstErrorLines(_ output: String, limit: Int = 5) -> String {
        let lines = output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let errors = lines.filter { $0.range(of: errorLinePattern, options: .regularExpression) != nil }
        return (errors.isEmpty ? lines : errors).prefix(limit).joined(separator: "\n")
    }

    private static let errorLinePattern = TestFailureExtractor.errorLinePattern

    /// The binary name a shell reported as missing, when `output` looks like an
    /// exit-127 "command not found" line. Handles both the bash/dash/sh phrasing
    /// ("/bin/sh: pytest: command not found", with or without a "line N:"
    /// segment in between) and zsh's reversed phrasing
    /// ("zsh: command not found: pytest"). Returns `nil` when neither shape is
    /// recognised, so the caller can fall back to naming the whole configured
    /// command instead of guessing.
    public static func missingCommandName(in output: String) -> String? {
        let patterns = [
            #": ([^:\n]+): command not found"#,
            #"command not found: (\S+)"#,
        ]
        for pattern in patterns {
            if let name = firstStringCapture(pattern, group: 1, in: output) {
                let trimmed = name.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    /// Why a failed stage cannot pass until the operator fixes the
    /// environment, or `nil` when the failure may be the code's.
    ///
    /// A repair agent edits files only — it has no shell, so it cannot install
    /// a missing tool or package — and sending it such a failure spends a
    /// repair "fixing" code that was never broken. Deliberately narrow: a
    /// missing module that belongs to the project itself (a top-level
    /// `name/`, `name.py`, or the `src/` layout of either), or a relative
    /// Node import, is something an edit can break and an edit can fix, so it
    /// stays `nil` and keeps going to repair.
    public static func environmentProblem(exitCode: Int32, output: String, repoRoot: URL) -> String? {
        guard exitCode != 0 else { return nil }
        // Only a real 127 — the shell's own, or make reporting a recipe's — so
        // a failing test that merely LOGS "command not found" stays a test failure.
        if exitCode == 127 || output.contains("] Error 127") {
            return missingCommandName(in: output).map { "\"\($0)\" is not installed or not on PATH" }
                ?? "a command is not installed or not on PATH"
        }
        // Anchored to the error line itself — pytest's `E   ` prefix, the
        // interpreter's own `python3: No module named x` — so a warning that
        // merely mentions a missing optional module cannot hide a real failure.
        let pythonPatterns = [
            #"(?m)^\s*(?:E\s+)?(?:ModuleNotFoundError|ImportError): No module named '([A-Za-z_][A-Za-z0-9_.]*)'"#,
            #"(?m)^\S*python[0-9.]*: No module named ([A-Za-z_][A-Za-z0-9_.]*)"#,
        ]
        if let module = pythonPatterns.lazy.compactMap({ firstStringCapture($0, group: 1, in: output) }).first,
           let top = module.split(separator: ".").first.map(String.init),
           !projectContains(top, pythonModule: true, repoRoot: repoRoot) {
            return "Python module \"\(top)\" is not installed in the environment the stage runs in"
        }
        // Runtime resolver errors only (node, ESM, jest) — a type checker's
        // `error TS2307` line starts with its file path and does not match.
        let nodePattern = #"(?m)^\s*(?:(?:Uncaught )?Error(?: \[ERR_MODULE_NOT_FOUND\])?: )?Cannot find (?:module|package) '([^']+)'"#
        if let spec = firstStringCapture(nodePattern, group: 1, in: output),
           !isProjectNodeSpecifier(spec, repoRoot: repoRoot) {
            return "Node package \"\(spec)\" is not installed (run the project's install step first)"
        }
        return nil
    }

    /// Path-alias prefixes (`@/`, `~/`, `#imports`) that always name the
    /// project's own code, never an installed package.
    private static let nodeAliasPrefixes = [".", "/", "@/", "~", "#"]

    private static func isProjectNodeSpecifier(_ spec: String, repoRoot: URL) -> Bool {
        if nodeAliasPrefixes.contains(where: { spec.hasPrefix($0) }) { return true }
        // `moduleDirectories`/`baseUrl` imports like `utils/date` name a project folder.
        guard spec.contains("/"), !spec.hasPrefix("@"),
              let first = spec.split(separator: "/").first.map(String.init) else { return false }
        return projectContains(first, pythonModule: false, repoRoot: repoRoot)
    }

    /// Folders skipped when looking one level down for a monorepo sub-project.
    private static let nonProjectFolders: Set<String> = ["node_modules", "venv", "build", "dist"]

    /// Whether `name` (a folder, or with `pythonModule` also `name.py`) exists
    /// at the repo root, under `src/`, or the same one level down — the
    /// layout of a monorepo sub-project such as `backend/myapp`.
    private static func projectContains(_ name: String, pythonModule: Bool, repoRoot: URL) -> Bool {
        let fm = FileManager.default
        let children = (try? fm.contentsOfDirectory(atPath: repoRoot.path)) ?? []
        let subprojects = children
            .filter { !$0.hasPrefix(".") && !nonProjectFolders.contains($0) }
            .map { repoRoot.appendingPathComponent($0) }
        let bases = ([repoRoot] + subprojects).flatMap { [$0, $0.appendingPathComponent("src")] }
        return bases.contains { base in
            fm.fileExists(atPath: base.appendingPathComponent(name).path)
                || (pythonModule && fm.fileExists(atPath: base.appendingPathComponent("\(name).py").path))
        }
    }

    /// The note `LoopEngineRunner` appends after "FAILED (exit N)" for a
    /// failed `.shellCommand` stage, in priority order: exit 127 (command
    /// not found) beats a recognised failure count, which beats a timeout,
    /// which beats "not recognised". Pulled out as a pure function — same
    /// reason `ChatEngine`'s pure logic lives outside the class — so it can
    /// be asserted directly (`loop-contract-lab`) against the REAL code path
    /// instead of a hand-copied string nobody can fail to match.
    ///
    /// `isUnrecognised` tells the caller whether to fire the once-per-run
    /// "this runner's output has no failure count we recognise" side effect
    /// — that part stays in the runner because it needs its own mutable
    /// per-run state, which does not belong in a pure formatter.
    public static func failureNote(exitCode: Int32, command: String, output: String,
                                   score: Int?, didTimeOut: Bool) -> (text: String, isUnrecognised: Bool) {
        if exitCode == 127 {
            // Exit 127 is the shell's own convention for "command not found" —
            // not a test failure at all. Reporting that plainly, ahead of the
            // failure-count logic below, is what turns a confusing "failure
            // count not recognised" (true, but useless — of course pytest's
            // "command not found" line has no failure count) into an
            // actionable "pytest isn't installed". This does not suppress the
            // underlying failure: the stage still fails and still repairs/gives
            // up exactly as any other failure would.
            let missing = missingCommandName(in: output) ?? command
            return (" · command not found: \"\(missing)\" is not installed or not on PATH", false)
        }
        if let score {
            return (" · \(score) failing", false)
        }
        if didTimeOut {
            // The parser was handed "stage timed out after Ns", not the
            // runner's output — blaming the runner's FORMAT here would
            // libel a format we may well recognise (XCTest's, say), and
            // would spend the once-per-run notice on a false claim,
            // suppressing the accurate one for a genuinely unparseable
            // stage later in the same run.
            return (" · timed out before reporting", false)
        }
        return (" · failure count not recognised", true)
    }
}
