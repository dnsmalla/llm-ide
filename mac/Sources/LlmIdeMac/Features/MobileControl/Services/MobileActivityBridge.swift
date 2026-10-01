import Foundation
import Observation
import SharedProtocol

/// Serves the `activity_*` slice of the mobile protocol: mirrors the Mac's `ActivityStore` (the
/// feed behind the bell) to the phone and lets the phone mark it seen.
///
/// Pushes are driven by Observation, not a timer: the store already polls the backend every 25 s,
/// so the phone hears about a new event as soon as the Mac does, without a second poll loop.
@MainActor
final class MobileActivityBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    private let store: ActivityStore
    private var observing = false

    /// How many entries cross the wire; the Mac keeps up to 500 in memory.
    static let maxEntries = 50
    static let maxTitleLength = 300

    init(manager: MobileControlManager, store: ActivityStore) {
        self.manager = manager
        self.store = store
    }

    // MARK: - MobileFeatureBridge

    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.activityList:
            // Answer from what the store has now, then refresh once so a phone that just opened
            // the tab doesn't wait up to 25 s for the next poll.
            pushState()
            Task { @MainActor [weak self] in
                await self?.store.refresh()
                self?.pushState()
            }
            return true

        case MobileProtocol.Tag.activityMarkSeen:
            store.markSeen()
            pushState()
            return true

        default:
            return false
        }
    }

    func installPushObservers() {
        guard !observing else { return }
        observing = true
        observe()
    }

    func removePushObservers() {
        // Observation has no cancel handle; the flag makes the next change a no-op that doesn't re-arm.
        observing = false
    }

    // MARK: - Helpers

    private func observe() {
        guard observing else { return }
        withObservationTracking {
            _ = store.lastId
            _ = store.unreadCount
            _ = store.items.count
        } onChange: { [weak self] in
            // onChange fires BEFORE the new values land; hop so pushState reads them.
            Task { @MainActor [weak self] in
                guard let self, self.observing else { return }
                self.pushState()
                self.observe()
            }
        }
    }

    private func pushState() {
        guard manager?.mobileClientPaired == true else { return }
        manager?.reply(Self.state(items: store.items, unread: store.unreadCount))
    }

    /// Pure so a test can pin the shaping: newest-first cap, title cap, no detail/link.
    static func state(items: [ActivityItem], unread: Int) -> ActivityState {
        ActivityState(
            entries: items.prefix(maxEntries).map {
                ActivityEntry(id: $0.id, kind: $0.kind?.rawValue,
                              title: String($0.title.prefix(maxTitleLength)),
                              createdAt: $0.createdAt.timeIntervalSince1970)
            },
            unread: unread)
    }
}
