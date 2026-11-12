import Foundation

/// What a feature store needs from the app's connection: the transport and whether it is live. The app's
/// `ConnectionService` conforms; tests use a fake. Stores never see the concrete service.
@MainActor
public protocol HostContext: AnyObject {
    var host: HostConnection { get }
    var isConnected: Bool { get }
}

/// A store that consumes the connection's pushed events. The connection keeps a weak list of sinks, so adding a
/// feature never means editing the connection's routing.
@MainActor
public protocol HostEventSink: AnyObject {
    func handle(_ event: HostEvent)
    /// The connection dropped (nil) or one turn failed: end the turns that can no longer finish.
    func handleChatError(commandId: String?)
    /// The connection dropped: a card raised on it can never be answered.
    func clearPendingPrompts()
    /// A different desktop was paired: forget the previous one's state.
    func resetForNewDevice()
    /// The connection dropped but may come back: keep a detached turn waiting. Default ends turns as before.
    func connectionDropped()
    /// The connection is ready (again): resume what was waiting. Default does nothing.
    func connectionReady()
}

public extension HostEventSink {
    func connectionDropped() { handleChatError(commandId: nil) }
    func connectionReady() {}
}

/// `HostContext` plus what the chat needs: the shared error banner, the selected project and its refusals.
@MainActor
public protocol ChatHostContext: HostContext {
    var errorMessage: String? { get set }
    /// The project the picker holds right now (nil = the legacy/global chat).
    var selectedProjectId: String? { get }
    /// The project a scoped frame should name, waiting for the first `projects.list` reply.
    func scopedProjectId() async -> String?
    /// True when `error` was a project refusal the picker now shows (the caller then stays quiet).
    func noteProjectRefusal(_ error: Error) -> Bool
    func disconnect()
    func registerSink(_ sink: HostEventSink)
}
