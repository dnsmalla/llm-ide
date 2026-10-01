import Foundation
import SharedProtocol

/// Mirror of the Mac's activity feed (the bell): newest entries plus the unread count. Read-only —
/// the phone never writes entries; `markSeen` moves the Mac's own "seen" cursor.
@MainActor
final class ActivityFeedStore: ObservableObject {
    @Published var entries: [ActivityEntry] = []
    @Published var unread = 0
    /// False until the first `activity_state` arrives, so the tab shows a spinner, not "nothing yet".
    @Published var loaded = false
    @Published var loadError: String?

    weak var connection: ConnectionService?
    private var watchdog: Task<Void, Never>?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.activityStore = self
    }

    func refresh() {
        guard connection?.connectionStatus == .connected else { return }
        connection?.sendEncodable(ActivityList())
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled, let self, !self.loaded,
                  self.connection?.connectionStatus == .connected else { return }
            self.loadError = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with the activity feed."
        }
    }

    /// Called when the feed is on screen. Clears the badge at once; the Mac confirms with a fresh state.
    func markSeen() {
        guard unread > 0, connection?.connectionStatus == .connected else { return }
        unread = 0
        connection?.sendEncodable(ActivityMarkSeen())
    }

    func handleInbound(type: String, data: Data) {
        guard type == MobileProtocol.Tag.activityState,
              let state = try? JSONDecoder().decode(ActivityState.self, from: data) else { return }
        entries = state.entries
        unread = state.unread
        loaded = true
        loadError = nil
        watchdog?.cancel()
    }

    func resetForNewDevice() {
        entries = []
        unread = 0
        loaded = false
        loadError = nil
        watchdog?.cancel()
    }
}
