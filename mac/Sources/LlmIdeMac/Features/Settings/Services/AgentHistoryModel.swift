import Foundation
import SwiftUI

/// The calls the Agent history card makes. `LlmIdeAPIClient` conforms; tests
/// substitute a fake so the Clear flow's state changes can be checked without a
/// server.
protocol AgentHistoryAPI: AnyObject {
    func storageReport() async throws -> LlmIdeAPIClient.StorageReport
    func agentHistorySettings() async throws -> LlmIdeAPIClient.AgentHistorySettings
    func setAgentHistoryRetention(days: Int) async throws -> LlmIdeAPIClient.AgentHistorySettings
    func previewAgentHistoryClear(scope: LlmIdeAPIClient.AgentHistoryClearScope,
                                  beforeDays: Int?) async throws -> LlmIdeAPIClient.AgentHistoryClearResult
    func performAgentHistoryClear(scope: LlmIdeAPIClient.AgentHistoryClearScope,
                                  beforeDays: Int?,
                                  previewId: String) async throws -> LlmIdeAPIClient.AgentHistoryClearResult
    func compactAgentHistory() async throws -> LlmIdeAPIClient.AgentHistoryCompactResult
}

extension LlmIdeAPIClient: AgentHistoryAPI {}

/// Pure rules behind the Agent history card: which server answers mean the
/// confirmed preview is no good, and the words each answer shows. No state here.
enum AgentHistoryMessages {
    /// Codes that mean "the preview you confirmed no longer applies": expired,
    /// not valid for this scope or cutoff, or the rows moved since it was made.
    static let stalePreviewCodes: Set<String> = ["PREVIEW_EXPIRED", "PREVIEW_INVALID", "preview_stale"]

    /// The server's error code and message, when the error came from a server answer.
    static func serverError(_ error: Error) -> (code: String, message: String)? {
        guard let api = error as? APIError, case let .http(_, code, message, _) = api else { return nil }
        return (code, message)
    }

    static func isStalePreview(_ error: Error) -> Bool {
        guard let server = serverError(error) else { return false }
        return stalePreviewCodes.contains(server.code)
    }

    /// Notice shown above a fresh preview after a stale one was refused.
    static func staleNotice(for error: Error) -> String {
        switch serverError(error)?.code {
        case "PREVIEW_EXPIRED":
            return "The preview expired, so the history was counted again. Check the new counts before you confirm."
        case "preview_stale":
            return "The history changed after the preview, so it was counted again. Check the new counts before you confirm."
        default:
            return "The preview no longer matches, so the history was counted again. Check the new counts before you confirm."
        }
    }

    static func clearFailure(_ error: Error) -> String {
        if let server = serverError(error) { return server.message }
        return error.localizedDescription
    }

    /// What the Compact button says when the server refuses or fails.
    static func compactFailure(_ error: Error) -> String {
        switch serverError(error)?.code {
        case "busy":
            return "A chat turn or meeting-agent run is in progress. Compact again when it finishes."
        case "disk_space":
            return "Not enough free disk space to compact the agent history. Free some space and try again."
        case "AGENT_STORE_UNAVAILABLE":
            return "The agent history store is not available. Restart the backend to reopen it."
        default:
            return clearFailure(error)
        }
    }

    static func compactSuccess(_ result: LlmIdeAPIClient.AgentHistoryCompactResult) -> String {
        let before = ByteCountFormatter.string(fromByteCount: Int64(result.bytesBefore), countStyle: .file)
        let after = ByteCountFormatter.string(fromByteCount: Int64(result.bytesAfter), countStyle: .file)
        return "Compacted (\(result.mode)): freed \(result.pagesFreed) pages, \(before) to \(after)."
    }

    static func clearSuccess(_ result: LlmIdeAPIClient.AgentHistoryClearResult) -> String {
        if result.total == 0 { return "Nothing to delete. The history was already empty." }
        return "Deleted \(result.total) rows."
    }

    static func rowLabel(_ key: String) -> String {
        switch key {
        case "agent_runs": return "Runs"
        case "agent_tool_events": return "Tool events"
        case "turn_composition": return "Turn composition"
        case "agent_daily": return "Daily rollups"
        case "agent_daily_tools": return "Daily tool rollups"
        default: return key
        }
    }
}

/// Parses the ISO-8601 times the server sends, with or without fractional seconds.
enum AgentHistoryDates {
    static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        return ISO8601DateFormatter().date(from: iso)
    }
}

/// State and actions of the Agent history card. The Clear flow is a small state
/// machine: `beginClear` previews (dry run), `confirmClear` performs the real
/// clear with that preview's id, and a stale preview is counted again rather
/// than deleting anything.
@MainActor
final class AgentHistoryModel: ObservableObject {

    enum ClearPhase: Equatable {
        case idle
        case previewing(LlmIdeAPIClient.AgentHistoryClearScope)
        /// The dry run's counts and id; nothing is deleted until `confirmClear`.
        case confirming(LlmIdeAPIClient.AgentHistoryClearScope, LlmIdeAPIClient.AgentHistoryClearResult)
        case clearing(LlmIdeAPIClient.AgentHistoryClearScope)
        case cleared(LlmIdeAPIClient.AgentHistoryClearResult)
        case failed(String)

        /// True while the clear sheet is on screen.
        var isPresented: Bool { self != .idle }
    }

    @Published private(set) var report: LlmIdeAPIClient.StorageReport?
    @Published private(set) var settings: LlmIdeAPIClient.AgentHistorySettings?
    @Published private(set) var loadError: String?
    /// The stepper's value; saved explicitly, so a half-moved stepper changes nothing.
    @Published var retentionDraft: Int = 30
    @Published private(set) var savingRetention = false
    @Published private(set) var retentionMessage: String?
    @Published private(set) var clearPhase: ClearPhase = .idle
    /// Set when a stale preview was refused and counted again.
    @Published private(set) var clearNotice: String?
    @Published private(set) var compacting = false
    @Published private(set) var compactMessage: String?
    @Published private(set) var compactIsError = false

    let api: AgentHistoryAPI

    init(api: AgentHistoryAPI) {
        self.api = api
    }

    var retentionRange: ClosedRange<Int> {
        guard let settings else { return 7...365 }
        return settings.min...settings.max
    }

    var retentionChanged: Bool {
        settings.map { $0.retentionDays != retentionDraft } ?? false
    }

    func load() async {
        do {
            async let storage = api.storageReport()
            async let prefs = api.agentHistorySettings()
            let (loadedReport, loadedSettings) = try await (storage, prefs)
            report = loadedReport
            settings = loadedSettings
            retentionDraft = loadedSettings.retentionDays
            loadError = nil
        } catch {
            loadError = AgentHistoryMessages.clearFailure(error)
        }
    }

    func saveRetention() async {
        guard retentionChanged else { return }
        savingRetention = true
        defer { savingRetention = false }
        let requested = retentionDraft
        do {
            let saved = try await api.setAgentHistoryRetention(days: requested)
            settings = saved
            retentionDraft = saved.retentionDays
            retentionMessage = saved.retentionDays == requested
                ? "Saved. Raw history is kept for \(saved.retentionDays) days."
                : "Saved as \(saved.retentionDays) days; the limit is \(saved.min) to \(saved.max)."
        } catch {
            retentionMessage = AgentHistoryMessages.clearFailure(error)
        }
    }

    /// Step one: a dry run. Opens the sheet with the counts; deletes nothing.
    func beginClear(scope: LlmIdeAPIClient.AgentHistoryClearScope) async {
        clearNotice = nil
        clearPhase = .previewing(scope)
        do {
            let preview = try await api.previewAgentHistoryClear(scope: scope, beforeDays: nil)
            guard preview.previewId != nil else {
                clearPhase = .failed("The server did not return a preview. Nothing was deleted.")
                return
            }
            clearPhase = .confirming(scope, preview)
        } catch {
            clearPhase = .failed(AgentHistoryMessages.clearFailure(error))
        }
    }

    /// Step two: the real clear, with the preview's id. On a stale, expired or
    /// invalid preview nothing is deleted; the history is counted again and the
    /// user confirms the new counts.
    func confirmClear() async {
        guard case let .confirming(scope, preview) = clearPhase, let previewId = preview.previewId else { return }
        clearPhase = .clearing(scope)
        do {
            let result = try await api.performAgentHistoryClear(scope: scope, beforeDays: nil, previewId: previewId)
            clearPhase = .cleared(result)
            await refreshReport()
        } catch {
            if AgentHistoryMessages.isStalePreview(error) {
                let notice = AgentHistoryMessages.staleNotice(for: error)
                await beginClear(scope: scope)
                clearNotice = notice
            } else {
                clearPhase = .failed(AgentHistoryMessages.clearFailure(error))
            }
        }
    }

    func cancelClear() {
        clearPhase = .idle
        clearNotice = nil
    }

    func compact() async {
        compacting = true
        compactMessage = nil
        defer { compacting = false }
        do {
            let result = try await api.compactAgentHistory()
            compactIsError = false
            compactMessage = AgentHistoryMessages.compactSuccess(result)
            await refreshReport()
        } catch {
            compactIsError = true
            compactMessage = AgentHistoryMessages.compactFailure(error)
        }
    }

    private func refreshReport() async {
        if let fresh = try? await api.storageReport() { report = fresh }
    }
}
