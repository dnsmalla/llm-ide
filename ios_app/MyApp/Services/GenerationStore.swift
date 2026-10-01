import Foundation
import SharedProtocol

/// State + send/handle logic for Doc Gen / Visual runs and the read-only
/// `llm-doc/` browser. The Mac does all the work: this asks for the template
/// list, starts a run (always saved on the Mac), and lists/reads the project's
/// `llm-doc/` folder. Mirrors `LoopStore`'s shape.
@MainActor
final class GenerationStore: ObservableObject {
    @Published var options: GenerationOptions?
    @Published var optionsError: String?
    @Published var isRunning = false
    @Published var result: GenerationResult?
    @Published var runError: String?
    /// Directory listings and files by `llm-doc`-relative path ("" = root).
    @Published var listings: [String: LlmDocListing] = [:]
    @Published var files: [String: LlmDocFile] = [:]

    weak var connection: ConnectionService?
    private var activeRunId: String?
    private var runWatchdog: Task<Void, Never>?
    private var requestWatchdogs: [String: Task<Void, Never>] = [:]

    /// A run is one blocking request on the Mac (up to ~4 minutes) with no
    /// progress signal, so the phone allows a little longer before giving up.
    static let runTimeout: TimeInterval = 300
    /// A Mac older than this feature ignores the new frames and sends nothing.
    static let replyTimeout: TimeInterval = 8

    init(connection: ConnectionService) {
        self.connection = connection
        connection.generationStore = self
    }

    // MARK: — Senders

    func refreshOptions() {
        connection?.sendEncodable(GenerationOptionsList())
        watch("options") { [weak self] in
            guard let self, self.options == nil else { return }
            self.optionsError = Self.oldMacMessage
        }
    }

    func run(surface: String, template: GenerationChoice?, command: GenerationChoice?,
             prompt: String, sources: [ChatFileText]) {
        let id = "gen_" + UUID().uuidString
        activeRunId = id
        isRunning = true
        result = nil
        runError = nil
        connection?.sendEncodable(GenerationRun(
            commandId: id, surface: surface, templateId: template?.id, commandRefId: command?.id,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : prompt,
            sources: sources.map { GenerationSource(name: $0.name, text: $0.text) }))
        runWatchdog?.cancel()
        runWatchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.runTimeout * 1_000_000_000))
            guard !Task.isCancelled, let self, self.activeRunId == id else { return }
            self.runError = "The Mac didn't answer. Check that LLM-IDE is open and signed in, then try again."
            self.finishRun()
        }
    }

    func cancelRun() {
        if let id = activeRunId { connection?.sendEncodable(LlmIdeCancel(commandId: id)) }
        finishRun()
    }

    func list(_ path: String) {
        connection?.sendEncodable(LlmDocList(path: path))
        watch("list:\(path)") { [weak self] in
            guard let self, self.listings[path] == nil else { return }
            self.listings[path] = LlmDocListing(path: path, entries: [], error: Self.oldMacMessage)
        }
    }

    func read(_ path: String) {
        connection?.sendEncodable(LlmDocRead(path: path))
        watch("read:\(path)") { [weak self] in
            guard let self, self.files[path] == nil else { return }
            self.files[path] = LlmDocFile(path: path, text: nil, error: Self.oldMacMessage)
        }
    }

    /// Drop a cached listing/file so the next view of it asks the Mac again.
    func invalidate(_ path: String) {
        listings[path] = nil
        files[path] = nil
    }

    // MARK: — Inbound

    func handleInbound(type: String, data: Data) {
        let decoder = JSONDecoder()
        switch type {
        case MobileProtocol.Tag.generationOptions:
            if let o = try? decoder.decode(GenerationOptions.self, from: data) {
                options = o
                optionsError = nil
                requestWatchdogs["options"]?.cancel()
            }
        case MobileProtocol.Tag.generationResult:
            guard let r = try? decoder.decode(GenerationResult.self, from: data),
                  r.commandId == activeRunId else { return }
            if r.ok { result = r } else { runError = r.error ?? "Generation failed." }
            // A new file landed in llm-doc/generated — any cached view of it is stale.
            if r.savedPath != nil { invalidate(""); invalidate("generated") }
            finishRun()
        case MobileProtocol.Tag.llmDocListing:
            if let l = try? decoder.decode(LlmDocListing.self, from: data) {
                listings[l.path] = l
                requestWatchdogs["list:\(l.path)"]?.cancel()
            }
        case MobileProtocol.Tag.llmDocFile:
            if let f = try? decoder.decode(LlmDocFile.self, from: data) {
                files[f.path] = f
                requestWatchdogs["read:\(f.path)"]?.cancel()
            }
        default:
            break
        }
    }

    /// A wire error carrying one of our command ids ("gen_…").
    func handleCommandError(_ message: String, commandId: String) {
        guard commandId == activeRunId else { return }
        runError = message
        finishRun()
    }

    func resetForNewDevice() {
        options = nil
        optionsError = nil
        result = nil
        runError = nil
        listings = [:]
        files = [:]
        finishRun()
        requestWatchdogs.values.forEach { $0.cancel() }
        requestWatchdogs = [:]
    }

    // MARK: — Helpers

    static let oldMacMessage =
        "The Mac didn't answer. Update LLM-IDE on the Mac to a version with Doc Gen on the phone, and make sure a project is open."

    private func finishRun() {
        isRunning = false
        activeRunId = nil
        runWatchdog?.cancel()
        runWatchdog = nil
    }

    private func watch(_ key: String, onTimeout: @escaping @MainActor () -> Void) {
        requestWatchdogs[key]?.cancel()
        requestWatchdogs[key] = Task {
            try? await Task.sleep(nanoseconds: UInt64(Self.replyTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await onTimeout()
        }
    }
}
