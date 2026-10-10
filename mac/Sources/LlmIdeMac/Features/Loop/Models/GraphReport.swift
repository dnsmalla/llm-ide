import Foundation

/// Structural summary of the code graph (`GRAPH.md`) and the before/after rules
/// the Refactoring loop uses to judge a batch (`GRAPH-DELTA.md`).
/// Built from `GraphIndex` only, so Features/Loop never imports CodeGraph/GraphKit.
struct GraphReport: Codable, Equatable {
    var generatedAt: Date
    var commit: String?
    var graphVersion: String
    var files: Int
    var totalLoc: Int
    var filesOver500: [FileLoc]
    var cycles: [[String]]
    var topFanIn: [FileFanIn]
    var roles: [String: Int]
    var boundaryWarnings: Int?
    var counters: [String: Double]

    struct FileLoc: Codable, Equatable {
        var path: String
        var lines: Int
        init(path: String, lines: Int) { self.path = path; self.lines = lines }
    }

    struct FileFanIn: Codable, Equatable {
        var path: String
        var fanIn: Int
        init(path: String, fanIn: Int) { self.path = path; self.fanIn = fanIn }
    }

    static let over500Threshold = 500
    static let listLimit = 50
    static let cycleLimit = 25
    static let fanInLimit = 25

    /// Counters whose growth is tolerated up to 2 %; every other counter tolerates none.
    static let growthTolerantCounters: Set<String> = ["totalLoc", "avgLoc"]
    static let growthTolerance = 0.02

    static func build(from index: GraphIndex, commit: String?, boundaryWarnings: Int?) -> GraphReport {
        let paths = Set(index.files.map(\.path))
        let totalLoc = index.files.reduce(0) { $0 + $1.loc }
        let avgLoc = index.files.isEmpty ? 0 : Double(totalLoc) / Double(index.files.count)

        let over500All = index.files.filter { $0.loc > over500Threshold }
            .sorted { ($0.loc, $1.path) > ($1.loc, $0.path) }
        let filesOver500 = over500All.prefix(listLimit).map { FileLoc(path: $0.path, lines: $0.loc) }

        // Fan-in: files that import/use this one, plus files that call into it.
        var fanIns: [FileFanIn] = index.files.map { file in
            let users = Set(file.usedBy).union(index.callerFiles(of: file.path))
            return FileFanIn(path: file.path, fanIn: users.count)
        }
        fanIns.sort { ($0.fanIn, $1.path) > ($1.fanIn, $0.path) }
        let maxFanIn = fanIns.first?.fanIn ?? 0
        let topFanIn = Array(fanIns.filter { $0.fanIn > 0 }.prefix(fanInLimit))

        let cycles = findCycles(index: index, knownPaths: paths)

        var roles: [String: Int] = [:]
        for file in index.files { roles[file.role ?? "unassigned", default: 0] += 1 }

        var counters: [String: Double] = [
            "filesOver500Count": Double(over500All.count),
            "cycleCount": Double(cycles.count),
            "filesInCycles": Double(cycles.reduce(0) { $0 + $1.count }),
            "maxFanIn": Double(maxFanIn),
            "avgLoc": avgLoc,
            "totalLoc": Double(totalLoc),
        ]
        if let boundaryWarnings { counters["boundaryWarnings"] = Double(boundaryWarnings) }

        return GraphReport(
            generatedAt: Date(), commit: commit, graphVersion: index.version,
            files: index.files.count, totalLoc: totalLoc,
            filesOver500: filesOver500, cycles: cycles, topFanIn: topFanIn,
            roles: roles, boundaryWarnings: boundaryWarnings, counters: counters)
    }

    /// File-level SCCs of size >= 2 over `imports ∪ calleeFiles`. A self-loop alone is not a cycle.
    static func findCycles(index: GraphIndex, knownPaths: Set<String>) -> [[String]] {
        var adjacency: [String: [String]] = [:]
        for file in index.files {
            let targets = Set(file.imports).union(index.calleeFiles(of: file.path))
                .filter { knownPaths.contains($0) }
            adjacency[file.path] = targets.sorted()
        }
        let components = stronglyConnectedComponents(adjacency: adjacency)
        let cycles = components
            .filter { $0.count >= 2 }
            .map { $0.sorted() }
            .sorted { ($0.count, $1.first ?? "") > ($1.count, $0.first ?? "") }
        return Array(cycles.prefix(cycleLimit))
    }

    /// Tarjan's algorithm. Nodes and edges are visited in sorted order for determinism.
    static func stronglyConnectedComponents(adjacency: [String: [String]]) -> [[String]] {
        var nextIndex = 0
        var indexOf: [String: Int] = [:]
        var lowLink: [String: Int] = [:]
        var onStack: Set<String> = []
        var stack: [String] = []
        var result: [[String]] = []

        func connect(_ node: String) {
            indexOf[node] = nextIndex; lowLink[node] = nextIndex; nextIndex += 1
            stack.append(node); onStack.insert(node)
            for next in adjacency[node] ?? [] {
                if indexOf[next] == nil {
                    connect(next)
                    lowLink[node] = min(lowLink[node]!, lowLink[next]!)
                } else if onStack.contains(next) {
                    lowLink[node] = min(lowLink[node]!, indexOf[next]!)
                }
            }
            if lowLink[node] == indexOf[node] {
                var component: [String] = []
                while let top = stack.popLast() {
                    onStack.remove(top)
                    component.append(top)
                    if top == node { break }
                }
                result.append(component)
            }
        }

        for node in adjacency.keys.sorted() where indexOf[node] == nil {
            connect(node)
        }
        return result
    }

    /// `GRAPH.md`. The header format is parsed by a kit skill: keep it exact.
    func render() -> String {
        var out = "# Code graph (\(graphVersion), \(commit ?? "no-commit"), \(Self.dateString(generatedAt)))\n\n"

        out += "## Counters\n\n| Counter | Value |\n|---|---|\n"
        for key in counters.keys.sorted() {
            out += "| \(key) | \(Self.format(counters[key] ?? 0)) |\n"
        }
        out += "\nFiles: \(files)\n\n"

        out += "## Files over 500 lines\n\n"
        out += filesOver500.isEmpty ? "None.\n\n" : filesOver500.map { "- \($0.path) (\($0.lines) lines)\n" }.joined() + "\n"

        out += "## Cycles\n\n"
        if cycles.isEmpty {
            out += "None.\n\n"
        } else {
            // Members are stored sorted, so the arrows show the member order, not the
            // call order inside the cycle.
            out += cycles.map { cycle in
                (cycle + [cycle.first ?? ""]).joined(separator: " → ")
            }.map { "- \($0)\n" }.joined() + "\n"
        }

        out += "## Most depended-on files\n\n"
        out += topFanIn.isEmpty ? "None.\n\n" : topFanIn.map { "- \($0.path): fan-in \($0.fanIn)\n" }.joined() + "\n"

        out += "## Roles\n\n"
        out += roles.isEmpty ? "None.\n\n" : roles.keys.sorted().map { "- \($0): \(roles[$0] ?? 0)\n" }.joined() + "\n"

        out += """
        ## How to read

        Every counter is lower-is-better. A batch's `Expect:` line names one counter from this list.
        - filesOver500Count: files longer than 500 lines.
        - cycleCount: file-level cycles (strongly connected components of size 2 or more over imports and calls).
        - filesInCycles: files that belong to some cycle.
        - maxFanIn: the largest number of files depending on one file (imports, usages and callers).
        - avgLoc: mean lines per file. May grow by up to 2 % without counting as a regression.
        - totalLoc: total lines across all files. May grow by up to 2 % without counting as a regression.
        - boundaryWarnings: cross-feature boundary warnings from mac/Scripts/feature-boundaries.sh (llm-ide only; absent elsewhere).

        """
        return out
    }

    /// Compares two reports. Only counters present in both reports are judged for regressions.
    static func delta(before: GraphReport, after: GraphReport, expect: String?) -> GraphDelta {
        let keys = Set(before.counters.keys).union(after.counters.keys)
        var changes: [String: Double] = [:]
        for key in keys {
            changes[key] = (after.counters[key] ?? 0) - (before.counters[key] ?? 0)
        }

        var regressions: [String] = []
        for key in before.counters.keys where after.counters[key] != nil {
            let b = before.counters[key]!, a = after.counters[key]!
            let tolerance = growthTolerantCounters.contains(key) ? b * growthTolerance : 0
            if a > b + tolerance { regressions.append(key) }
        }
        regressions.sort()

        var expectedMoved: Bool?
        if let expect {
            expectedMoved = (after.counters[expect] ?? 0) < (before.counters[expect] ?? 0)
        }
        return GraphDelta(changes: changes, regressions: regressions, expectedMoved: expectedMoved)
    }

    private static func dateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func format(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }
}

/// Result of comparing two `GraphReport`s.
struct GraphDelta: Equatable {
    var changes: [String: Double]
    var regressions: [String]
    /// nil when no counter was named; otherwise true only on a strict decrease of that counter.
    var expectedMoved: Bool?

    init(changes: [String: Double], regressions: [String], expectedMoved: Bool?) {
        self.changes = changes; self.regressions = regressions; self.expectedMoved = expectedMoved
    }

    /// `GRAPH-DELTA.md`.
    func render(batchId: String?) -> String {
        var out = "# Graph delta (batch \(batchId ?? "unknown"))\n\n"
        out += "| Counter | Change |\n|---|---|\n"
        for key in changes.keys.sorted() {
            let value = changes[key] ?? 0
            let text = value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
            out += "| \(key) | \(value > 0 ? "+" : "")\(text) |\n"
        }
        out += "\nRegressions: \(regressions.isEmpty ? "none" : regressions.joined(separator: ", "))\n"
        if let expectedMoved {
            out += "Expected counter moved: \(expectedMoved ? "yes" : "no")\n"
        }
        return out
    }
}
