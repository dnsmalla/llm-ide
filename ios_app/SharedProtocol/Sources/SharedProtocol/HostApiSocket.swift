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
/// TLS host is refused rather than trusted through the system store. Once `trust` refused the host, every
/// `send`/`receive` throws `HostApiPinning.mismatch`, so the client reports it instead of "no v1 host".
public final class URLSessionHostApiSocket: NSObject, HostApiSocket, URLSessionDelegate, @unchecked Sendable {
    private let trust: HostApiTrustEvaluating?
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let refused = NSLock()
    private var _trustRefused = false
    private var trustRefused: Bool { refused.withLock { _trustRefused } }

    public init(url: URL, trust: HostApiTrustEvaluating? = nil) {
        self.trust = trust
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = HostApi.limits.maxFrameBytes
        task.resume()
    }

    public func send(_ text: String) async throws {
        do { try await task.send(.string(text)) } catch { throw trustRefused ? HostApiPinning.mismatch : error }
    }

    public func receive() async throws -> Data {
        let message: URLSessionWebSocketTask.Message
        do { message = try await task.receive() } catch { throw trustRefused ? HostApiPinning.mismatch : error }
        switch message {
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
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            return completionHandler(.performDefaultHandling, nil)
        }
        // A server-trust challenge never reaches system trust, not even one without a trust object.
        guard let serverTrust = challenge.protectionSpace.serverTrust, let trust,
              trust.evaluate(serverTrust, host: challenge.protectionSpace.host) else {
            refused.withLock { _trustRefused = true }
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
}
