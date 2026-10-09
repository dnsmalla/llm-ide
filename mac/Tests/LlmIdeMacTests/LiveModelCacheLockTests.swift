import XCTest
@testable import LlmIdeMacLib

/// `LiveModelCache.store` writes UserDefaults, which notifies observers
/// synchronously on the storing thread. It used to do that while holding the
/// lock readers take: SwiftUI's @AppStorage observer then waited for the main
/// thread's view-update lock while a body on main waited for this lock, and
/// the app froze at launch. A reader inside that notification must get through.
final class LiveModelCacheLockTests: XCTestCase {
    func testAReaderInsideTheDefaultsChangeNotificationIsNotBlocked() {
        let defaults = UserDefaults(suiteName: "live-model-lock-\(UUID().uuidString)")!
        LiveModelCache.resetMemoryForTesting()
        defer { LiveModelCache.resetMemoryForTesting() }
        var seenInsideNotification: [AIModel]?
        let token = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification, object: defaults, queue: nil
        ) { _ in
            seenInsideNotification = LiveModelCache.models(for: "deepseek", defaults: defaults)
        }
        defer { NotificationCenter.default.removeObserver(token) }

        let done = expectation(description: "store returns")
        DispatchQueue.global().async {
            LiveModelCache.store([AIModel(id: "deepseek-flash", displayName: "deepseek-flash")],
                                 for: "deepseek", defaults: defaults)
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(seenInsideNotification?.map(\.id), ["deepseek-flash"])
        XCTAssertEqual(LiveModelCache.models(for: "deepseek", defaults: defaults)?.map(\.id), ["deepseek-flash"])
    }
}
