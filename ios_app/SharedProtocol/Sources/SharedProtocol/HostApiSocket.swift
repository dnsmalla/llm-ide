import Foundation
import Security

/// The one socket a `HostApiV1Client` talks through: URLSession in the app, a scripted fake in tests.
public protocol HostApiSocket: AnyObject, Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> Data
    func cancel()
}

/// Plan 6 seam (spec "Security": "The host certificate fingerprint is carried in the pairing QR and pinned
/// by the client"). It decides whether a TLS server trust is the paired host.
public protocol HostApiTrustEvaluating: Sendable {
    func evaluate(_ trust: SecTrust, host: String) -> Bool
}

/// `URLSessionWebSocketTask` behind `HostApiSocket`. It has one ephemeral session per socket, invalidated
/// on `cancel`, so a reconnect never leaks a session. A TLS challenge goes to `trust`; with none, every
/// TLS host is refused rather than trusted through the system store.
public final class URLSessionHostApiSocket: NSObject, HostApiSocket, URLSessionDelegate, @unchecked Sendable {
    private let trust: HostApiTrustEvaluating?
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!

    public init(url: URL, trust: HostApiTrustEvaluating? = nil) {
        self.trust = trust
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = HostApi.limits.maxFrameBytes
        task.resume()
    }

    public func send(_ text: String) async throws { try await task.send(.string(text)) }

    public func receive() async throws -> Data {
        switch try await task.receive() {
        case .string(let s): return Data(s.utf8)
        case .data(let d): return d
        @unknown default: return Data()
        }
    }

    public func cancel() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            return completionHandler(.performDefaultHandling, nil)
        }
        guard let trust, trust.evaluate(serverTrust, host: challenge.protectionSpace.host) else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
}
