import Foundation
import SharedProtocol

/// Transcript + send/handle logic for the llm-ide chat surface (the "Chat"
/// sheet). Owns its OWN `isStreaming` flag — distinct from
/// `ExplorerChatStore.isStreaming` — so a streaming reply on one surface no
/// longer disables the send button on the other (the shared-`llmStreaming`
/// smell flagged in the audit). Holds a weak reference to the
/// `ConnectionService` to send outbound frames.
@MainActor
final class LlmIdeChatStore: ObservableObject {
    /// Transcript for the llm-ide chat sheet.
    @Published var llmIdeMessages: [ChatMessage] = []
    /// True while a streamed reply for THIS surface is in flight. Replaces the
    /// pre-refactor shared `llmStreaming` flag.
    @Published var isStreaming: Bool = false
    /// The question the agent is parked on, when it has asked one mid-turn.
    /// Rendered as tappable options under the transcript: answering is the
    /// fast path, and typing is for when none of them is what you mean.
    /// Nil whenever nothing is waiting on an answer.
    @Published var pendingApproval: ApprovalRequest?
    /// A tool/edit permission prompt relayed from the Mac (only when its "Phone access" switch is on).
    @Published var pendingToolApproval: ToolApprovalRequest?
    /// Why the last question went away without this phone answering it
    /// ("Answered on the Mac", "no longer open"). Shown once, then cleared.
    @Published var approvalNotice: String?

    /// Command ids whose streamed reply belongs to this transcript.
    private var llmIdeCommandIds: Set<String> = []
    /// The turn Stop should cancel — the most recently minted commandId. The id
    /// SET stays (a late frame for an older turn must still be routable), but
    /// cancellation needs a deterministic target.
    private var currentCommandId: String?
    // TO BE REPLACED IN S4 (command-bus spec R-C2, docs/superpowers/plans/2026-10-31-command-bus-spec.md
    // section 8): the idle timeout below (which sends Cancel) and the sticky approval-pause window are
    // phone-side retry/cancel policy that the core's replay and detach (`chat.attach` plus a transport
    // heartbeat) will own. They are kept as they are for now; do not extend them. Tracked as the
    // "phone chat policy removed" row of the S4 exit checklist (docs/mobile/verification.md).
    private var streamTimeoutTask: Task<Void, Never>?
    /// Commands that have shown the Mac's approval pause note — once seen,
    /// every later idle-timeout restart for that command keeps the LONG
    /// window until `done`. Sticky on purpose: an answered approval is
    /// typically followed by an expensive tool run that can be legitimately
    /// silent for more than the normal window, and timing out sends Cancel,
    /// killing the very turn the user just approved on the Mac.
    private var approvalPausedCommandIds: Set<String> = []
    /// Turns whose bubble shows v2 status lines: the reply replaces them, as the v2 `done` chunk did.
    private var progressCommandIds: Set<String> = []
    /// Turns this store sent a cancel for, so the host's answering `error` is dropped rather than shown or
    /// applied to a newer turn. Removed when that error (or a done) arrives.
    private var cancelledCommandIds: Set<String> = []

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        // Register so ConnectionService can route this slice's `HostEvent`s here.
        connection.llmIdeStore = self
    }

    // MARK: — Send

    /// Ask llm-ide's agent a question through `connection.host`. The reply streams back as
    /// `HostEvent`s (`handle`), landing in `llmIdeMessages`.
    ///
    /// `files` carry text already extracted on-device (PDF/`.md`/`.txt`), never binary.
    func sendLlmideChat(_ text: String, files: [ChatFileText] = []) {
        guard connection?.connectionStatus == .connected else {
            connection?.errorMessage = "Not connected to your Mac — wait for Live status, then try again."
            return
        }
        // The Mac's own session store is the transcript: the phone sends only the new text (and files),
        // never a history window or images (the Mac ignored the first and refused the second).
        let (id, _) = mintStreamingTurn(messages: &llmIdeMessages, commandIds: &llmIdeCommandIds, userText: text)
        isStreaming = true
        currentCommandId = id
        startStreamTimeout(for: id, idleSeconds: idleWindow(for: id))
        let request = HostApiChatSendRequest(attachments: files.isEmpty ? nil : files.map { .init(name: $0.name, text: $0.text) }, text: text)
        Task { [weak self] in
            do {
                _ = try await self?.connection?.host.send(.chatSend, request, id: id, as: HostApiChatSendResult.self)
            } catch {
                self?.chatSendFailed(id, error)
            }
        }
    }

    /// Before the transport move, an encode failure set this message and disconnected; a host refusal
    /// (v1 `denied`, `busy`, …) arrived as an `error` frame. Both end the turn the same way.
    private func chatSendFailed(_ id: String, _ error: Error) {
        let r = error as? HostApiRejection
        connection?.errorMessage = r?.message ?? "Failed to encode chat message: \(error.localizedDescription)"
        handleChatError(commandId: id)
        if r == nil || r?.code == "internal" { connection?.disconnect() }
    }

    /// Load the shared server transcript (same history as Mac llm-chat sheet).
    func loadSharedHistory() {
        Task { [weak self] in
            guard let result = try? await self?.connection?.host.send(
                .chatSnapshot, HostApiChatSnapshotRequest(limit: 50), as: HostApiChatSnapshotResult.self) else { return }
            self?.applySnapshot(result)
        }
    }

    private func applySnapshot(_ reply: HostApiChatSnapshotResult) {
        guard !isStreaming else { return }
        let restored = reply.messages.enumerated().map { index, message in
            ChatMessage(historyIndex: index, role: message.role == "assistant" ? .assistant : .user, text: message.content)
        }
        // Carry local-only `imageData` across the swap: the server transcript has no images, so a just-sent
        // thumbnail used to vanish from its bubble the moment the reply completed.
        llmIdeMessages = Self.preservingAttachments(from: llmIdeMessages, into: restored)
    }

    func clearLlmIdeChat() {
        llmIdeMessages.removeAll()
        Task { [weak self] in
            do {
                if try await self?.connection?.host.send(.chatHistoryClear, HostApiChatHistoryClearRequest(),
                                                          as: HostApiChatHistoryClearResult.self).cleared == true {
                    self?.llmIdeMessages.removeAll()
                }
            } catch let r as HostApiRejection where r.code != "host_unreachable" {
                self?.connection?.errorMessage = r.message   // a v1 refusal; on v2 the Mac's error frame says it
            } catch {}
        }
    }

    /// Cancel the in-flight llm-ide chat turn on the Mac.
    func cancelStreaming() {
        // `Set.first` is nondeterministic — with two ids in flight Stop could
        // cancel the wrong turn. Track the live one explicitly.
        guard let id = currentCommandId else { return }
        sendCancel(id)
    }

    /// `id` is the turn being cancelled. v1 `chat.cancel` names none and the v2 adapter targets its last
    /// `chat.send`, which is this id; it is recorded so the host's answering error is dropped (see `handle`).
    private func sendCancel(_ id: String) {
        cancelledCommandIds.insert(id)
        Task { [weak self] in
            let result = try? await self?.connection?.host.send(.chatCancel, HostApiChatCancelRequest(),
                                                                 as: HostApiChatCancelResult.self)
            guard let self, let version = self.connection?.host.apiVersion,
                  HostApiChatTurn.endsAfterCancel(apiVersion: version, cancelled: result?.cancelled) else { return }
            self.cancelledCommandIds.remove(id)
            self.handleChatError(commandId: id)
        }
    }

    // MARK: — Approvals and inbound HostEvents (routed by ConnectionService)

    /// Answer the parked question. `selection` is the chosen labels per
    /// question index; a multi-select answer is sorted and comma-joined, which
    /// is the wire form the Mac's own card produces and the server passes
    /// through verbatim.
    ///
    /// The card comes down immediately. The turn resumes on the Mac, and a
    /// failure there is the Mac's to show — this surface cannot render a
    /// decision error usefully, and leaving a tappable question up after the
    /// answer was sent invites a second answer to a question that is gone.
    func submitApproval(selection: [Int: Set<String>]) {
        guard let request = pendingApproval else { return }
        let answers = request.answers(from: selection)
        guard !answers.isEmpty else { return }
        let answer = HostApiApprovalsAnswerRequest(answers: answers, commandId: request.commandId, requestId: request.requestId)
        Task { [weak self] in
            do { _ = try await self?.connection?.host.send(.approvalsAnswer, answer, as: HostApiApprovalsAnswerResult.self) }
            catch let r as HostApiRejection where r.code != "host_unreachable" { self?.connection?.errorMessage = r.message }
            catch {}
        }
        pendingApproval = nil
        approvalNotice = nil
    }

    /// Answer the parked tool prompt. The card comes down at once; the Mac re-checks the request id
    /// against the turn's live prompt and the Phone access switch, and says so if it refuses.
    /// Drop any question / tool prompt: its turn is gone (connection lost or reset).
    func clearPendingPrompts() {
        pendingApproval = nil
        pendingToolApproval = nil
    }

    func submitToolApproval(allow: Bool) {
        // A card left over from before the host withdrew `tool_approvals` never sends (see `.capabilities`).
        guard let request = pendingToolApproval,
              connection?.host.capabilities.contains(HostApiCommand.toolApprovalsAnswer.capability) == true else { return }
        let answer = HostApiToolApprovalsAnswerRequest(commandId: request.commandId, decision: allow ? "allow_once" : "deny",
                                                       requestId: request.requestId)
        Task { [weak self] in
            do { _ = try await self?.connection?.host.send(.toolApprovalsAnswer, answer, as: HostApiToolApprovalsAnswerResult.self) }
            catch let r as HostApiRejection where r.code != "host_unreachable" { self?.connection?.errorMessage = r.message }
            catch {}
        }
        pendingToolApproval = nil
        approvalNotice = nil
    }

    func handle(_ event: HostEvent) {
        let d = JSONDecoder()
        switch event {
        case .progress(let id, let text):
            // v2 status line: appended, restarts the idle breaker, and the pause glyph makes the window sticky.
            // Every frame proves the Mac is alive and working, so restart the timeout — it is an IDLE breaker,
            // not a wall clock.
            guard ownsCommand(id), !text.isEmpty else { return }
            appendToLastAssistant(&llmIdeMessages, text)
            progressCommandIds.insert(id)
            if text.contains(Self.approvalPauseGlyph) { approvalPausedCommandIds.insert(id) }
            startStreamTimeout(for: id, idleSeconds: idleWindow(for: id))
        case .event(.chatDelta, let payload, let replyTo?):
            // No size cap here: a v2 `done` chunk carries the whole reply in one delta, however large.
            guard ownsCommand(replyTo), let e = try? d.decode(HostApiChatDeltaEvent.self, from: payload), !e.text.isEmpty else { return }
            // The reply replaces any status lines (the v2 `done` chunk did); later chunks append.
            if progressCommandIds.remove(replyTo) != nil { setLastAssistant(&llmIdeMessages, e.text) }
            else { appendToLastAssistant(&llmIdeMessages, e.text) }
            startStreamTimeout(for: replyTo, idleSeconds: idleWindow(for: replyTo))
        case .event(.chatDone, let payload, _):
            guard let e = try? d.decode(HostApiChatDoneEvent.self, from: payload) else { return }
            cancelledCommandIds.remove(e.requestId)
            guard ownsCommand(e.requestId) else { return }
            finishTurn(e.requestId)
        case .event(.chatError, let payload, let replyTo):
            if let replyTo {
                // The host's answer to our own Cancel: end the turn if Stop is still waiting on it, but say
                // nothing, and never let it touch a newer turn (the bridge is stateless, so the store tracks it).
                if cancelledCommandIds.remove(replyTo) != nil {
                    if ownsCommand(replyTo) { handleChatError(commandId: replyTo) }
                    return
                }
                guard ownsCommand(replyTo) else { return }
                handleChatError(commandId: replyTo)
            } else {
                handleChatError()
            }
            // On v2, ConnectionService already showed the `error` frame's message; on v1 nobody else will.
            if connection?.host.apiVersion == 1, let e = try? d.decode(HostApiChatErrorEvent.self, from: payload), e.message != "Cancelled" {
                connection?.errorMessage = e.message
            }
        case .event(.approvalRequest, let payload, _):
            // Only this surface's own turn: both stores see every approval frame on v2.
            guard let e = try? d.decode(HostApiApprovalRequestEvent.self, from: payload) else { return }
            let request = HostApiV2ChatBridge.approvalRequest(e)
            if !request.questions.isEmpty, ownsCommand(request.commandId) {
                approvalNotice = nil
                pendingApproval = request
            }
        case .event(.toolApprovalRequest, let payload, _):
            // Same ownership rule as questions: only the surface whose turn this is.
            guard let e = try? d.decode(HostApiToolApprovalRequestEvent.self, from: payload) else { return }
            let request = HostApiV2ChatBridge.toolApprovalRequest(e)
            if ownsCommand(request.commandId) {
                approvalNotice = nil
                pendingApproval = nil
                pendingToolApproval = request
            }
        case .event(.approvalCleared, let payload, _):
            // Only for the card actually on screen: a late clear for an older question must not take down a
            // NEWER one the agent has since asked — nor one belonging to the other surface.
            guard let e = try? d.decode(HostApiApprovalClearedEvent.self, from: payload) else { return }
            let cleared = HostApiV2ChatBridge.approvalCleared(e)
            if pendingApproval?.requestId == cleared.requestId { pendingApproval = nil; approvalNotice = cleared.reason }
            if pendingToolApproval?.requestId == cleared.requestId { pendingToolApproval = nil; approvalNotice = cleared.reason }
        case .capabilities(let caps):
            // The host withdrew tool approvals mid-session (Phone access switch): the card can no longer be
            // answered, so take it down and say why instead of leaving a tap that would be refused.
            if pendingToolApproval != nil, !caps.contains(HostApiCommand.toolApprovalsAnswer.capability) {
                pendingToolApproval = nil
                approvalNotice = "Tool approvals from this phone were turned off on your Mac."
            }
        case .resync:
            // A missed-event gap (spec "Wire envelope"): take a fresh snapshot. It is applied once not streaming.
            loadSharedHistory()
        case .event, .disconnected:
            break
        }
    }

    func ownsCommand(_ id: String) -> Bool { llmIdeCommandIds.contains(id) }

    /// Re-attach image thumbnails the server transcript can't carry, matching
    /// on (role, text) from the most recent local turns.
    static func preservingAttachments(from local: [ChatMessage],
                                      into restored: [ChatMessage]) -> [ChatMessage] {
        guard local.contains(where: { $0.imageData != nil }) else { return restored }
        // Walk BOTH lists forward. Matching on (role, text) alone attached the
        // image to the FIRST identical turn — send "look" without an image,
        // then "look" with one, and the thumbnail landed on the older bubble.
        var cursor = local.startIndex
        return restored.map { message in
            while cursor < local.endIndex {
                let candidate = local[cursor]
                cursor += 1
                guard candidate.role == message.role, candidate.text == message.text else { continue }
                guard let imageData = candidate.imageData else { return message }
                var merged = message
                merged.imageData = imageData
                return merged
            }
            return message
        }
    }

    /// The end of a turn (v2 `done`, v1 `chat.done`), keyed by the finished request.
    private func finishTurn(_ id: String) {
        streamTimeoutTask?.cancel()
        isStreaming = false
        // The turn is over, so its question (if any) can no longer be
        // answered — the requestId is dead server-side. The Mac sends an
        // explicit clear too; this covers the frame arriving first. Scoped
        // to THIS turn so a `done` for one command can't take down a
        // question the other surface is showing.
        if pendingApproval?.commandId == id { pendingApproval = nil }
        if pendingToolApproval?.commandId == id { pendingToolApproval = nil }
        llmIdeCommandIds.remove(id)
        approvalPausedCommandIds.remove(id)
        progressCommandIds.remove(id)
        if currentCommandId == id { currentCommandId = nil }
        loadSharedHistory()
    }

    func handleChatError(commandId: String? = nil) {
        streamTimeoutTask?.cancel()
        isStreaming = false
        if let commandId {
            llmIdeCommandIds.remove(commandId)
            approvalPausedCommandIds.remove(commandId)
            progressCommandIds.remove(commandId)
            if currentCommandId == commandId { currentCommandId = nil }
            if pendingToolApproval?.commandId == commandId { pendingToolApproval = nil }
        } else {
            pendingToolApproval = nil
            // No id = the whole connection went down (ConnectionService
            // .disconnect). Every in-flight turn is dead, so drop them all:
            // leaving orphans behind means a later Stop cancels a command that
            // no longer exists, a late/replayed frame for that id appends into
            // the live transcript, and the set grows per dropped connection.
            llmIdeCommandIds.removeAll()
            approvalPausedCommandIds.removeAll()
            progressCommandIds.removeAll()
            cancelledCommandIds.removeAll()
            currentCommandId = nil
        }
        removeTrailingEmptyAssistant(&llmIdeMessages)
    }

    /// Blank slate for a newly paired Mac. Without this the previous machine's
    /// transcript stays on screen (and its in-flight ids stay routable).
    func resetForNewDevice() {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = nil
        isStreaming = false
        llmIdeCommandIds.removeAll()
        approvalPausedCommandIds.removeAll()
        progressCommandIds.removeAll()
        cancelledCommandIds.removeAll()
        currentCommandId = nil
        pendingApproval = nil
        pendingToolApproval = nil
        llmIdeMessages.removeAll()
    }

    /// Glyph the Mac's approval pause note carries ("⏸ Question pending on
    /// Mac…", `ChatEngine.externalApprovalNote`) — forwarded through the
    /// same stream frames as ordinary progress. After it, the turn
    /// legitimately goes silent while a human answers the card on the Mac
    /// (up to the server's 15-minute decision TTL), so the idle breaker
    /// must outlast that. If the Mac ever changes the glyph, the phone
    /// merely degrades to the normal window — never worse than before.
    static let approvalPauseGlyph = "⏸"

    /// Long window once `commandId` has parked on an approval (sticky until
    /// done, see `approvalPausedCommandIds`), and always on Host API v1: it sends no progress frames to restart the
    /// breaker, so the short window would cancel every turn longer than two minutes (Plan 4 decision 7).
    func idleWindow(for commandId: String) -> UInt64 {
        approvalPausedCommandIds.contains(commandId) || connection?.host.apiVersion == 1 ? 960 : 120
    }

    private func startStreamTimeout(for commandId: String, idleSeconds: UInt64 = 120) {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: idleSeconds * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            guard self.llmIdeCommandIds.contains(commandId) else { return }
            self.connection?.errorMessage =
                "Timed out waiting for your Mac — check LLM-IDE backend and Mobile Control log."
            self.handleChatError(commandId: commandId)
            self.sendCancel(commandId)
        }
    }
}
