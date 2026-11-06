import Foundation
import AuthenticationServices
import UIKit
import SharedProtocol

/// Direct reads (design §9): read-only OAuth to the user's own GitLab and Box. App settings and tokens are in the
/// Keychain, this device only (SyncStore.Keychain, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly). Nothing read
/// from a provider is stored (decision D7).
@MainActor
final class SourceReadStore: ObservableObject {
    @Published private(set) var configs: [SourceProvider: SourceAppConfig] = [:]
    @Published private(set) var signedIn: Set<SourceProvider> = []
    @Published private(set) var busy = false
    @Published private(set) var lastError: String?

    private var tokens: [SourceProvider: SourceTokens] = [:]
    private var refreshTasks: [SourceProvider: Task<String?, Never>] = [:]
    private var clients: [SourceProvider: SourceReadClient] = [:]
    private var authSession: ASWebAuthenticationSession?
    private let anchor = SourceAuthAnchor()
    private var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

    init() {
        configs = Self.keyed(SyncStore.Keychain.load([String: SourceAppConfig].self, .sourceConfig)).filter { (try? SourceOAuth.check($0.key, $0.value)) != nil }
        tokens = Self.keyed(SyncStore.Keychain.load([String: SourceTokens].self, .sourceTokens)).filter { configs[$0.key] != nil }
        signedIn = Set(tokens.keys)
    }
    private static func keyed<T>(_ d: [String: T]?) -> [SourceProvider: T] {
        Dictionary(uniqueKeysWithValues: (d ?? [:]).compactMap { k, v in SourceProvider(rawValue: k).map { ($0, v) } })
    }
    private static func plain<T>(_ d: [SourceProvider: T]) -> [String: T] { Dictionary(uniqueKeysWithValues: d.map { ($0.key.rawValue, $0.value) }) }
    private func saveConfigs() { if configs.isEmpty { SyncStore.Keychain.delete(.sourceConfig) } else { _ = SyncStore.Keychain.save(Self.plain(configs), .sourceConfig) } }
    private func saveTokens() {
        signedIn = Set(tokens.keys)
        if tokens.isEmpty { SyncStore.Keychain.delete(.sourceTokens) } else { _ = SyncStore.Keychain.save(Self.plain(tokens), .sourceTokens) }
    }

    @discardableResult
    func configure(_ p: SourceProvider, _ c: SourceAppConfig) -> Bool {
        do { configs[p] = try SourceOAuth.check(p, c); clients[p] = nil; saveConfigs(); lastError = nil; return true }
        catch { lastError = Self.message(error); return false }
    }

    func forget(_ p: SourceProvider) async {
        await signOut(p)
        configs[p] = nil; clients[p] = nil; saveConfigs()
    }

    func signIn(_ p: SourceProvider) async {
        guard let c = configs[p], !busy else { return }
        busy = true; lastError = nil
        defer { busy = false; authSession = nil }
        let verifier = SourceOAuth.randomString(), state = SourceOAuth.randomString(bytes: 16)
        do {
            let callback = try await authorize(SourceOAuth.authorizeURL(p, c, state: state, challenge: SourceOAuth.challenge(for: verifier)))
            let code = try SourceOAuth.code(fromCallback: callback, state: state)
            tokens[p] = try await SourceOAuth.exchange(p, c, code: code, verifier: verifier, nowMs: nowMs)
            saveTokens()
        } catch SourceOAuthError.cancelled {
            // The user closed the sign-in sheet: not an error.
        } catch { lastError = Self.message(error) }
    }

    func signOut(_ p: SourceProvider) async {
        let t = tokens[p]; tokens[p] = nil; refreshTasks[p] = nil; saveTokens()
        if let t, let c = configs[p] { await SourceOAuth.revoke(p, c, token: t.access) }
    }

    func client(_ p: SourceProvider) -> SourceReadClient {
        if let c = clients[p] { return c }
        let session = SourceSession(perMinute: p == .gitlab ? 60 : 240,
                                    token: { [weak self] in guard let self else { throw SourceError.signedOut }; return try await self.accessToken(p) },
                                    refresh: { [weak self] in await self?.refreshToken(p) })
        let c: SourceReadClient = p == .gitlab ? GitLabReadClient(session: session) : BoxReadClient(session: session)
        clients[p] = c
        return c
    }

    private func accessToken(_ p: SourceProvider) async throws -> String {
        guard let t = tokens[p] else { throw SourceError.signedOut }
        if t.expiresAtMs > nowMs { return t.access }
        guard let fresh = await refreshToken(p) else { throw SourceError.signedOut }
        return fresh
    }

    /// One refresh in flight per provider: Box refresh tokens are single use. Any failure ends that sign-in.
    private func refreshToken(_ p: SourceProvider) async -> String? {
        if let running = refreshTasks[p] { return await running.value }
        let task = Task { @MainActor [weak self] () -> String? in
            guard let self else { return nil }
            guard let c = self.configs[p], let r = self.tokens[p]?.refresh else { self.tokens[p] = nil; self.saveTokens(); return nil }
            do {
                let t = try await SourceOAuth.refresh(p, c, refreshToken: r, nowMs: self.nowMs)
                // Signed out (or in again) while the refresh was in flight: do not resurrect the old sign-in.
                guard self.tokens[p]?.refresh == r else { await SourceOAuth.revoke(p, c, token: t.access); return nil }
                self.tokens[p] = t; self.saveTokens(); return t.access
            }
            catch { self.tokens[p] = nil; self.saveTokens(); return nil }
        }
        refreshTasks[p] = task
        let value = await task.value
        refreshTasks[p] = nil
        return value
    }

    private func authorize(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: SourceOAuth.callbackScheme) { callback, error in
                if let callback { cont.resume(returning: callback); return }
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { cont.resume(throwing: SourceOAuthError.cancelled) }
                else { cont.resume(throwing: SourceOAuthError.failed) }
            }
            s.presentationContextProvider = anchor
            s.prefersEphemeralWebBrowserSession = false // decision D10: reuse the Safari login
            authSession = s
            if !s.start() { cont.resume(throwing: SourceOAuthError.failed) }
        }
    }

    static func message(_ e: Error) -> String {
        switch e {
        case SourceError.offline: return "You are offline. Code and documents are read live and are not kept on this iPhone."
        case SourceError.unreachable: return "The provider is not reachable. Check the network."
        case SourceError.timeout: return "The provider took too long to answer."
        case SourceError.signedOut: return "Your sign-in ended. Sign in again in Settings."
        case SourceError.forbidden: return "The provider refused access to this item."
        case SourceError.notFound: return "Not found. It may have moved or been deleted."
        case SourceError.rateLimited(_): return "The provider asked us to slow down. Wait a minute and try again."
        case SourceError.tooLarge: return "Too large to show here. Open it on the provider's site."
        case SourceError.notReady: return "Box is still preparing this file. Try again in a moment."
        case SourceError.refusedHost: return "The provider sent us to an address this app does not trust."
        case SourceError.badQuery: return "Enter 1 to 200 characters to search."
        case SourceOAuthError.badClientId: return "Enter the application (client) ID from the provider's developer settings."
        case SourceOAuthError.badClientSecret: return "Enter the Box app's client secret."
        case SourceOAuthError.scopeTooWide: return "The provider granted more than read access. Use an app limited to read scopes."
        case SourceOAuthError.clientRefused: return "The provider refused this app's ID or secret. Check the app settings."
        case SourceOAuthError.grantExpired: return "The sign-in code expired. Try again."
        case SourceOAuthError.unreachable: return "The provider is not reachable. Check the network."
        default: return "That did not work. Try again."
        }
    }

    static func reasonText(_ r: SourceOpened.Reason) -> String {
        switch r {
        case .binary: return "This file is binary and is not shown."
        case .type: return "This file type is not shown here."
        case .tooLarge: return "Too large to show here. Open it on the provider's site."
        case .noText: return "Box has no text for this file yet."
        }
    }
}

final class SourceAuthAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}
