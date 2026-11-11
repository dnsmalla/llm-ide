import SwiftUI

@main
struct MyAppApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var connectionStore: ConnectionStore
    @StateObject private var connection: ConnectionService
    @StateObject private var llmIdeStore: LlmIdeChatStore
    @StateObject private var executeStore: ExecuteChatStore
    @StateObject private var usageStore: UsageStore
    @StateObject private var projectsStore: ProjectsStore
    @StateObject private var syncStore: SyncStore
    @StateObject private var sourceReadStore: SourceReadStore
    @StateObject private var tasksStore: TasksStore
    @StateObject private var loopStore: LoopStore

    init() {
        // ConnectionService is created first; each store it routes to registers itself with it on init.
        let connectionStore = ConnectionStore()
        _connectionStore = StateObject(wrappedValue: connectionStore)

        let connection = ConnectionService()
        connection.connectionStore = connectionStore
        _connection = StateObject(wrappedValue: connection)
        PushRegistrar.shared.connection = connection

        _llmIdeStore = StateObject(wrappedValue: LlmIdeChatStore(connection: connection))
        _executeStore = StateObject(wrappedValue: ExecuteChatStore(connection: connection))
        _usageStore = StateObject(wrappedValue: UsageStore(connection: connection))
        _projectsStore = StateObject(wrappedValue: ProjectsStore(connection: connection, connectionStore: connectionStore))
        _syncStore = StateObject(wrappedValue: SyncStore())
        _sourceReadStore = StateObject(wrappedValue: SourceReadStore())
        _tasksStore = StateObject(wrappedValue: TasksStore(connection: connection))
        _loopStore = StateObject(wrappedValue: LoopStore(connection: connection))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connectionStore)
                .environmentObject(connection)
                .environmentObject(llmIdeStore)
                .environmentObject(executeStore)
                .environmentObject(usageStore)
                .environmentObject(projectsStore)
                .environmentObject(syncStore)
                .environmentObject(sourceReadStore)
                .environmentObject(tasksStore)
                .environmentObject(loopStore)
        }
    }
}
