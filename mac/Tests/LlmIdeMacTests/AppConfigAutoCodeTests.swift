import Testing
import Foundation
@testable import LlmIdeMac

@Suite("AppConfig Auto Code Update")
struct AppConfigAutoCodeTests {

    @Test func autoCodeUpdateLookbackCountDefaultsFive() {
        UserDefaults.standard.removeObject(forKey: "autoCodeUpdateLookbackCount")
        #expect(AppConfig.shared.autoCodeUpdateLookbackCount == 5)
    }
}
