import Testing
import Foundation
@testable import MeetNotesMac

@Suite("AppConfig Auto Task Templates")
struct AppConfigAutoTaskTemplatesTests {

    @Test func reviewCodeTemplateDefaultIsNonEmpty() {
        UserDefaults.standard.removeObject(forKey: "autoTaskTemplateReviewCode")
        #expect(!AppConfig.shared.autoTaskTemplateReviewCode.isEmpty)
    }

    @Test func reviewDocTemplateDefaultIsNonEmpty() {
        UserDefaults.standard.removeObject(forKey: "autoTaskTemplateReviewDoc")
        #expect(!AppConfig.shared.autoTaskTemplateReviewDoc.isEmpty)
    }

    @Test func reviewConflictsTemplateDefaultIsNonEmpty() {
        UserDefaults.standard.removeObject(forKey: "autoTaskTemplateReviewConflicts")
        #expect(!AppConfig.shared.autoTaskTemplateReviewConflicts.isEmpty)
    }
}
