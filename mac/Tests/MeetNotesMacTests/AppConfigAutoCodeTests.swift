import Testing
import Foundation
@testable import MeetNotesMac

@Suite("AppConfig Auto Code Update")
struct AppConfigAutoCodeTests {

    @Test func autoCodeUpdateEnabledDefaultsFalse() {
        // UserDefaults.standard won't have this key in a fresh test
        UserDefaults.standard.removeObject(forKey: "autoCodeUpdateEnabled")
        #expect(AppConfig.shared.autoCodeUpdateEnabled == false)
    }

    @Test func autoCodeUpdateLookbackCountDefaultsFive() {
        UserDefaults.standard.removeObject(forKey: "autoCodeUpdateLookbackCount")
        #expect(AppConfig.shared.autoCodeUpdateLookbackCount == 5)
    }
}
