import XCTest
@testable import SharedProtocol

final class GenerationMessagesTests: XCTestCase {
    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }

    func testRunRoundTripsAndCarriesTag() throws {
        let run = GenerationRun(commandId: "c1", surface: "visual", templateId: "T",
                                commandRefId: nil, prompt: "p",
                                sources: [GenerationSource(name: "a.md", text: "hi")])
        XCTAssertEqual(try roundTrip(run), run)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(run)) as? [String: Any]
        XCTAssertEqual(json?["type"] as? String, "generation_run")
    }

    func testResultKeepsMarkdownWhenSaveFailed() throws {
        let r = GenerationResult(commandId: "c", ok: true, title: "t", markdown: "# x",
                                 savedPath: nil, error: "disk full")
        let back = try roundTrip(r)
        XCTAssertEqual(back.markdown, "# x")
        XCTAssertNil(back.savedPath)
    }

    func testOptionsAndListingRoundTrip() throws {
        let o = GenerationOptions(available: true, projectName: "p",
                                  templates: [GenerationChoice(id: "1", name: "n", surface: "doc")],
                                  commands: [], saveFolder: "llm-doc/generated")
        XCTAssertEqual(try roundTrip(o), o)
        let l = LlmDocListing(path: "plans", entries: [LlmDocEntry(name: "a.md", isDirectory: false, size: 3, modified: 1)])
        XCTAssertEqual(try roundTrip(l), l)
    }

    func testTagsAreDistinct() {
        let tags = [MobileProtocol.Tag.generationOptionsList, MobileProtocol.Tag.generationOptions,
                    MobileProtocol.Tag.generationRun, MobileProtocol.Tag.generationResult,
                    MobileProtocol.Tag.llmDocList, MobileProtocol.Tag.llmDocListing,
                    MobileProtocol.Tag.llmDocRead, MobileProtocol.Tag.llmDocFile]
        XCTAssertEqual(Set(tags).count, tags.count)
    }

    func testConnectedCarriesCapabilitiesAndDecodesAnOlderMacFrame() throws {
        let c = Connected(deviceName: "Mac", protocolVersion: MobileProtocol.protocolVersion,
                          capabilities: [MobileProtocol.Capability.chat, MobileProtocol.Capability.generation])
        XCTAssertEqual(try roundTrip(c), c)
        // A Mac from before the handshake sends neither field.
        let old = Data(#"{"type":"connected","deviceName":"Old Mac"}"#.utf8)
        let decoded = try JSONDecoder().decode(Connected.self, from: old)
        XCTAssertNil(decoded.capabilities)
        XCTAssertNil(decoded.protocolVersion)
        // …and an older PHONE must tolerate extra fields it doesn't know (default Codable ignores them).
        XCTAssertFalse(MobileProtocol.Capability.legacy.contains(MobileProtocol.Capability.generation))
        XCTAssertTrue(MobileProtocol.Capability.legacy.contains(MobileProtocol.Capability.loop))
    }

    func testActivityStateRoundTripsAndTagsAreStable() throws {
        let state = ActivityState(entries: [ActivityEntry(id: 7, kind: nil, title: "t", createdAt: 5)], unread: 1)
        XCTAssertEqual(try roundTrip(state), state)
        XCTAssertEqual(MobileProtocol.Tag.activityState, "activity_state")
        XCTAssertEqual(MobileProtocol.Tag.activityList, "activity_list")
        XCTAssertEqual(MobileProtocol.Tag.activityMarkSeen, "activity_mark_seen")
        XCTAssertFalse(MobileProtocol.Capability.legacy.contains(MobileProtocol.Capability.activity))
    }

    func testUsageStateRoundTrips() throws {
        let state = UsageState(provider: "anthropic", status: "ok", statusReason: nil, activeModel: "opus",
                               models: [UsageMeter(name: "Opus", pct: 5, state: "ok", detail: "d")],
                               subscription: [], subscriptionNote: "n", permissionMode: "review", error: nil)
        XCTAssertEqual(try roundTrip(state), state)
        XCTAssertEqual(MobileProtocol.Tag.usageGet, "usage_get")
        XCTAssertFalse(MobileProtocol.Capability.legacy.contains(MobileProtocol.Capability.usage))
    }
}
