import AuthenticationServices
import UIKit
import SharedProtocol

/// Box sign-in for the sync folder (SP6 D7): authorization code + PKCE with the user's own Box app from the pairing QR,
/// in an ASWebAuthenticationSession; the redirect to llmide-box://oauth is caught by the session (no URL scheme
/// registration needed). Ephemeral: no Box cookies are kept. The callback's state and code shape are checked by SP7's
/// SourceOAuth.code(fromCallback:state:), so the errors are SourceOAuthError. The code is exchanged at once.
@MainActor
enum BoxAuth {
    private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
    private static let anchor = Anchor()
    static func signIn(app: BoxClient.App, redirectURI: String = BoxClient.redirectURI) async throws -> BoxClient.Tokens {
        let (verifier, challenge) = BoxClient.pkce()
        let state = "i." + SourceOAuth.randomString(bytes: 16)
        let url = BoxClient.authorizeURL(app: app, state: state, challenge: challenge, redirectURI: redirectURI)
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "llmide-box") { u, e in
                if let u { cont.resume(returning: u); return }
                cont.resume(throwing: (e as? ASWebAuthenticationSessionError)?.code == .canceledLogin ? SourceOAuthError.cancelled : SourceOAuthError.failed)
            }
            s.presentationContextProvider = anchor
            s.prefersEphemeralWebBrowserSession = true
            if !s.start() { cont.resume(throwing: SourceOAuthError.failed) }
        }
        let code = try SourceOAuth.code(fromCallback: callback, state: state)
        return try await BoxClient.exchange(code: code, verifier: verifier, app: app, redirectURI: redirectURI)
    }
}
