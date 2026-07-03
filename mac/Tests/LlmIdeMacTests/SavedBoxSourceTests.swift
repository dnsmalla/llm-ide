import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("SavedBoxSource persistence")
struct SavedBoxSourceTests {
    @Test func boxSourceRoundTripsThroughUserDefaults() {
        let name = "box-src-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let cfg = AppConfig(userDefaults: d)
        var s = SavedBoxSource()
        s.displayName = "Docs"; s.clientId = "cid"; s.subjectType = "enterprise"
        s.subjectId = "42"; s.folderId = "F1"; s.enabled = true
        cfg.boxSource = s
        let reloaded = AppConfig(userDefaults: d)
        #expect(reloaded.boxSource?.clientId == "cid")
        #expect(reloaded.boxSource?.folderId == "F1")
        #expect(reloaded.boxSource?.subjectType == "enterprise")
    }

    @Test func absentBoxSourceIsNil() {
        let name = "box-src-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        #expect(AppConfig(userDefaults: d).boxSource == nil)
    }
}
