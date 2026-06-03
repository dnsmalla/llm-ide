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
/// (e.g. `MeetNotesAPIClient`) now have to `await` token reads, which
/// also makes the synchronisation explicit at the call site.
@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var user: UserInfo?
    @Published private(set) var accessToken: String?
    @Published private(set) var refreshToken: String?
    @Published private(set) var bootstrapping: Bool = true
    @Published private(set) var lastError: String?

    private let log = Logger(subsystem: "com.meetnotes.macapp", category: "Session")
    private var refreshTask: Task<Bool, Never>?
    private var refreshSlot: UInt64 = 0
    private let host: String

    var isAuthenticated: Bool { accessToken != nil && user != nil }

    init(server: String) {
        self.host = server
    }

    func bootstrap(api: MeetNotesAPIClient) async {
        guard let stored = KeychainStore.loadToken(host: host) else {
            await MainActor.run { self.bootstrapping = false }
            return
        }
        // A refresh token exists — try to exchange it for a fresh access token.
        let session = try? await api.refresh(refreshToken: stored)
        await MainActor.run {
            if let session {
                self.adopt(session: session)
            } else {
                // Refresh failed (expired or server unreachable) — clear and show login.
                KeychainStore.deleteToken(host: self.host)
            }
            self.bootstrapping = false
        }
    }

    @MainActor
    func adopt(session: SessionResponse) {
        user = session.user
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
    func attemptRefresh(via api: MeetNotesAPIClient) async -> Bool {
        if let existing = await MainActor.run(body: { self.refreshTask }) {
            return await existing.value
        }
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
                    let msg = error.localizedDescription
                    await MainActor.run {
                        self.log.warning("Refresh failed: \(msg, privacy: .public)")
                        self.clear()
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
