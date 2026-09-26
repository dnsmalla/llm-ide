import Foundation

/// The backend's Claude Agent SDK version and in-place update
/// (`extension/llm_agent/sdk/updater.mjs`, server API v57).
struct AgentSdkStatus: Decodable, Equatable {
    /// The version the running backend loaded at startup.
    let running: String?
    /// The version installed on disk — differs from `running` after an
    /// update until the backend restarts.
    let installed: String?
    let latest: String?
    let updateAvailable: Bool
    let restartNeeded: Bool
    let updating: Bool
    /// False while remote access is on (an update runs npm on the host).
    let canUpdate: Bool
    let error: String?
}

struct AgentSdkUpdateResult: Decodable, Equatable {
    let ok: Bool
    let from: String?
    let to: String?
    let rolledBack: Bool
    let restartNeeded: Bool
    let log: String?
}

extension LlmIdeAPIClient {
    func agentSdkStatus(force: Bool = false) async throws -> AgentSdkStatus {
        try await get(force ? "/kb/agent-sdk?force=1" : "/kb/agent-sdk", authenticated: true)
    }

    /// Installs the registry's latest SDK (smoke-checked, rolled back on
    /// failure). Can take minutes — it downloads the bundled Claude binary.
    func updateAgentSdk() async throws -> AgentSdkUpdateResult {
        struct Empty: Encodable {}
        return try await post("/kb/agent-sdk/update", body: Empty(), authenticated: true)
    }
}
