// High-level graph service: typed read/query over the Phase 1 GraphStorage
// layer. This is the service-tier surface other Mac-app code (and later
// service tasks) consume; it delegates all file I/O to GraphStorage and adds
// graceful degradation (never crashes on read — returns empty data / logs).
//
// Mirrors the TS service layer (Task 5 of the storage/service split). The
// `findRelatedCode` FTS search and true (re)generation are forward-looking
// placeholders landing in a later phase — `findRelatedCode` returns `[]` and
// `generateGraph` reads the existing on-disk graph (or returns an empty one)
// rather than running the scanners itself; `regenerateGraph` simply bumps the
// doc fingerprint so the auto-updater picks up a rebuild.
//
// Deviations from the original task template (forced by the real Phase 1
// types so the code compiles with no breaking changes):
//   - The "GraphData"/"GraphNode" the template names are GraphKit's `CGData`
//     and `CGNode`. They are re-used here (no aliases) to match GraphStorage
//     and the rest of the module.
//   - `CGNode` exposes `title` (not `label`), so `queryGraph` searches
//     `node.title`. `CGData` carries no `mode` field, so `mode` is not stored
//     on the returned graph (it only selects code vs. doc for future use).
//   - `GraphMode` does not exist in the module today, so a small
//     `Sendable`/`Codable` enum is declared here (`.code` / `.doc`) matching
//     the dual code/doc graph model already in `KnowledgeGraphService`.
//   - `CodeRef` already exists (`Models/Plan.swift`) with a richer shape
//     (`ref?`/`title`/`bodyExcerpt?`/`rank?`) than the template's
//     `ref/snippet/score`. It is reused as-is — the template explicitly notes
//     "CodeRef struct (if not already defined)" — so `findRelatedCode`
//     returns the existing type, avoiding a duplicate-declaration conflict.
//   - `GraphStorage` methods label their first parameter `repoRoot:`, so all
//     delegation calls pass it explicitly (the template's positional calls
//     would not compile).

import Foundation
import GraphKit

/// Which graph a `GraphService` operation targets. Matches the dual code/doc
/// graph model in `KnowledgeGraphService`. `Sendable` & `Codable` so it can
/// cross actor boundaries and round-trip alongside graph requests.
enum GraphMode: String, Sendable, Codable {
    case code
    case doc
}

/// Graph service protocol for high-level graph operations.
///
/// Conforming types must be `Sendable` (the bundled impl is an actor) so a
/// single shared instance is safe to reuse across the app.
protocol GraphService: Sendable {
    /// Read the existing on-disk graph for a repo, returning an empty graph
    /// when none exists (or when read fails). `mode` selects code vs. doc for
    /// future phases; today the on-disk `graph.json` is returned regardless.
    func generateGraph(repoRoot: URL, mode: GraphMode) async throws -> CGData

    /// Simple case-insensitive text search over node titles. Returns up to
    /// `limit` matching nodes; `[]` on read failure.
    func queryGraph(repoRoot: URL, query: String, limit: Int) async throws -> [CGNode]

    /// Find code references related to `query`. Placeholder for full FTS in a
    /// later phase — returns `[]` today. Reuses the existing `CodeRef` type.
    func findRelatedCode(repoRoot: URL, query: String, limit: Int) async throws -> [CodeRef]

    /// Mark the repo's graph for regeneration by writing a fresh doc
    /// fingerprint (the auto-updater rebuilds on the next change cycle).
    func regenerateGraph(repoRoot: URL) async throws
}

/// Graph service implementation. An actor for thread safety; all file I/O is
/// delegated to the injected `GraphStorage` (Phase 1 storage layer).
final actor GraphServiceImpl: GraphService {
    private let storage: GraphStorage

    init(storage: GraphStorage = GraphStorage()) {
        self.storage = storage
    }

    func generateGraph(repoRoot: URL, mode: GraphMode = .code) async throws -> CGData {
        do {
            // Try reading existing graph first; if it has any content, return
            // it as-is. Otherwise return an empty graph for the requested mode.
            let existing = try await storage.readGraphFile(repoRoot: repoRoot)
            if !existing.nodes.isEmpty || !existing.edges.isEmpty {
                return existing
            }
            return CGData.empty
        } catch {
            // Graceful degradation — never crash; log and return empty.
            print("Graph generation failed: \(error)")
            return CGData.empty
        }
    }

    func queryGraph(repoRoot: URL, query: String, limit: Int = 10) async throws -> [CGNode] {
        do {
            let graph = try await storage.readGraphFile(repoRoot: repoRoot)

            // Simple case-insensitive text search over node titles.
            let results = graph.nodes.filter { node in
                node.title.localizedCaseInsensitiveContains(query)
            }

            return Array(results.prefix(limit))
        } catch {
            // Graceful degradation — log and return empty rather than throw.
            print("Graph query failed: \(error)")
            return []
        }
    }

    func findRelatedCode(repoRoot: URL, query: String, limit: Int = 10) async throws -> [CodeRef] {
        // TODO: Implement full FTS search in later phases.
        return []
    }

    func regenerateGraph(repoRoot: URL) async throws {
        // Write a new fingerprint to mark the graph for regeneration; the
        // auto-updater compares this against the live doc set and rebuilds.
        try await storage.writeDocFingerprint(
            repoRoot: repoRoot, fingerprint: String(Date().timeIntervalSince1970))
    }
}
