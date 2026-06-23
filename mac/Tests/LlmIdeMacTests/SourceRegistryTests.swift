import Testing
@testable import LlmIdeMac

/// The registry is the single place sources are declared and looked up.
struct SourceRegistryTests {
    @Test("email platform resolves to the email source")
    func emailPlatform() {
        #expect(SourceRegistry.source(forPlatform: "email").id == "email")
        #expect(SourceRegistry.source(forPlatform: "EMAIL").id == "email")
    }

    @Test("meeting platforms resolve to the meeting source")
    func meetingPlatforms() {
        for p in ["meet", "teams", "zoom", "mic", "Meet"] {
            #expect(SourceRegistry.source(forPlatform: p).id == "meeting")
        }
    }

    @Test("unknown or empty platform defaults to the meeting source")
    func unknownDefaults() {
        #expect(SourceRegistry.source(forPlatform: "").id == "meeting")
        #expect(SourceRegistry.source(forPlatform: "slack").id == "meeting")
    }

    @Test("id lookup finds registered sources, nil otherwise")
    func idLookup() {
        #expect(SourceRegistry.source(id: "email")?.id == "email")
        #expect(SourceRegistry.source(id: "meeting")?.id == "meeting")
        #expect(SourceRegistry.source(id: "nope") == nil)
    }

    @Test("fetchSources contains fetch sources and excludes live capture")
    func fetchSources() {
        let ids = SourceRegistry.fetchSources.map(\.id)
        #expect(ids.contains("email"))
        #expect(!ids.contains("meeting"))
    }

    @Test("every source has display metadata")
    func metadata() {
        for s in SourceRegistry.all {
            #expect(!s.displayName.isEmpty)
            #expect(!s.icon.isEmpty)
            #expect(!s.emptyText.isEmpty)
            #expect(!s.platforms.isEmpty)
        }
    }
}
