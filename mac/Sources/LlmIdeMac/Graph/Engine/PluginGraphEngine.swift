import Foundation
import GraphCore
import os

/// A graph engine supplied by an installed plugin, driven as a subprocess that
/// writes canonical graph JSON.
///
/// This is what makes the engine genuinely removable at runtime rather than
/// only at build time: the app spawns whatever the plugin declared and decodes
/// the result through `GraphDocument`, the same Codable contract
/// `graph-kit/schema/graph.schema.json` already validates. The plugin's
/// implementation language is invisible here.
///
/// The app already shells out this way elsewhere — `CodeNotes/AnalyzePhase`
/// takes a `cliExecutable: URL`, and the code scanner spawns Python — so this
/// introduces no new class of dependency.
public struct PluginGraphEngine: GraphEngine {

    let manifest: GraphEngineManifest
    /// The plugin's directory; relative executables and outputs resolve here.
    let root: URL

    private static let log = Logger(subsystem: "com.llmide.macapp",
                                    category: "PluginGraphEngine")

    public var identifier: String { manifest.name }
    public var displayName: String { manifest.displayName ?? manifest.name }
    public var supportedDocExtensions: Set<String> { manifest.resolvedDocExtensions }

    // MARK: - GraphEngine

    public func scanCode(repoRoot: URL) async throws -> CodeScan {
        let document = try await runProducing(
            manifest.commands.scanCode,
            substitutions: ["{repo}": repoRoot.path],
            label: "scanCode")
        // A plugin reports the graph; the raw symbol scan is optional in the
        // wire format, so a plugin that only emits a graph yields an empty
        // `scan`. Consumers that need symbols (the code-notes writer) degrade
        // to writing nothing rather than to writing something wrong.
        // `totalFiles` counts FILES. It previously reported `nodes.count`,
        // conflating symbols with files; a plugin that reports no symbol scan
        // cannot know the file count, so count file nodes rather than guess.
        let fileCount = document.nodes.filter { $0.kind == .file }.count
        return CodeScan(graph: document.graph, scan: .empty,
                        changedPaths: Set(document.changedPaths ?? []),
                        totalFiles: fileCount,
                        // The wire format carries a graph, not a symbol
                        // inventory, so this scan can never authorise deleting
                        // what an authoritative scan wrote.
                        reportsSymbols: false)
    }

    public func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory {
        try await docMemory(paths: roots, label: "docMemory")
    }

    public func generateDocMemory(files: [URL]) async throws -> GeneratedMemory {
        try await docMemory(paths: files, label: "docMemory(files)")
    }

    /// Run the plugin's `docMemory` command over `paths`.
    ///
    /// A command written with `{root}` (singular) is invoked **once per path**
    /// and the results are unioned; one written with `{roots}` is invoked once
    /// with the whole list joined by the path-list separator.
    ///
    /// Both forms exist because real CLIs take a single directory argument —
    /// graph-kit's own is `graph-kit memory <dir>`. Offering only `{roots}`
    /// meant the reference manifest was handed `a:b:c` as one directory, which
    /// could never work; and a path legitimately containing a colon (allowed on
    /// APFS) corrupts the joined list even for a plugin that does split it.
    private func docMemory(paths: [URL], label: String) async throws -> GeneratedMemory {
        let command = manifest.commands.docMemory
        let perPath = command.args.contains { $0.contains("{root}") }
        guard perPath else {
            let joined = paths.map(\.path).joined(separator: ":")
            let document = try await runProducing(
                command, substitutions: ["{roots}": joined], label: label)
            return GeneratedMemory(graph: document.graph,
                                   chunks: document.chunks ?? [],
                                   docCount: document.docCount ?? paths.count)
        }

        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        var chunks: [MemoryChunk] = []
        var docCount = 0
        var seen = Set<String>()
        for path in paths {
            let document = try await runProducing(
                command, substitutions: ["{root}": path.path], label: label)
            let graph = document.graph
            for node in graph.nodes where seen.insert(node.id).inserted {
                nodes.append(node)
            }
            edges.append(contentsOf: graph.edges)
            chunks.append(contentsOf: document.chunks ?? [])
            docCount += document.docCount ?? 0
        }
        return GeneratedMemory(graph: CGData(nodes: nodes, edges: edges),
                               chunks: chunks, docCount: docCount)
    }

    public func docSetFingerprint(roots: [URL]) -> String {
        // Computed locally rather than by asking the plugin: it must be cheap
        // enough to run on a timer tick, and spawning a process for it would
        // defeat the point. The shared walk honours this engine's declared
        // document extensions, which is the same rule the builtin follows.
        DocSetFingerprint.compute(roots: roots, extensions: supportedDocExtensions)
    }

    /// Join the two tracks.
    ///
    /// When the plugin declares no `merge` command the result is a plain union:
    /// every node and edge from both sides, with **no doc→code cross-links**.
    /// That is a real reduction in capability, not a silent equivalence —
    /// cross-linking needs the engine's own resolution rules — so it is logged
    /// rather than passed off as a full merge.
    public func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData {
        guard let command = manifest.commands.merge else {
            Self.log.notice("""
                \(identifier, privacy: .public) declares no merge command — \
                unioning tracks without doc→code cross-links
                """)
            return union(code: code, doc: doc)
        }

        let workspace = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: workspace) }
        let codeURL = workspace.appendingPathComponent("code.json")
        let docURL = workspace.appendingPathComponent("doc.json")
        let chunksURL = workspace.appendingPathComponent("chunks.json")
        let encoder = JSONEncoder()
        try encoder.encode(GraphDocument(code)).write(to: codeURL, options: .atomic)
        try encoder.encode(GraphDocument(doc)).write(to: docURL, options: .atomic)
        try encoder.encode(chunks).write(to: chunksURL, options: .atomic)

        let document = try await runProducing(
            command,
            substitutions: ["{code}": codeURL.path,
                            "{doc}": docURL.path,
                            "{chunks}": chunksURL.path],
            label: "merge",
            workspace: workspace)
        return document.graph
    }

    private func union(code: CGData, doc: CGData) -> CGData {
        var nodes: [CGNode] = []
        var seen = Set<String>()
        for node in code.nodes + doc.nodes where seen.insert(node.id).inserted {
            nodes.append(node)
        }
        // Dedupe edges too. `CGEdge` has no identity, so a repeated
        // (from, to, kind) triple is drawn twice on top of itself and
        // double-counted by every degree calculation.
        var edges: [CGEdge] = []
        var seenEdges = Set<String>()
        for edge in code.edges + doc.edges
        where seenEdges.insert("\(edge.fromId)\u{1}\(edge.toId)\u{1}\(edge.kind.rawValue)").inserted {
            edges.append(edge)
        }
        return CGData(nodes: nodes, edges: edges,
                      layers: code.layers + doc.layers,
                      tour: code.tour + doc.tour)
    }

    // MARK: - Subprocess

    /// Run one declared command and decode the canonical JSON it wrote.
    private func runProducing(_ invocation: GraphEngineManifest.Invocation,
                              substitutions: [String: String],
                              label: String,
                              workspace: URL? = nil) async throws -> EngineOutput {
        let directory = try workspace ?? temporaryDirectory()
        let ownsDirectory = workspace == nil
        defer { if ownsDirectory { try? FileManager.default.removeItem(at: directory) } }

        let outputURL = directory.appendingPathComponent("graph.json")
        var replacements = substitutions
        replacements["{out}"] = outputURL.path

        let resolved = try resolveExecutable(invocation.command)
        let substituted = invocation.args.map { argument in
            replacements.reduce(argument) { partial, pair in
                partial.replacingOccurrences(of: pair.key, with: pair.value)
            }
        }
        // A bare name runs through `/usr/bin/env`, which needs the program as
        // its FIRST ARGUMENT. Omitting it made `env` exec the script path
        // directly and the declared interpreter vanish: the reference manifest's
        // `{command: "node", args: ["…/cli.js", …]}` failed with
        // `env: …/cli.js: No such file or directory`, so every plugin using the
        // documented bare-name form could never have run.
        let executable = resolved.url
        let arguments = resolved.prependsCommand
            ? [invocation.command] + substituted
            : substituted

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        // Run inside the plugin so a relative asset path in its own command
        // resolves the way the plugin author expects.
        process.currentDirectoryURL = root
        let errorPipe = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errorPipe

        // Drain stderr CONCURRENTLY with the run. Reading it only inside the
        // termination handler deadlocked any plugin that wrote past the pipe's
        // 64 KB buffer: the plugin blocked in `write`, so it never exited, so
        // the handler never fired, and the call hung until the timeout — which
        // is clamped as high as an hour. A progress-logging scanner on a large
        // repo hits that immediately.
        let collector = StderrCollector()
        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
            } else {
                collector.append(chunk)
            }
        }

        // Clamp the timeout: a plugin must not be able to hang graph generation
        // indefinitely, nor set it so low that a large repo can never finish.
        let timeout = min(max(invocation.timeoutSeconds ?? 300, 10), 3_600)

        try await run(process, stderr: collector, timeout: timeout, label: label)

        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            throw GraphEngineUnavailable.failed(
                engine: identifier,
                reason: "\(label) wrote no graph to \(outputURL.lastPathComponent)")
        }
        do {
            let data = try Data(contentsOf: outputURL)
            return try JSONDecoder().decode(EngineOutput.self, from: data)
        } catch {
            throw GraphEngineUnavailable.failed(
                engine: identifier,
                reason: "\(label) produced JSON this app could not read: \(error)")
        }
    }

    private func run(_ process: Process, stderr: StderrCollector,
                     timeout: Int, label: String) async throws {
        let watchdogBox = WatchdogBox()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // `resume` must happen exactly once even though both the
            // termination handler and the timeout can fire.
            let settled = OSAllocatedUnfairLock(initialState: false)
            @Sendable func finish(_ result: Result<Void, Error>) {
                let alreadyDone = settled.withLock { done -> Bool in
                    if done { return true }
                    done = true
                    return false
                }
                guard !alreadyDone else { return }
                continuation.resume(with: result)
            }

            process.terminationHandler = { finished in
                watchdogBox.cancel()
                if finished.terminationStatus == 0 {
                    finish(.success(()))
                } else {
                    let message = stderr.tail(2_000)
                    finish(.failure(GraphEngineUnavailable.failed(
                        engine: identifier,
                        reason: "\(label) exited \(finished.terminationStatus)"
                            + (message.isEmpty ? "" : ": \(message)"))))
                }
            }

            do {
                try process.run()
            } catch {
                finish(.failure(GraphEngineUnavailable.failed(
                    engine: identifier,
                    reason: "could not start \(label): \(error.localizedDescription)")))
                return
            }

            // Cancelled by the termination handler, so a fast run does not leave
            // a task sleeping for up to an hour holding the process and this
            // closure. The auto-updater runs on a timer, so those accumulate.
            let watchdog = Task {
                try await Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000_000)
                guard process.isRunning else { return }
                process.terminate()
                finish(.failure(GraphEngineUnavailable.failed(
                    engine: identifier,
                    reason: "\(label) exceeded \(timeout)s and was terminated")))
            }
            watchdogBox.set(watchdog)
        }
    }

    /// Resolve a declared command to something runnable.
    ///
    /// A bare name (`node`, `python3`) goes through `/usr/bin/env` so it
    /// resolves on `PATH`, which is how the app already locates node and
    /// python; `prependsCommand` then tells the caller to pass the name as
    /// `env`'s first argument.
    ///
    /// A relative path resolves inside the plugin directory and is **confined**
    /// to it. `appendingPathComponent` alone confined nothing:
    /// `"../../../../../../bin/sh"` standardised straight to `/bin/sh`, so the
    /// old doc comment's containment claim was simply false.
    private func resolveExecutable(_ command: String) throws
        -> (url: URL, prependsCommand: Bool) {
        if command.hasPrefix("/") {
            return (URL(fileURLWithPath: command), false)
        }
        if command.contains("/") {
            // Symlinks are resolved as well as `..`: `standardizedFileURL`
            // normalises path syntax but follows nothing, so a plugin shipping
            // `bin/tool -> /bin/sh` passed both this prefix check and
            // `validate()`'s `..` rejection.
            let candidate = root.appendingPathComponent(command)
                .standardizedFileURL.resolvingSymlinksInPath()
            let base = root.standardizedFileURL.resolvingSymlinksInPath().path
            if candidate.path == base || candidate.path.hasPrefix(base + "/") {
                return (candidate, false)
            }
            // THROW — do not fall back to the `env` form. `env` execs through
            // `execvp`, which skips `PATH` for any name containing a slash and
            // resolves it relative to the working directory instead; since that
            // is the plugin root, `env ../../../../bin/sh` really did run
            // /bin/sh. The previous "env then fails to find it" reasoning was
            // simply wrong.
            throw GraphEngineUnavailable.failed(
                engine: identifier,
                reason: "command '\(command)' points outside the plugin directory")
        }
        return (URL(fileURLWithPath: "/usr/bin/env"), true)
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-graph-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

/// Thread-safe accumulator for a subprocess's stderr, drained while it runs.
private final class StderrCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        // Bounded: only the tail is ever reported, so a chatty plugin cannot
        // make the app hold an unbounded log in memory.
        data.append(chunk)
        if data.count > 64 * 1024 { data = data.suffix(64 * 1024) }
    }

    func tail(_ bytes: Int) -> String {
        lock.lock(); defer { lock.unlock() }
        return String(data: data.suffix(bytes), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

/// Holds the timeout task so the termination handler can cancel it.
private final class WatchdogBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Error>?
    /// Set when `cancel()` ran before `set()`.
    ///
    /// The watchdog is created after `process.run()`, so a child that exits in
    /// that window has its termination handler call `cancel()` while `task` is
    /// still nil — and the subsequent `set` then installed a task nobody would
    /// ever cancel, sleeping for up to the full hour cap while retaining the
    /// Process and the continuation. Recurrent, because the auto-updater runs
    /// on a timer.
    private var cancelledEarly = false

    func set(_ task: Task<Void, Error>) {
        lock.lock()
        if cancelledEarly {
            lock.unlock()
            task.cancel()
            return
        }
        self.task = task
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        let pending = task
        task = nil
        cancelledEarly = true
        lock.unlock()
        pending?.cancel()
    }
}

/// Canonical graph JSON, plus the doc-track extras a `docMemory` run adds.
///
/// Extends `GraphDocument`'s shape rather than replacing it, so a plugin that
/// only knows the published graph schema still decodes — `chunks` and
/// `docCount` are optional.
private struct EngineOutput: Decodable {
    let nodes: [CGNode]
    let edges: [CGEdge]
    let layers: [UALayer]?
    let tour: [UATourStep]?
    let chunks: [MemoryChunk]?
    let docCount: Int?
    /// Files this run re-read, when the engine tracks that.
    let changedPaths: [String]?

    var graph: CGData {
        CGData(nodes: nodes, edges: edges, layers: layers ?? [], tour: tour ?? [])
    }
}
