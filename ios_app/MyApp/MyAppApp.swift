import SwiftUI

@main
struct MyAppApp: App {
    @StateObject private var connectionStore: ConnectionStore
    @StateObject private var connection: ConnectionService
    @StateObject private var llmIdeStore: LlmIdeChatStore
    @StateObject private var explorerStore: ExplorerChatStore
    @StateObject private var autoTaskStore: AutoTaskStore
    @StateObject private var loopStore: LoopStore
    @StateObject private var macStatusStore: MacStatusStore
    @StateObject private var generationStore: GenerationStore
    @StateObject private var activityStore: ActivityFeedStore
    @StateObject private var usageStore: UsageStore

    init() {
        // ConnectionService is created first; each feature store is wired to it
        // (and registers itself with it on init) so the receive loop can route
        // inbound frames to the right store.
        let connectionStore = ConnectionStore()
        _connectionStore = StateObject(wrappedValue: connectionStore)

        let connection = ConnectionService()
        connection.connectionStore = connectionStore
        _connection = StateObject(wrappedValue: connection)

        _llmIdeStore = StateObject(wrappedValue: LlmIdeChatStore(connection: connection))
        _explorerStore = StateObject(wrappedValue: ExplorerChatStore(connection: connection))
        _autoTaskStore = StateObject(wrappedValue: AutoTaskStore(connection: connection))
        _loopStore = StateObject(wrappedValue: LoopStore(connection: connection))
        _macStatusStore = StateObject(wrappedValue: MacStatusStore(connection: connection))
        _generationStore = StateObject(wrappedValue: GenerationStore(connection: connection))
        _activityStore = StateObject(wrappedValue: ActivityFeedStore(connection: connection))
        _usageStore = StateObject(wrappedValue: UsageStore(connection: connection))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connectionStore)
                .environmentObject(connection)
                .environmentObject(llmIdeStore)
                .environmentObject(explorerStore)
                .environmentObject(autoTaskStore)
                .environmentObject(loopStore)
                .environmentObject(macStatusStore)
                .environmentObject(generationStore)
                .environmentObject(activityStore)
                .environmentObject(usageStore)
        }
    }
}
