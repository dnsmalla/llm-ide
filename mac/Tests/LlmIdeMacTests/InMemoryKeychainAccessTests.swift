import XCTest
@testable import LlmIdeMacLib

/// `InMemoryKeychainAccess` is what `LLMIDE_KEYCHAIN_BACKEND=memory` swaps in
/// for the whole test process, so it has to honour the same contract as the
/// real `SecItem*` backend — above all keeping "not found" distinct from a
/// failure, which is the distinction `KeychainStore` protects stored secrets
/// with. (Why the swap exists at all: on a headless CI runner a real keychain
/// decrypt blocks in securityd forever — mac-ci run 33969805853.)
final class InMemoryKeychainAccessTests: XCTestCase {
    func testRoundTripAndNotFoundAreDistinct() {
        let kc = InMemoryKeychainAccess()
        XCTAssertEqual(kc.read(account: "a", service: "s"), .notFound)
        XCTAssertTrue(kc.write(account: "a", service: "s", data: Data("one".utf8)))
        XCTAssertEqual(kc.read(account: "a", service: "s"), .found(Data("one".utf8)))
        // Overwrite in place, like SecItemUpdate.
        XCTAssertTrue(kc.write(account: "a", service: "s", data: Data("two".utf8)))
        XCTAssertEqual(kc.read(account: "a", service: "s"), .found(Data("two".utf8)))
        kc.delete(account: "a", service: "s")
        XCTAssertEqual(kc.read(account: "a", service: "s"), .notFound)
    }

    func testItemsAreScopedByService() {
        let kc = InMemoryKeychainAccess()
        _ = kc.write(account: "a", service: "s1", data: Data("x".utf8))
        _ = kc.write(account: "a", service: "s2", data: Data("y".utf8))
        XCTAssertEqual(kc.read(account: "a", service: "s2"), .found(Data("y".utf8)))
        XCTAssertEqual(kc.deleteAll(service: "s1"), errSecSuccess)
        XCTAssertEqual(kc.read(account: "a", service: "s1"), .notFound)
        XCTAssertEqual(kc.read(account: "a", service: "s2"), .found(Data("y".utf8)))
        XCTAssertEqual(kc.deleteAll(service: "s1"), errSecItemNotFound, "nothing left to delete")
    }
}
