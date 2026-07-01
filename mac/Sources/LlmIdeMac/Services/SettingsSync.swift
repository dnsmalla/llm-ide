import Foundation
import Combine
import OSLog

/// Server-backed, cross-machine sync of NON-SECRET repo configuration so the
/// Issues / Gantt view looks the same on every machine signed into one account.
///
/// **Syncs:** provider choice, saved GitLab projects, saved GitHub repos, and
/// the last-used GitLab project id.
///
/// **Never syncs:** access tokens (Keychain-only, per machine) and each
/// project's local checkout path (`localPath` is machine-specific — preserved
/// locally on pull, stripped on push).
///
/// Backed by `GET`/`PUT /kb/settings` (see `extension/kb/routes/settings.mjs`).
/// The server is authoritative (last-write-wins): on launch we pull and apply,
/// or seed the server from local state if it has none yet.
@MainActor
final class SettingsSync {

    /// The portable slice of config that travels between machines.
    struct Snapshot: Equatable, Encodable {
        var schemaVersion: Int = 1
        var repoProvider: String?
        var gitLabSavedProjects: [SavedGitLabProject] = []
        var gitHubSavedRepos: [SavedGitHubRepo] = []
        var gitLabLastProjectId: String?

        var isEmpty: Bool {
            (repoProvider ?? "").isEmpty
                && gitLabSavedProjects.isEmpty
                && gitHubSavedRepos.isEmpty
                && (gitLabLastProjectId ?? "").isEmpty
        }
    }

    private struct Envelope: Decodable { var settings: Snapshot? }
    private struct PutBody: Encodable { let settings: Snapshot }
    private struct PutAck: Decodable { let ok: Bool? }

    private let api: LlmIdeAPIClient
    private let config: AppConfig
    private let defaults: UserDefaults
    private let log = Logger(subsystem: "com.llmide.macapp", category: "SettingsSync")

    private var cancellables = Set<AnyCancellable>()
    private var observing = false
    private var bootstrapping = false
    private var applyingRemote = false
    private var lastPushed: Snapshot?
    private var pushTask: Task<Void, Never>?

    init(api: LlmIdeAPIClient, config: AppConfig, defaults: UserDefaults = .standard) {
        self.api = api
        self.config = config
        self.defaults = defaults
    }

    // MARK: - Launch

    /// Pull server settings and apply, or seed the server from local state when
    /// it has none yet. Safe to call more than once (e.g. on re-login) — the
    /// change observer is installed only on the first call. Never throws: a sync
    /// failure must never block launch, we just keep local state.
    func bootstrap() async {
        // On a cold launch `isAuthenticated` flips true *inside* session
        // restore, so the `.onChange` handler and the `.task` continuation can
        // both land here. The flag is set synchronously before the first await,
        // so the second caller returns without a duplicate pull.
        if bootstrapping { return }
        bootstrapping = true
        defer { bootstrapping = false }
        do {
            let env: Envelope = try await api.get("/kb/settings", authenticated: true)
            if let remote = env.settings, !remote.isEmpty {
                let recovered = apply(remote)
                // Record what the SERVER already has (not our post-merge local
                // state) so the write our own `apply` triggers doesn't bounce
                // straight back as a no-op push. When `apply` recovered
                // local-only entries the server never saw, `lastPushed` must
                // stay at the server's (smaller) snapshot so the recovery
                // push below is recognized as a real, portable change and
                // actually goes out instead of short-circuiting as a match.
                lastPushed = strippedForPush(remote)
                log.info("Applied remote settings: \(remote.gitLabSavedProjects.count, privacy: .public) GitLab, \(remote.gitHubSavedRepos.count, privacy: .public) GitHub")
                if recovered {
                    log.info("Recovered local-only saved repo(s) missing from remote — re-pushing")
                    await push(force: false)
                }
            } else {
                await push(force: true)   // server is empty — seed it from here
                log.info("Seeded server settings from local state")
            }
        } catch {
            log.error("settings pull failed: \(String(describing: error), privacy: .public)")
        }
        if !observing {
            observing = true
            startObserving()
        }
    }

    // MARK: - Observe & push

    private func startObserving() {
        // One coalesced trigger. Every synced value is UserDefaults-backed —
        // the provider `@AppStorage` and each `AppConfig` `didSet` — so a single
        // `didChangeNotification` subscription covers them all. Snapshot-diffing
        // in `push` makes writes to unrelated defaults (theme, poll interval, …)
        // free: they produce an identical portable snapshot and no request.
        NotificationCenter.default
            .publisher(for: UserDefaults.didChangeNotification)
            .debounce(for: .seconds(1.5), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.schedulePush() }
            .store(in: &cancellables)
    }

    private func schedulePush() {
        guard !applyingRemote else { return }
        pushTask?.cancel()
        pushTask = Task { [weak self] in await self?.push(force: false) }
    }

    func push(force: Bool) async {
        let stripped = strippedForPush(currentSnapshot())
        if !force, stripped == lastPushed { return }   // nothing portable changed
        do {
            let _: PutAck = try await api.put("/kb/settings",
                                              body: PutBody(settings: stripped),
                                              authenticated: true)
            lastPushed = stripped
            log.info("Pushed settings to server")
        } catch {
            log.error("settings push failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Snapshot helpers

    private func currentSnapshot() -> Snapshot {
        Snapshot(
            repoProvider: defaults.string(forKey: "repoProvider"),
            gitLabSavedProjects: config.gitLabSavedProjects,
            gitHubSavedRepos: config.gitHubSavedRepos,
            gitLabLastProjectId: config.gitLabLastProjectId.isEmpty ? nil : config.gitLabLastProjectId
        )
    }

    /// Drop machine-specific checkout paths before anything leaves this machine.
    private func strippedForPush(_ s: Snapshot) -> Snapshot {
        var out = s
        out.gitLabSavedProjects = s.gitLabSavedProjects.map { var p = $0; p.localPath = nil; return p }
        out.gitHubSavedRepos = s.gitHubSavedRepos.map { var r = $0; r.localPath = nil; return r }
        return out
    }

    /// Apply a remote snapshot, preserving THIS machine's local checkout paths
    /// (matched by id, then url). Everything else — order, active flag, resolved
    /// id, provider — takes the server's value for entries the server already
    /// knows about.
    ///
    /// Local entries the server has NEVER seen (e.g. a repo added right
    /// before quit, inside the 1.5s push debounce, so the push never fired)
    /// are appended rather than dropped — see `mergeLocalPaths`. Without
    /// this, wholesale-replacing with the remote list would silently delete
    /// a saved repo the user just added, purely because of unlucky timing at
    /// quit. Returns whether any such local-only entries were recovered, so
    /// the caller (`bootstrap`) knows to push the recovered state back.
    @discardableResult
    private func apply(_ remote: Snapshot) -> Bool {
        applyingRemote = true
        defer { applyingRemote = false }

        if let provider = remote.repoProvider, !provider.isEmpty {
            defaults.set(provider, forKey: "repoProvider")
        }
        let (gitLab, recoveredGitLab) = mergeLocalPaths(remote.gitLabSavedProjects,
                                                        into: config.gitLabSavedProjects)
        let (gitHub, recoveredGitHub) = mergeLocalPaths(remote.gitHubSavedRepos,
                                                        into: config.gitHubSavedRepos)
        config.gitLabSavedProjects = gitLab
        config.gitHubSavedRepos = gitHub
        if let last = remote.gitLabLastProjectId, !last.isEmpty {
            config.gitLabLastProjectId = last
        }
        return recoveredGitLab || recoveredGitHub
    }

    /// Merges local `localPath` values into the remote list (matched by id,
    /// then url), AND appends any local entries absent from `remote`
    /// entirely — i.e. ones the server has never been told about. Returns
    /// the merged list plus whether any such local-only entries were found.
    private func mergeLocalPaths<T: LocalPathCarrying>(_ remote: [T], into local: [T]) -> (merged: [T], recovered: Bool) {
        let byId = Dictionary(local.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let byUrl = Dictionary(local.map { ($0.url.lowercased(), $0) }, uniquingKeysWith: { first, _ in first })
        let merged = remote.map { r in
            var out = r
            out.localPath = (byId[r.id] ?? byUrl[r.url.lowercased()])?.localPath
            return out
        }
        // Local entries the remote snapshot has never seen at all (matched by
        // neither id nor url) — e.g. added right before quit, inside the
        // 1.5s push debounce window, so the push never fired. Append rather
        // than drop; each already carries its own correct localPath since it
        // never left this machine.
        let remoteIds = Set(remote.map { $0.id })
        let remoteUrls = Set(remote.map { $0.url.lowercased() })
        let localOnly = local.filter { !remoteIds.contains($0.id) && !remoteUrls.contains($0.url.lowercased()) }
        return (merged + localOnly, recovered: !localOnly.isEmpty)
    }
}

/// Retroactive conformance so one merge routine serves both saved-project types
/// (identical shape, distinct types). Same module — no conformance warning.
protocol LocalPathCarrying {
    var id: String { get }
    var url: String { get }
    var localPath: String? { get set }
}

extension SavedGitLabProject: LocalPathCarrying {}
extension SavedGitHubRepo: LocalPathCarrying {}

extension SettingsSync.Snapshot: Decodable {
    // Tolerant decode: a fresh account stores `{}`, and older/newer blobs may
    // omit keys. Missing keys fall back to defaults instead of throwing.
    private enum CodingKeys: String, CodingKey {
        case schemaVersion, repoProvider, gitLabSavedProjects, gitHubSavedRepos, gitLabLastProjectId
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        repoProvider = try c.decodeIfPresent(String.self, forKey: .repoProvider)
        gitLabSavedProjects = try c.decodeIfPresent([SavedGitLabProject].self, forKey: .gitLabSavedProjects) ?? []
        gitHubSavedRepos = try c.decodeIfPresent([SavedGitHubRepo].self, forKey: .gitHubSavedRepos) ?? []
        gitLabLastProjectId = try c.decodeIfPresent(String.self, forKey: .gitLabLastProjectId)
    }
}
