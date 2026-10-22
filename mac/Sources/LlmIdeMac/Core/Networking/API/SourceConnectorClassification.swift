import Foundation

/// `/kb/.../classify` response (twin of `LlmIdeAPIClient.EmailClassification`).
///
/// Declared here rather than beside `SourceConnectorAdapter` in Library because
/// it is the decode target of `LlmIdeAPIClient.postClassification`: Core is a
/// leaf and must not name a feature-owned type, while the connector engine in
/// Library may freely use this Core model.
struct SourceConnectorClassification: Decodable, Equatable {
    let category: String
    let noteWorthy: Bool
    let summary: String
    let todos: [Todo]
    struct Todo: Decodable, Equatable {
        let title: String
        let detail: String
        let due: String?
        let priority: String
    }
}
