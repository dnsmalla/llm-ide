import Testing
import Foundation
@testable import MeetNotesMac

struct FingerprintTests {
    @Test func hashIsStableForSameContent() {
        let a = Fingerprint.hash(of: Data("hello".utf8))
        let b = Fingerprint.hash(of: Data("hello".utf8))
        #expect(a == b)
        #expect(!a.isEmpty)
    }

    @Test func hashDiffersForDifferentContent() {
        let a = Fingerprint.hash(of: Data("hello".utf8))
        let b = Fingerprint.hash(of: Data("world".utf8))
        #expect(a != b)
    }

    @Test func classifyDetectsUnchangedChangedNewDeleted() {
        let previous = ["a.ts": "h1", "b.ts": "h2", "gone.ts": "h3"]
        let current  = ["a.ts": "h1", "b.ts": "CHANGED", "new.ts": "h4"]
        let result = Fingerprint.classify(previous: previous, current: current)
        #expect(result.unchanged == ["a.ts"])
        #expect(result.changed.sorted() == ["b.ts", "new.ts"])
        #expect(result.deleted == ["gone.ts"])
    }

    @Test func storeRoundTripsThroughJSON() throws {
        let store = FingerprintStore(hashes: ["a.ts": "h1", "b.ts": "h2"])
        let data = try store.encoded()
        let restored = try FingerprintStore.decode(data)
        #expect(restored.hashes == store.hashes)
    }
}
