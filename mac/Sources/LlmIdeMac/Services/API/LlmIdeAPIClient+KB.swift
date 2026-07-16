import Foundation

// Top-level typealiases so existing call sites that reference these
// without the LlmIdeAPIClient prefix continue to compile.
typealias IngestRequest = LlmIdeAPIClient.IngestRequest
typealias IngestEntity = LlmIdeAPIClient.IngestEntity

extension LlmIdeAPIClient {

    struct IngestRequest: Encodable {
        let id: String
        let title: String
        let date: String
        let duration: Int
        let language: String?
        let participants: [String]
        let transcript: String
        let entities: [IngestEntity]
        /// Optional bundle id of the active project — server stamps it
        /// onto `meta.projectId` so search can scope by project later.
        /// Encoded only when non-nil so untagged ingests stay untagged.
        var projectId: String? = nil
    }

    struct IngestEntity: Encodable {
        let id: String
        let kind: String
        let text: String
        let quote: String?
        let meta: [String: String]
    }

    struct SearchHit: Codable, Identifiable {
        let kind: String
        let meetingId: String?
        let entityId: String?
        let title: String
        let body: String?
        let date: String?
        let meetingTitle: String?
        let ref: String?
        let rank: Double?
        var id: String { "\(kind)-\(entityId ?? meetingId ?? title)" }
    }

    struct MeetingDetail: Codable {
        let id: String
        let title: String
        let date: String?
        let durationSec: Int?
        let language: String?
        let participants: [String]?
        let transcript: String?
        let entities: [ExtractedEntity]?
    }

    struct ExtractedEntity: Codable, Identifiable {
        /// Server returns an `id` (string).  When missing — e.g. fresh
        /// extraction not yet persisted — we synthesize from kind+text.
        let id: String
        let kind: String                // "action" | "decision" | "blocker"
        let text: String
        let quote: String?
        let meta: AnyCodable?
    }
    // ExtractEntitiesRequest / Response + the matching extractEntities()
    // method were removed — no Mac call site invoked them. The Chrome
    // extension still hits the server's POST /extract-entities; the
    // Mac never did because meeting ingestion handles entity extraction
    // server-side inside /kb/ingest. ExtractedEntity stays because
    // MeetingDetail.entities (consumed by DocGenViewModel) decodes
    // through it.

    // --- KB methods --------------------------------------------------

    func ingestMeeting(_ payload: IngestRequest) async throws -> [String: AnyCodable] {
        // Stamp the active project's id onto the payload at call time
        // if the caller didn't already supply one.  Read on MainActor
        // because ProjectStore is main-actor-isolated; nil store (e.g.
        // test paths that don't wire one) leaves projectId absent which
        // the server treats identically to existing untagged rows.
        var stamped = payload
        if stamped.projectId == nil {
            stamped.projectId = await MainActor.run { _projectStore?.activeProject?.bundle.id }
        }
        return try await post("/kb/ingest", body: stamped, authenticated: true)
    }

    func listPlans() async throws -> [PlanSummary] {
        struct Wrap: Decodable { let plans: [PlanSummary] }
        let r: Wrap = try await get("/kb/plans", authenticated: true)
        return r.plans
    }

    func getPlan(id: String) async throws -> Plan {
        try await get("/kb/plan/\(percentEncoded(id))", authenticated: true)
    }

    func search(q: String?, kind: String? = nil, limit: Int = 30) async throws -> [SearchHit] {
        struct Wrap: Decodable { let results: [SearchHit] }
        guard var q1 = URLComponents(string: baseURL + "/kb/search") else {
            throw APIError.invalidURL
        }
        var items: [URLQueryItem] = []
        if let q, !q.isEmpty { items.append(URLQueryItem(name: "q", value: q)) }
        if let kind, !kind.isEmpty, kind != "all" { items.append(URLQueryItem(name: "kind", value: kind)) }
        items.append(URLQueryItem(name: "limit", value: String(limit)))
        q1.queryItems = items
        guard let url = q1.url else { throw APIError.invalidURL }
        let path = url.absoluteString.replacingOccurrences(of: baseURL, with: "")
        let r: Wrap = try await get(path, authenticated: true)
        return r.results
    }

    func getMeeting(id: String) async throws -> MeetingDetail {
        try await get("/kb/meeting/\(percentEncoded(id))", authenticated: true)
    }

    // MARK: - Project export

    /// Fetch all meetings (with entities) and plans (with tasks) for a project
    /// in a single round-trip.  Used by `ProjectExporter` on project close to
    /// write the canonical folder tree.
    func exportProject(projectId: String) async throws -> ProjectExportBundle {
        try await get(
            "/kb/project/\(percentEncoded(projectId))/export",
            authenticated: true)
    }

    // MARK: - Project skills install

    /// Result of `POST /kb/project/install-skills` — wires the central
    /// skills kit into a project folder for Claude / Cursor / Codex / …
    struct InstallProjectSkillsResult: Decodable {
        let ok: Bool
        let path: String
        let kit: String
        let stacks: String
        let tools: [String]
        let stdout: String?
    }

    /// Install (or refresh) the central skills kit into `path`.
    /// Requires the folder to already be a LLM IDE project
    /// (`system/project.json`). Best-effort from the Mac scaffolder —
    /// failures are logged, not fatal to project open.
    func installProjectSkills(path: String,
                              language: String? = nil,
                              stacks: String? = nil) async throws -> InstallProjectSkillsResult {
        struct Req: Encodable {
            let path: String
            let language: String?
            let stacks: String?
        }
        return try await post(
            "/kb/project/install-skills",
            body: Req(path: path, language: language, stacks: stacks),
            authenticated: true)
    }

}
