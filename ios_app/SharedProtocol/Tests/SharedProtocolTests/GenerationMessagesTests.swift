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
}
