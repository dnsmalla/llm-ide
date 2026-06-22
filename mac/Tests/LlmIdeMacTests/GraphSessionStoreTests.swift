import XCTest
import GraphKit
@testable import LlmIdeMac

/// The session store gained a `docFingerprint` so a manual InfiniteBrain
/// re-generate can be skipped when the doc set is unchanged. The subtlety: a
/// stored fingerprint must survive a later re-store that doesn't carry one
/// (settlePhysics re-caches the settled layout; hydrate re-caches after layout),
/// or the reuse fast-path would never see a fingerprint to match against.
@MainActor
final class GraphSessionStoreTests: XCTestCase {
    private func sampleGraph() -> CGData {
        CGData(nodes: [CGNode(id: "n", title: "n", kind: .file)], edges: [])
    }

    func testStorePreservesDocFingerprintWhenNotProvided() {
        let store = GraphSessionStore()
        let repo = URL(fileURLWithPath: "/x/repo")
        store.store(repo: repo, mode: "data", graph: sampleGraph(), docFingerprint: "fp-1")
        XCTAssertEqual(store.entry(repo: repo, mode: "data")?.docFingerprint, "fp-1")

        // Re-store the settled layout with no fingerprint — must keep "fp-1".
        store.store(repo: repo, mode: "data", graph: sampleGraph(), laidOut: true)
        XCTAssertEqual(store.entry(repo: repo, mode: "data")?.docFingerprint, "fp-1")
        XCTAssertEqual(store.entry(repo: repo, mode: "data")?.laidOut, true)
    }

    func testStoreUpdatesDocFingerprintWhenProvided() {
        let store = GraphSessionStore()
        let repo = URL(fileURLWithPath: "/x/repo")
        store.store(repo: repo, mode: "data", graph: sampleGraph(), docFingerprint: "fp-1")
        store.store(repo: repo, mode: "data", graph: sampleGraph(), docFingerprint: "fp-2")
        XCTAssertEqual(store.entry(repo: repo, mode: "data")?.docFingerprint, "fp-2")
    }
}
