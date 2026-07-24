import SwiftUI

@main
struct MyAppApp: App {
    @StateObject private var connectionStore: ConnectionStore
    @StateObject private var connection: ConnectionService
    @StateObject private var llmIdeStore: LlmIdeChatStore
    @StateObject private var explorerStore: ExplorerChatStore
    @StateObject private var autoTaskStore: AutoTaskStore

    init() {
        // ConnectionService is created first; each feature store is wired to it
        // (and registers itself with it on init) so the receive loop can route
        // inbound frames to the right store.
        let connectionStore = ConnectionStore()
        _connectionStore = StateObject(wrappedValue: connectionStore)

        let connection = ConnectionService()
        _connection = StateObject(wrappedValue: connection)

        _llmIdeStore = StateObject(wrappedValue: LlmIdeChatStore(connection: connection))
        _explorerStore = StateObject(wrappedValue: ExplorerChatStore(connection: connection))
        _autoTaskStore = StateObject(wrappedValue: AutoTaskStore(connection: connection))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connectionStore)
                .environmentObject(connection)
                .environmentObject(llmIdeStore)
                .environmentObject(explorerStore)
                .environmentObject(autoTaskStore)
        }
    }
}
