import Foundation
import Combine
import os.log

/// The single source of truth for "is the user signed in" and "what's
/// the live access token".  All views observe `@Published` here; the
/// API client reads `accessToken` on every call.
///
/// The refresh token is persisted in the Keychain so sessions survive
/// app restarts.
///
/// Annotated `@MainActor` so every read and write to `accessToken` /
/// `refreshToken` is automatically isolated to the main actor.  This
/// eliminates the data race where `MainActor.run { adopt(...) }`
/// mutated the token while a background API caller was simultaneously
/// reading `session.accessToken`.  Callers in non-isolated contexts
/// (e.g. `LlmIdeAPIClient`) now have to `await` token reads, which
/// also makes the synchronisation explicit at the call site.
@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var user: UserInfo?
    @Published private(set) var accessToken: String?
    @Published private(set) var refreshToken: String?
    @Published private(set) var bootstrapping: Bool = true
    @Published private(set) var lastError: String?

    /// True when a refresh token exists but the launch refresh failed for a
    /// *transient* reason (backend unreachable / timeout / 5xx) — i.e. the
    /// saved login is probably still valid, so we keep it and offer retry
    /// instead of forcing a re-login. Cleared on success, on a definitive
    /// auth rejection, and on manual sign-out. Drives the Reconnect screen.
    @Published private(set) var unreachable: Bool = false

    private let log = Logger(subsystem: "com.llmide.macapp", category: "Session")
    private var refreshTask: Task<Bool, Never>?
    private var refreshSlot: UInt64 = 0
    private let host: String
    /// Snapshot taken once at init so launch gating doesn't re-query Keychain.
    private let storedSessionAtLaunch: Bool

    var isAuthenticated: Bool { accessToken != nil && user != nil }

    /// Whether a refresh token was persisted at app launch — used to decide
    /// whether to wait for the backend on cold start. Does not re-read Keychain.
    var hasStoredSession: Bool { storedSessionAtLaunch }

    init(server: String) {
        self.host = server
        self.storedSessionAtLaunch = KeychainStore.loadToken(host: server) != nil
    }

    func bootstrap(api: LlmIdeAPIClient) async {
        await performLaunchRefresh(api: api)
    }

    /// Re-run the launch refresh from the Reconnect screen (the user tapped
    /// Retry, or the backend just came back online). Re-enters the
    /// `bootstrapping` UI while the refresh is in flight so the spinner shows
    /// instead of a stale error.
    func reconnect(api: LlmIdeAPIClient) async {
        bootstrapping = true
        unreachable = false
        await performLaunchRefresh(api: api)
    }

    /// Single source of truth for the launch-time refresh. Replaces the old
    /// `bootstrap` that wiped the Keychain token on ANY failure — including a
    /// transient "backend not reachable" — which auto-logged-out users on
    /// every slow cold start. Now: keep the token and surface a retry screen
    /// unless the server *definitively* rejected the token (401/403).
    private func performLaunchRefresh(api: LlmIdeAPIClient) async {
        guard let stored = KeychainStore.loadToken(host: host) else {
            // No saved login → login screen (via `!isAuthenticated`). Never
            // set `unreachable`: there is nothing to reconnect with.
            unreachable = false
            bootstrapping = false
            return
        }
        do {
            let session = try await api.refresh(refreshToken: stored)
            adopt(session: session)
            // Older servers omit `user` on /auth/refresh (or send one this
            // client can't decode). The tokens are valid and adopted; fetch
            // the profile separately so the session actually restores —
            // otherwise `isAuthenticated` stays false and the user lands on
            // the login screen every launch despite a live refresh token.
            if user == nil {
                user = try? await api.me()
            }
            unreachable = false
        } catch {
            if Self.isDefinitiveAuthRejection(error) {
                // Server confirmed the token is invalid/expired/disabled —
                // wipe it and show login.
                clear()
                unreachable = false
            } else {
                // Transient (can't reach host, timeout, 5xx, …): keep the
                // token and offer retry. The login is most likely still valid
                // once the backend is back. Do NOT clear.
                log.warning("Launch refresh transient failure: \(error.localizedDescription, privacy: .public)")
                unreachable = true
            }
        }
        bootstrapping = false
    }

    /// Only a real HTTP 401/403 from `/auth/refresh` means the token is
    /// definitively dead (expired/revoked/disabled). Everything else —
    /// `.network` (host down / timeout), `.http(5xx)`, `.decoding`, … — is a
    /// transient failure that must NOT log the user out. Pure + testable.
    nonisolated static func isDefinitiveAuthRejection(_ error: Error) -> Bool {
        guard case .http(let status, _, _, _) = error as? APIError else { return false }
        return status == 401 || status == 403
    }

    @MainActor
    func adopt(session: SessionResponse) {
        // /auth/refresh on older servers omits `user`; keep the one we
        // already have rather than logging the UI out (`isAuthenticated`
        // requires a non-nil user). Login responses always carry it.
        if let refreshedUser = session.user { user = refreshedUser }
        accessToken = session.accessToken
        refreshToken = session.refreshToken
        KeychainStore.saveToken(session.refreshToken, host: host)
    }

    @MainActor
    func clear() {
        user = nil
        accessToken = nil
        refreshToken = nil
        lastError = nil
        KeychainStore.deleteToken(host: host)
    }

    @MainActor
    func setError(_ message: String?) { lastError = message }

    /// Coalesced refresh — concurrent 401-retry callers all await the
    /// same network call instead of sending N parallel /auth/refresh
    /// requests.
    func attemptRefresh(via api: LlmIdeAPIClient) async -> Bool {
        // The coalescing guard lives inside the MainActor.run below; the
        // redundant pre-check here was removed (MAC-4).
        let claim: (Task<Bool, Never>, UInt64?) = await MainActor.run {
            if let existing = self.refreshTask { return (existing, nil) }
            self.refreshSlot &+= 1
            let mySlot = self.refreshSlot
            let fresh = Task<Bool, Never> { [weak self] in
                guard let self else { return false }
                let storedRefresh: String? = await MainActor.run { self.refreshToken }
                guard let token = storedRefresh else { return false }
                do {
                    let session = try await api.refresh(refreshToken: token)
                    await MainActor.run { self.adopt(session: session) }
                    return true
                } catch {
                    let definitive = Self.isDefinitiveAuthRejection(error)
                    await MainActor.run {
                        self.log.warning("Refresh \(definitive ? "rejected" : "transient failure"): \(error.localizedDescription, privacy: .public)")
                        // Only wipe the session on a definitive rejection
                        // (401/403). A transient network/timeout failure must
                        // NOT log the user out mid-session — they stay signed
                        // in (token retained) and the failing request surfaces
                        // an error; it recovers once the backend is back.
                        if definitive { self.clear() }
                    }
                    return false
                }
            }
            self.refreshTask = fresh
            return (fresh, mySlot)
        }
        let result = await claim.0.value
        if let mySlot = claim.1 {
            await MainActor.run {
                if self.refreshSlot == mySlot { self.refreshTask = nil }
            }
        }
        return result
    }
}
