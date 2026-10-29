import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LiveThenArchiveSettingModelTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "lta-setting-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        addTeardownBlock { d.removePersistentDomain(forName: name) }
        return d
    }

    func testStartsFromTheStoredKeyAndDefaultsToOff() {
        let d = defaults()
        XCTAssertEqual(LiveThenArchiveSettingModel(defaults: d, launchMode: .off).selected, .off)
        d.set("shadow", forKey: "lta.mode")
        XCTAssertEqual(LiveThenArchiveSettingModel(defaults: d, launchMode: .off).selected, .shadow)
        d.set("garbage", forKey: "lta.mode")
        XCTAssertEqual(LiveThenArchiveSettingModel(defaults: d, launchMode: .off).selected, .off, "a typo never turns it on")
    }

    func testChoosingWritesTheSameKeyLiveThenArchiveModeReads() {
        let d = defaults()
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .off)
        XCTAssertTrue(model.choose(.shadow))
        XCTAssertEqual(d.string(forKey: LiveThenArchiveMode.defaultsKey), "shadow")
        XCTAssertEqual(LiveThenArchiveMode.current(d), .shadow)
        XCTAssertTrue(model.choose(.on))
        XCTAssertEqual(LiveThenArchiveMode.current(d), .on)
    }

    func testChangeIsFlaggedAsNeedingARestartUntilItMatchesTheLaunchMode() {
        let d = defaults()
        d.set("shadow", forKey: "lta.mode")
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .shadow)
        XCTAssertFalse(model.needsRestart)
        model.choose(.on)
        XCTAssertTrue(model.needsRestart)
        model.choose(.shadow)
        XCTAssertFalse(model.needsRestart, "switching back to what runs needs nothing")
    }

    func testOffFromOnAsksFirstAndStoresNothingUntilConfirmed() {
        let d = defaults()
        d.set("on", forKey: "lta.mode")
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .on)
        XCTAssertFalse(model.choose(.off))
        XCTAssertTrue(model.pendingOff)
        XCTAssertEqual(LiveThenArchiveMode.current(d), .on)
        model.confirmOff()
        XCTAssertFalse(model.pendingOff)
        XCTAssertEqual(LiveThenArchiveMode.current(d), .off)
        XCTAssertTrue(model.needsRestart)
    }

    func testCancellingOffKeepsOn() {
        let d = defaults()
        d.set("on", forKey: "lta.mode")
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .on)
        model.choose(.off)
        model.cancelOff()
        XCTAssertFalse(model.pendingOff)
        XCTAssertEqual(model.selected, .on)
        XCTAssertEqual(LiveThenArchiveMode.current(d), .on)
    }

    func testOffFromShadowNeedsNoConfirmation() {
        let d = defaults()
        d.set("shadow", forKey: "lta.mode")
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .shadow)
        XCTAssertTrue(model.choose(.off))
        XCTAssertEqual(LiveThenArchiveMode.current(d), .off)
    }

    func testOffStillAsksWhenOnIsStillRunningEvenAfterSteppingDown() {
        // On was running at launch, the user went on -> shadow (no prompt), then shadow -> off: archived chats exist.
        let d = defaults()
        d.set("on", forKey: "lta.mode")
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .on)
        model.choose(.shadow)
        XCTAssertFalse(model.choose(.off))
        XCTAssertTrue(model.pendingOff)
    }

    func testPickingAnotherModeWhileAskingClearsThePrompt() {
        let d = defaults()
        d.set("on", forKey: "lta.mode")
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .on)
        model.choose(.off)
        model.choose(.shadow)
        XCTAssertFalse(model.pendingOff)
        XCTAssertEqual(model.selected, .shadow)
    }

    func testRepeatedSwitchingEndsAtTheLastChoice() {
        let d = defaults()
        let model = LiveThenArchiveSettingModel(defaults: d, launchMode: .off)
        for m in [LiveThenArchiveMode.on, .shadow, .on, .shadow, .off] { model.choose(m) }
        XCTAssertEqual(LiveThenArchiveMode.current(d), model.selected)
    }

    func testEveryModeHasWordsAndTheConfirmationSaysChatsAreKept() {
        for m in [LiveThenArchiveMode.off, .shadow, .on] {
            XCTAssertFalse(LiveThenArchiveWording.title(m).isEmpty)
            XCTAssertFalse(LiveThenArchiveWording.explanation(m).isEmpty)
        }
        XCTAssertTrue(LiveThenArchiveWording.offConfirmMessage.contains("kept"))
        XCTAssertTrue(LiveThenArchiveWording.restartNote.contains("next time"))
    }
}
