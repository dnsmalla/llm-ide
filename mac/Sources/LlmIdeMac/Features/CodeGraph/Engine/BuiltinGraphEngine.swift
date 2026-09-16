#if GRAPHKIT_BUILTIN
import Foundation
import GraphCore
import GraphKit

/// The compiled-in graph engine: a thin adapter over the vendored `GraphKit`
/// producers.
///
/// **This is the only file in the app that imports `GraphKit`.** Removing the
/// `graph-kit` package from `mac/Package.swift` makes `canImport(GraphKit)`
/// false, this whole file compiles away, and `GraphEngineRegistry` falls back to
/// a plugin-provided engine (or reports that none is installed). Nothing else
/// has to change — which is the property the whole `GraphCore`/`GraphKit` split
/// exists to guarantee, and it is verifiable by deleting that one line and
/// building.
///
/// Keep this file an adapter. Any real logic added here becomes logic the app
/// loses when the engine is unplugged, so it belongs either in `GraphKit`
/// (production) or in `GraphCore` (model, layout, shared conventions).
public struct BuiltinGraphEngine: GraphEngine {

    public let identifier = "builtin"
    public let displayName = "Built-in (GraphKit)"
    public var supportedDocExtensions: Set<String> { MemoryGenerator.supportedExtensions }

    // MARK: - Code → graph

    public func scanCode(repoRoot: URL) async throws -> CodeScan {
        let incremental = await StructureScanner(launcher: SystemProcessLauncher())
            .scanIncremental(repoRoot: repoRoot)
        let graph = StructureGraphBuilder.build(incremental.result, repoRoot: repoRoot)
        // "md is doc": the code scanner also ingests markdown as `.docPage`
        // nodes. Leaving them in double-counts every document once the two
        // tracks are merged, so they are stripped here — the engine owns this
        // because it is the engine that chose to emit them.
        return CodeScan(graph: FileClassifier.strippingDocNodes(from: graph),
                        scan: incremental.result,
                        changedPaths: incremental.changedPaths,
                        totalFiles: incremental.totalFiles,
                        reusedFiles: incremental.reusedFiles,
                        // This scanner enumerates the repository itself, so an
                        // empty result really does mean "no code files here".
                        reportsSymbols: true)
    }

    // MARK: - Docs → graph

    public func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory {
        await Task.detached(priority: .userInitiated) {
            MemoryGenerator.generate(roots: roots)
        }.value
    }

    public func generateDocMemory(files: [URL]) async throws -> GeneratedMemory {
        await Task.detached(priority: .userInitiated) {
            MemoryGenerator.generate(files: files)
        }.value
    }

    public func docSetFingerprint(roots: [URL]) -> String {
        DocSetFingerprint.compute(roots: roots, extensions: supportedDocExtensions)
    }

    // MARK: - Join

    public func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData {
        GraphMerger.merge(code: code, doc: doc, chunks: chunks)
    }
}
#endif
