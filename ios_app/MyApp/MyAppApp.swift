import SwiftUI

@main
struct MyAppApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var connectionStore: ConnectionStore
    @StateObject private var connection: ConnectionService
    @StateObject private var llmIdeStore: LlmIdeChatStore
    @StateObject private var usageStore: UsageStore
    @StateObject private var syncStore: SyncStore
    @StateObject private var sourceReadStore: SourceReadStore

    init() {
        // ConnectionService is created first; each store it routes to registers itself with it on init.
        let connectionStore = ConnectionStore()
        _connectionStore = StateObject(wrappedValue: connectionStore)

        let connection = ConnectionService()
        connection.connectionStore = connectionStore
        _connection = StateObject(wrappedValue: connection)
        PushRegistrar.shared.connection = connection

        _llmIdeStore = StateObject(wrappedValue: LlmIdeChatStore(connection: connection))
        _usageStore = StateObject(wrappedValue: UsageStore(connection: connection))
        _syncStore = StateObject(wrappedValue: SyncStore())
        _sourceReadStore = StateObject(wrappedValue: SourceReadStore())
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connectionStore)
                .environmentObject(connection)
                .environmentObject(llmIdeStore)
                .environmentObject(usageStore)
                .environmentObject(syncStore)
                .environmentObject(sourceReadStore)
        }
    }
}
