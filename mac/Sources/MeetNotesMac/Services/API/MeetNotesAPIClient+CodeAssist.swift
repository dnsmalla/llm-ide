import Foundation

extension MeetNotesAPIClient {

    struct CodeAttachment: Codable, Identifiable {
        let path: String                // display label, may be ~/-prefixed
        let content: String
        var id: String { path }
    }

    enum CodeAssistRole: String, Codable { case user, assistant }

    /// Identifiable view-model shape used by SwiftUI lists.  The `id`
    /// is client-only (not sent to the server) — encoding strips it
    /// via CodingKeys, decoding synthesizes a fresh UUID.
    struct CodeAssistTurn: Identifiable, Encodable, Decodable, Equatable {
        let id: UUID
        let role: CodeAssistRole
        let content: String
        init(role: CodeAssistRole, content: String) {
            self.id = UUID(); self.role = role; self.content = content
        }
        enum CodingKeys: String, CodingKey { case role, content }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = UUID()
            self.role = try c.decode(CodeAssistRole.self, forKey: .role)
            self.content = try c.decode(String.self, forKey: .content)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(role, forKey: .role)
            try c.encode(content, forKey: .content)
        }
    }

    struct CodeAssistRequest: Encodable {
        let message: String
        let language: String?
        let model: String?
        let history: [CodeAssistTurn]
        let attachments: [CodeAttachment]
        let agentContext: AgentContext?     // NEW — optional for back-compat
    }
    struct CodeAssistResponse: Codable {
        let reply: String
        let usage: Usage?
        let pendingTool: PendingTool?       // NEW — optional
        struct Usage: Codable {
            let attachmentCount: Int
            let attachmentChars: Int
            let paths: [String]
        }
    }

    /// One round-trip with Claude.  History is the prior turns to send
    /// for context; attachments are the files the user has dragged or
    /// picked into the panel.  Server caps payload size — anything
    /// over the limit is silently truncated, never rejected.
    func codeAssist(
        message: String,
        language: String?,
        model: String? = nil,
        history: [CodeAssistTurn],
        attachments: [CodeAttachment],
        agentContext: AgentContext? = nil,
    ) async throws -> CodeAssistResponse {
        try await post(
            "/code-assist",
            body: CodeAssistRequest(
                message: message,
                language: language,
                model: model,
                history: history,
                attachments: attachments,
                agentContext: agentContext,
            ),
            authenticated: true,
        )
    }
}
