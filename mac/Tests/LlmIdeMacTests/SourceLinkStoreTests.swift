import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceLinkStoreTests: XCTestCase {
    func testEmailLinkedViaImapPassword() {
        XCTAssertEqual(SourceLinkStore.linkState(.email, configured: true, presentKeys: ["email.imapPassword"]), .linked)
    }
    func testEmailLinkedViaGoogleRefreshToken() {
        XCTAssertEqual(SourceLinkStore.linkState(.email, configured: true, presentKeys: ["google.email.refreshToken"]), .linked)
    }
    func testBoxAndSlackSecretKeys() {
        XCTAssertEqual(SourceLinkStore.linkState(.box, configured: true, presentKeys: ["box.clientSecret"]), .linked)
        XCTAssertEqual(SourceLinkStore.linkState(.slack, configured: true, presentKeys: ["slack.botToken"]), .linked)
    }
    func testSlackLinkedViaUserToken() {
        XCTAssertEqual(SourceLinkStore.linkState(.slack, configured: true, presentKeys: ["slack.userToken"]), .linked)
    }
    func testCredentialsNeededWhenConfiguredButSecretMissing() {
        XCTAssertEqual(SourceLinkStore.linkState(.slack, configured: true, presentKeys: []), .credentialsNeeded)
        XCTAssertEqual(SourceLinkStore.linkState(.box, configured: true, presentKeys: ["email.imapPassword"]), .credentialsNeeded)
    }
    func testNotConfiguredWhenNoLocalConfig() {
        XCTAssertEqual(SourceLinkStore.linkState(.email, configured: false, presentKeys: ["email.imapPassword"]), .notConfigured)
    }
    func testHasSecretPerKind() {
        XCTAssertTrue(SourceLinkStore.hasSecret(.slack, presentKeys: ["slack.botToken"]))
        XCTAssertFalse(SourceLinkStore.hasSecret(.slack, presentKeys: ["email.imapPassword"]))
    }
}
