import XCTest
@testable import LlmIdeMacLib

/// The Issues board and Gantt timeline both reported "No repository connected"
/// whenever no token was readable — including when the repository was saved,
/// active and cloned, and only the credential had gone missing. That message
/// sends the user looking for the wrong thing.
final class RepoConnectionEmptyStateTests: XCTestCase {

    func testNothingConfiguredAsksForTheFirstConnection() {
        let s = RepoConnectionEmptyState(hasSavedRepo: false, keychainUnreadable: false)
        XCTAssertEqual(s.title, "No repository connected")
        XCTAssertTrue(s.message(surface: "browsing issues").contains("browsing issues"))
    }

    /// The case that made the original report confusing.
    func testSavedRepoWithNoTokenNamesTheTokenAsTheGap() {
        let s = RepoConnectionEmptyState(hasSavedRepo: true, keychainUnreadable: false)
        XCTAssertEqual(s.title, "Access token missing")
        let msg = s.message(surface: "browsing issues")
        XCTAssertTrue(msg.contains("still saved"),
                      "must reassure the user their repo config survived")
        XCTAssertTrue(msg.contains("Personal Access Token"))
    }

    /// An unreadable keychain is neither of the above: nothing is lost and
    /// re-entering a token is the wrong advice.
    func testUnreadableKeychainReportsTheRealCauseAndOutranksTheOthers() {
        for hasRepo in [true, false] {
            let s = RepoConnectionEmptyState(hasSavedRepo: hasRepo, keychainUnreadable: true)
            XCTAssertEqual(s.title, "Can't read your saved credentials")
            let msg = s.message(surface: "browsing issues")
            XCTAssertTrue(msg.contains("settings are intact"))
            XCTAssertFalse(msg.contains("Add a GitLab or GitHub"),
                           "must not tell the user to re-add what is already there")
        }
    }

    /// Both surfaces share the copy; only the trailing call to action differs.
    func testSurfaceWordingIsSubstituted() {
        let s = RepoConnectionEmptyState(hasSavedRepo: false, keychainUnreadable: false)
        XCTAssertTrue(s.message(surface: "a timeline").hasSuffix("start a timeline."))
    }
}
