import Foundation

/// Strips auth headers on cross-host redirects so a 3xx bounce from a
/// trusted API host can't leak a PAT to a third party. Shared by
/// GitHubClient (`Authorization`) and GitLabClient (`PRIVATE-TOKEN` +
/// `Authorization`) — each names the headers it actually sends.
///
/// Same-host redirects are followed with auth intact (GitHub
/// legitimately bounces /user → /users/<login>; self-hosted GitLabs
/// bounce through CDNs). Cross-host redirects are still followed —
/// just without the credential headers.
///
/// The host check keys off the task's *original* request host (fixed
/// for the task's lifetime), not the current hop's host — so a
/// multi-hop chain that eventually returns to the original host stays
/// stripped, since each hop's request is built from the previous,
/// already-stripped one.
final class AuthRedirectGuard: NSObject, URLSessionTaskDelegate {
    private let headersToStrip: [String]

    init(headersToStrip: [String]) {
        self.headersToStrip = headersToStrip
    }

    /// Pure decision function: same host → request unchanged;
    /// cross-host (or unknown original host) → copy with the listed
    /// headers removed. Static so tests exercise it without a session.
    static func redirectRequest(originalHost: String?,
                                newRequest: URLRequest,
                                strippingHeaders headers: [String]) -> URLRequest {
        let newHost = newRequest.url?.host?.lowercased()
        if let original = originalHost?.lowercased(), original == newHost {
            return newRequest
        }
        var stripped = newRequest
        for header in headers {
            stripped.setValue(nil, forHTTPHeaderField: header)
        }
        return stripped
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(Self.redirectRequest(
            originalHost: task.originalRequest?.url?.host,
            newRequest: request,
            strippingHeaders: headersToStrip))
    }
}
