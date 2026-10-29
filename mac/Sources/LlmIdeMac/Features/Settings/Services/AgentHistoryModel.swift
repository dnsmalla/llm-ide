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

/// Which rows a Clear covers by age. `all` sends no `beforeDays`; the others send the cutoff, in days,
/// that the server's `beforeDays` (0...3650) takes.
enum AgentHistoryClearAge: Hashable, CaseIterable, Sendable {
    case all
    case olderThan7
    case olderThan30
    case olderThan90

    var beforeDays: Int? {
        switch self {
        case .all: return nil
        case .olderThan7: return 7
        case .olderThan30: return 30
        case .olderThan90: return 90
        }
    }

    var label: String {
        switch self {
        case .all: return "All"
        case .olderThan7: return "Older than 7 days"
        case .olderThan30: return "Older than 30 days"
        case .olderThan90: return "Older than 90 days"
        }
    }

    /// Sentence fragment for the sheet title and hints.
    var phrase: String {
        beforeDays.map { "older than \($0) days" } ?? "all"
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

        /// The real delete cannot be abandoned from the UI: the sheet stays up
        /// until the server answers, so the user sees what happened.
        var isDismissible: Bool {
            if case .clearing = self { return false }
            return true
        }
    }

    @Published private(set) var report: LlmIdeAPIClient.StorageReport?
    @Published private(set) var settings: LlmIdeAPIClient.AgentHistorySettings?
    @Published private(set) var loadError: String?
    /// The stepper's value; saved explicitly, so a half-moved stepper changes nothing.
    /// Moving it clears the last save message, which no longer describes the draft.
    @Published var retentionDraft: Int = 30 {
        didSet { if oldValue != retentionDraft { retentionMessage = nil } }
    }
    @Published private(set) var savingRetention = false
    @Published private(set) var retentionMessage: String?
    @Published private(set) var clearPhase: ClearPhase = .idle
    /// Set only when a stale preview was counted again successfully.
    @Published private(set) var clearNotice: String?
    /// The age choice of the Clear in progress (or the last one). Changing it through `setClearAge` re-runs the preview.
    @Published private(set) var clearAge: AgentHistoryClearAge = .all
    @Published private(set) var compacting = false
    @Published private(set) var compactMessage: String?
    @Published private(set) var compactIsError = false

    let api: AgentHistoryAPI
    /// The Clear step in flight, so cancelling can stop it.
    private var clearTask: Task<Void, Never>?
    /// Bumped by every step start and by cancel. A step whose generation is no
    /// longer current drops its result, so a cancelled request can never reopen
    /// the sheet.
    private var generation = 0

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

    var canDismissClear: Bool { clearPhase.isDismissible }

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
            await refreshReport()
        } catch {
            retentionMessage = AgentHistoryMessages.clearFailure(error)
        }
    }

    /// Step one: a dry run. Opens the sheet with the counts; deletes nothing.
    /// Ignored while a Clear step is already running, so overlapping taps
    /// cannot start two dry runs.
    func beginClear(scope: LlmIdeAPIClient.AgentHistoryClearScope, age: AgentHistoryClearAge = .all) async {
        guard clearPhase == .idle else { return }
        clearAge = age
        await runClearStep { gen in await self.previewStep(scope, gen: gen, notice: nil) }
    }

    /// The user picked another age in the open sheet. The old preview no longer describes what would be
    /// deleted, so it is dropped and the history is counted again; the confirm button only ever sends the
    /// id of a preview made for the current choice. Ignored while counting or deleting.
    func setClearAge(_ age: AgentHistoryClearAge) async {
        guard age != clearAge else { return }
        switch clearPhase {
        case let .confirming(scope, _), let .previewing(scope):
            clearAge = age
            // Drop the old preview at once, so a confirm tap cannot pair its id with the new choice.
            clearPhase = .previewing(scope)
            await runClearStep { gen in await self.previewStep(scope, gen: gen, notice: nil) }
        default:
            return
        }
    }

    /// Step two: the real clear, with the preview's id. On a stale, expired or
    /// invalid preview nothing is deleted; the history is counted again and the
    /// user confirms the new counts.
    func confirmClear() async {
        guard case let .confirming(scope, preview) = clearPhase, let previewId = preview.previewId else { return }
        await runClearStep { gen in await self.performStep(scope, previewId: previewId, gen: gen) }
    }

    /// Dismisses the sheet and abandons a preview in flight. Refused while the
    /// real delete runs (see `ClearPhase.isDismissible`).
    func cancelClear() {
        guard clearPhase.isDismissible else { return }
        generation += 1
        clearTask?.cancel()
        clearTask = nil
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

    // MARK: - Clear steps

    /// Runs one step as the tracked task, under a fresh generation.
    private func runClearStep(_ step: @escaping @MainActor (Int) async -> Void) async {
        generation += 1
        let gen = generation
        let task = Task { @MainActor in await step(gen) }
        clearTask = task
        await task.value
    }

    private func previewStep(_ scope: LlmIdeAPIClient.AgentHistoryClearScope, gen: Int, notice: String?) async {
        clearPhase = .previewing(scope)
        clearNotice = nil
        do {
            let preview = try await api.previewAgentHistoryClear(scope: scope, beforeDays: clearAge.beforeDays)
            guard gen == generation else { return }
            guard preview.previewId != nil else {
                clearPhase = .failed("The server did not return a preview. Nothing was deleted.")
                return
            }
            clearNotice = notice
            clearPhase = .confirming(scope, preview)
        } catch {
            guard gen == generation else { return }
            clearPhase = .failed(AgentHistoryMessages.clearFailure(error))
        }
    }

    private func performStep(_ scope: LlmIdeAPIClient.AgentHistoryClearScope,
                             previewId: String, gen: Int) async {
        clearPhase = .clearing(scope)
        do {
            let result = try await api.performAgentHistoryClear(scope: scope, beforeDays: clearAge.beforeDays, previewId: previewId)
            guard gen == generation else { return }
            clearPhase = .cleared(result)
            await refreshReport()
        } catch {
            guard gen == generation else { return }
            if AgentHistoryMessages.isStalePreview(error) {
                await previewStep(scope, gen: gen, notice: AgentHistoryMessages.staleNotice(for: error))
            } else {
                clearPhase = .failed(AgentHistoryMessages.clearFailure(error))
            }
        }
    }

    private func refreshReport() async {
        if let fresh = try? await api.storageReport() { report = fresh }
    }
}
