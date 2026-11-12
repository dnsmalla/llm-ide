import SwiftUI
import Combine
import SharedProtocol

/// The one place the app's object graph is built. The connection is created first; each feature store takes it
/// as its `HostContext` and registers itself as an event sink. `MyAppApp` owns a single `AppModel`, so adding a
/// feature means adding it here and nowhere else in the wiring.
@MainActor
final class AppModel: ObservableObject {
    let connectionStore = ConnectionStore()
    let connection = ConnectionService()
    let llmIdeStore: LlmIdeChatStore
    let executeStore: ExecuteChatStore
    let usageStore: UsageStore
    let projectsStore: ProjectsStore
    let syncStore = SyncStore()
    let sourceReadStore = SourceReadStore()
    let tasksStore: TasksStore
    let loopStore: LoopStore
    private var projectsSink: AnyCancellable?

    init() {
        connection.connectionStore = connectionStore
        PushRegistrar.shared.connection = connection
        llmIdeStore = LlmIdeChatStore(context: connection)
        executeStore = ExecuteChatStore(context: connection)
        usageStore = UsageStore(connection: connection)
        projectsStore = ProjectsStore(connection: connection, connectionStore: connectionStore)
        tasksStore = TasksStore(context: connection)
        loopStore = LoopStore(context: connection)
        // Remember the live project list for the offline-sync queue's picker (ids and names only).
        // `noteProjects` ignores an empty list, so a failed or still-loading session never erases it.
        projectsSink = projectsStore.$state.sink { [weak syncStore] state in
            syncStore?.noteProjects(state.projects.map { ($0.id, $0.name) }, selected: state.selectedId)
        }
    }
}

extension View {
    /// Hands every store to the view tree by type, so screens read what they need with `@EnvironmentObject`.
    func injecting(_ model: AppModel) -> some View {
        environmentObject(model.connectionStore)
            .environmentObject(model.connection)
            .environmentObject(model.llmIdeStore)
            .environmentObject(model.executeStore)
            .environmentObject(model.usageStore)
            .environmentObject(model.projectsStore)
            .environmentObject(model.syncStore)
            .environmentObject(model.sourceReadStore)
            .environmentObject(model.tasksStore)
            .environmentObject(model.loopStore)
    }
}
