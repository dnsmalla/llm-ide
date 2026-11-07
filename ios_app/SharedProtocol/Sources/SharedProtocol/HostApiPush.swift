import Foundation

/// Host API v1 `push` on the phone: the gate and the `push.register` payload for an APNs device token. Pure, so it is
/// tested without UIKit. The desktop sends only a kind and a count; the words are in the app's Localizable.strings.
public enum HostApiPush {
    /// True only on a connection whose host granted `push`. Not optimistic, unlike `ConnectionService.supports`.
    public static func isOn(capabilities: Set<String>?) -> Bool {
        capabilities?.contains(HostApiCommand.pushRegister.capability) == true
    }

    /// The token as the lowercase hex the desktop accepts (^[0-9a-f]{64,200}$).
    public static func tokenHex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// Debug builds (run from Xcode) get sandbox tokens; TestFlight and App Store builds get production ones.
    public static func environment(isDebug: Bool) -> String { isDebug ? "sandbox" : "production" }

    public static func registerRequest(token: Data, isDebug: Bool) -> HostApiPushRegisterRequest {
        HostApiPushRegisterRequest(environment: environment(isDebug: isDebug), kind: "apns", token: tokenHex(token))
    }
}
