import Testing
import Foundation
@testable import LlmIdeMac
@MainActor @Suite("SavedEmailSource authMethod")
struct SavedEmailSourceAuthMethodTests {
  @Test func defaultsToPasswordAndRoundTrips() {
    let n = "em-\(UUID().uuidString)"; let d = UserDefaults(suiteName: n)!; d.removePersistentDomain(forName: n)
    let cfg = AppConfig(userDefaults: d)
    var s = SavedEmailSource(); s.user = "a@b"; s.authMethod = "google"
    cfg.emailSource = s
    #expect(AppConfig(userDefaults: d).emailSource?.authMethod == "google")
    // A source decoded without the key defaults to "password".
    var legacy = SavedEmailSource(); #expect(legacy.authMethod == "password")
  }
}
