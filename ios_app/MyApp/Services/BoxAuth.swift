import AuthenticationServices
import UIKit
import SharedProtocol

@MainActor
enum BoxAuth {
    enum Failure: Error { case cancelled, stateMismatch, noCode }
    private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
    private static let anchor = Anchor()
    static func signIn(app: BoxClient.App, redirectURI: String = BoxClient.redirectURI) async throws -> BoxClient.Tokens {
        let (verifier, challenge) = BoxClient.pkce()
        let state = "i." + SyncB64.encode(SyncCrypto.randomBytes(16))
        let url = BoxClient.authorizeURL(app: app, state: state, challenge: challenge, redirectURI: redirectURI)
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "llmide-box") { u, e in
                if let u { cont.resume(returning: u) } else { cont.resume(throwing: (e as? ASWebAuthenticationSessionError)?.code == .canceledLogin ? Failure.cancelled : (e ?? Failure.noCode)) }
            }
            s.presentationContextProvider = anchor
            s.prefersEphemeralWebBrowserSession = true
            s.start()
        }
        let q = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard q.first(where: { $0.name == "state" })?.value == state else { throw Failure.stateMismatch }
        if q.contains(where: { $0.name == "error" }) { throw Failure.cancelled }
        guard let code = q.first(where: { $0.name == "code" })?.value else { throw Failure.noCode }
        return try await BoxClient.exchange(code: code, verifier: verifier, app: app, redirectURI: redirectURI)
    }
}
