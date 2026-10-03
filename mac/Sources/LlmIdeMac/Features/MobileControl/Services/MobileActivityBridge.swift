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
    /// Bumped on every install/remove. A tracking callback armed under an older generation is stale and
    /// must neither push nor re-arm — otherwise a quick disconnect/reconnect leaves two live chains and
    /// every change is pushed twice (then three times…).
    private var generation = 0

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
        generation += 1
        observe(generation: generation)
    }

    func removePushObservers() {
        // Observation has no cancel handle; the generation bump makes the pending callback a no-op.
        observing = false
        generation += 1
    }

    // MARK: - Helpers

    private func observe(generation armed: Int) {
        guard observing, armed == generation else { return }
        withObservationTracking {
            _ = store.lastId
            _ = store.unreadCount
            _ = store.items.count
            // Dedup can swap the newest row without changing the count.
            _ = store.items.first?.id
        } onChange: { [weak self] in
            // onChange fires BEFORE the new values land; hop so pushState reads them.
            Task { @MainActor [weak self] in
                guard let self, self.observing, armed == self.generation else { return }
                self.pushState()
                self.observe(generation: armed)
            }
        }
    }

    private func pushState() {
        guard manager?.mobileClientPaired == true else { return }
        manager?.reply(Self.state(items: store.recentItems, unread: store.visibleUnreadCount))
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
