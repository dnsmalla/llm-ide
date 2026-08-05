import Foundation

/// A single Source Connector instance: one manifest + the adapter that owns
/// its wire mechanics. Conforms to `InputSource` so the existing
/// `SourceIngestService` driver and Library classification work unchanged.
///
/// Two-phase ingest:
///   Phase 1 — `adapter.fetch` → write each item raw via `InboxStore` (the
///             engine applies the manifest `rawHeaders`), then `markSeen`.
///   Phase 2 — `InboxGenerationPipeline.run` over the inbox: noise-skip,
///             classify, write note (or skip). Dedup is by raw-file content
///             hash vs. notes already generated (`existingSourceHashes`).
@MainActor
final class SourceConnector: InputSource {
    // `manifest` and the properties derived from it below are `nonisolated`
    // — `SourceConnectorManifest` is an immutable, Sendable value type, and
    // `InputSource`'s metadata requirements (`id`, `displayName`, ...) are
    // themselves nonisolated. Without this, the class-level `@MainActor`
    // makes every member isolated by default, so the conformance would
    // cross into main-actor-isolated code and fail under Swift 6's strict
    // concurrency checking.
    nonisolated let manifest: SourceConnectorManifest
    private let adapterFactory: @MainActor () -> any SourceConnectorAdapter

    init(manifest: SourceConnectorManifest,
         adapterFactory: @MainActor @escaping () -> any SourceConnectorAdapter) {
        self.manifest = manifest
        self.adapterFactory = adapterFactory
    }

    nonisolated var id: String { manifest.id }
    nonisolated var displayName: String { manifest.displayName }
    nonisolated var icon: String { manifest.icon }
    nonisolated var emptyText: String { manifest.emptyText }
    nonisolated var platforms: [String] { manifest.platforms }
    nonisolated var mode: SourceMode { manifest.mode == .liveCapture ? .liveCapture : .fetch }

    /// Eagerly create the source inbox folder and the llm-doc notes folder so
    /// both exist from the moment a connector is connected (fixes the "no
    /// folders in sources/notes" regression). Idempotent and cheap.
    func ensureSetup(at root: URL) throws {
        let inbox = root.appendingPathComponent(manifest.inboxFolder, isDirectory: true)
        let notes = root.appendingPathComponent("llm-doc", isDirectory: true)
            .appendingPathComponent(NoteType(manifest.noteType).directoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
    }

    @MainActor
    func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult {
        guard manifest.mode == .fetch else { return .none }
        let adapter = adapterFactory()
        let batch: SourceConnectorFetchBatch
        do {
            batch = try await adapter.fetch(ctx)
        } catch {
            return .failure(error.localizedDescription, imported: 0)
        }

        let inboxRoot = ctx.sourceConnectorRoot.appendingPathComponent(manifest.inboxFolder, isDirectory: true)
        for item in batch.items {
            let headers = resolveHeaders(from: item.fields)
            let slug = InboxStore.slugify(item.fields.values.first ?? manifest.id)
            do {
                _ = try InboxStore(root: inboxRoot).write(headers: headers, body: item.body, slug: slug)
            } catch {
                return .failure(error.localizedDescription, imported: 0)
            }
        }
        var markSeenFailures: [String] = []
        do {
            try await adapter.markSeen(ctx, batch: batch, drained: batch.drained)
        } catch {
            markSeenFailures.append("markSeen: \(error.localizedDescription)")
        }

        // Notes land at `<sourceConnectorRoot>/llm-doc/<noteType>/` — the
        // same folder `ensureSetup` pre-created.
        let writer = SourceConnectorNoteWriter(repoRoot: ctx.sourceConnectorRoot,
                                               noteType: NoteType(manifest.noteType), platform: manifest.id)
        let knownHashes = (try? await writer.existingSourceHashes()) ?? []
        let (processed, failures) = await InboxGenerationPipeline.run(
            inboxRoot: inboxRoot, knownHashes: knownHashes) { item in
                try await Self.generateNote(item: item, writer: writer, ctx: ctx,
                                            adapter: adapter, manifest: self.manifest)
            }

        let allFailures = batch.failures + markSeenFailures + failures
        if !allFailures.isEmpty {
            return .failure(allFailures.joined(separator: "; "), imported: processed)
        }
        if processed == 0 { return .none }
        return .imported(processed, moreAvailable: batch.overCap, oversize: 0)
    }

    /// Applies the manifest's rawHeaders mapping (e.g. "Channel": "$Channel")
    /// to the fetched item's fields, plus the `Date:` convention.
    private func resolveHeaders(from fields: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        for (headerKey, token) in manifest.rawHeaders {
            if token.hasPrefix("$") {
                out[headerKey] = fields[String(token.dropFirst())] ?? ""
            } else {
                out[headerKey] = token
            }
        }
        if out["Date"] == nil, let d = fields["Date"] { out["Date"] = d }
        return out
    }

    @MainActor
    private static func generateNote(
        item: RawInboxItem, writer: SourceConnectorNoteWriter, ctx: SourceContext,
        adapter: any SourceConnectorAdapter, manifest: SourceConnectorManifest
    ) async throws {
        let text = item.body
        let minLength = manifest.noiseFilter?.minLength ?? 0
        let emojiOnly = manifest.noiseFilter?.skipEmojiOnly ?? false
        let isNoise = text.trimmingCharacters(in: .whitespacesAndNewlines).count < max(1, minLength)
            || (emojiOnly && Self.isEmojiOnly(text))
        let title = item.headers["Subject"]
            ?? item.headers.sorted(by: { $0.key < $1.key }).first?.value
            ?? manifest.displayName

        if isNoise {
            _ = try await writer.writeSkipped(headers: item.headers, title: title, date: item.date,
                                              category: "noise", originalBody: text, sourceHash: item.hash,
                                              rawFile: item.url.lastPathComponent)
            return
        }
        do {
            let req = adapter.classifyRequest(from: item)
            // Use the injected classify seam when present (tests); otherwise
            // POST through the real API client. See T9 Resolution 3.
            let c: SourceConnectorClassification
            if let classify = ctx.classify {
                c = try await classify(manifest.endpoints.classify, req.body)
            } else {
                c = try await ctx.api.postClassification(path: manifest.endpoints.classify, body: req.body)
            }
            if c.noteWorthy {
                _ = try await writer.writeNote(headers: item.headers, title: title, date: item.date,
                                               classification: c, originalBody: text, sourceHash: item.hash,
                                               rawFile: item.url.lastPathComponent)
            } else {
                _ = try await writer.writeSkipped(headers: item.headers, title: title, date: item.date,
                                                  category: c.category, originalBody: text, sourceHash: item.hash,
                                                  rawFile: item.url.lastPathComponent)
            }
        } catch {
            _ = try await writer.writeSkipped(headers: item.headers, title: title, date: item.date,
                                              category: "unclassified", originalBody: text, sourceHash: item.hash,
                                              rawFile: item.url.lastPathComponent)
        }
    }

    private static func isEmojiOnly(_ s: String) -> Bool {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        return trimmed.unicodeScalars.allSatisfy {
            $0.properties.generalCategory == .modifierSymbol
            || $0.properties.generalCategory == .otherSymbol
        }
    }
}
