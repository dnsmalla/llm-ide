import Foundation

typealias BoxTestResult = LlmIdeAPIClient.BoxTestResult
typealias BoxIndexResult = LlmIdeAPIClient.BoxIndexResult

// External Box source endpoints. The CCG client secret is written to the
// server vault via `setSecret` (key `box.clientSecret`) — `/kb/box/test`
// and `/kb/connect-box` read it back for the calling user. Mirrors +Slack.
extension LlmIdeAPIClient {

    struct BoxTestResult: Decodable {
        let ok: Bool
        let folderName: String
        let itemCount: Int
    }

    struct BoxIndexResult: Decodable {
        let ok: Bool
        let indexed: Int        // chunk-rows written
        let skipped: Int        // files with no extractable text
        let files: Int?         // files that produced rows (optional: older servers omit it)
        let truncated: Bool?    // true when a file/depth cap cut the walk short
    }

    private struct BoxReq: Encodable {
        let clientId: String
        let subjectType: String
        let subjectId: String
        let folderId: String
    }

    /// Probe a Box folder without indexing anything — confirms the CCG
    /// credentials + folder ID work and reports the folder name + item count.
    func testBox(clientId: String, subjectType: String, subjectId: String, folderId: String) async throws -> BoxTestResult {
        try await post("/kb/box/test",
                       body: BoxReq(clientId: clientId, subjectType: subjectType, subjectId: subjectId, folderId: folderId),
                       authenticated: true)
    }

    /// Wholesale re-index of a Box folder into the Library.
    func connectBox(clientId: String, subjectType: String, subjectId: String, folderId: String) async throws -> BoxIndexResult {
        try await post("/kb/connect-box",
                       body: BoxReq(clientId: clientId, subjectType: subjectType, subjectId: subjectId, folderId: folderId),
                       authenticated: true)
    }
}
