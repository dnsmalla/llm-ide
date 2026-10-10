import Foundation

/// The CodeGraph side of `GraphRescanning`: runs `CodeNoteService.generate`
/// for the Loop and maps its result onto the contract's outcome.
///
/// A `.busy` scan (another run holds the repository's lock) is retried once
/// after `retryDelay`, so a Loop run does not plan against a stale graph just
/// because an auto-update happened to be running.
@MainActor
final class LoopGraphRescanner: GraphRescanning {
    private let generate: @MainActor (URL) async -> Result<Void, CodeNoteError>
    private let retryDelay: Duration

    /// `service` defaults to a fresh `CodeNoteService` (built in the body: the
    /// class is main-actor isolated, so a default argument cannot construct it).
    init(service: CodeNoteService? = nil, retryDelay: Duration = .seconds(2)) {
        let service = service ?? CodeNoteService()
        self.generate = { url in
            switch await service.generate(repoRoot: url) {
            case .success: return .success(())
            case .failure(let error): return .failure(error)
            }
        }
        self.retryDelay = retryDelay
    }

    /// Test seam: the scan is supplied directly instead of built from a `CodeNoteService`.
    init(generate: @escaping @MainActor (URL) async -> Result<Void, CodeNoteError>, retryDelay: Duration) {
        self.generate = generate
        self.retryDelay = retryDelay
    }

    func rescan(repoRoot: URL) async -> GraphRescanOutcome {
        var result = await generate(repoRoot)
        if case .failure(.busy) = result {
            try? await Task.sleep(for: retryDelay)
            result = await generate(repoRoot)
        }
        switch result {
        case .success:
            return .rewritten
        case .failure(.busy):
            return .busy
        case .failure(let error):
            return .unavailable(String(describing: error))
        }
    }
}
