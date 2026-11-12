import Foundation
import Combine

/// Transcript + send/handle logic for the Chat tab, spoken over the connection's `host` (Host API v1).
/// Holds a weak reference to its `ChatHostContext` (the app's `ConnectionService`).
@MainActor
public class LlmIdeChatStore: ObservableObject {
    /// Transcript for the llm-ide chat sheet.
    @Published public var llmIdeMessages: [ChatMessage] = []
    /// True while a streamed reply for THIS surface is in flight. Replaces the
    /// pre-refactor shared `llmStreaming` flag.
    @Published public var isStreaming: Bool = false
    /// The question the agent is parked on, when it has asked one mid-turn.
    /// Rendered as tappable options under the transcript: answering is the
    /// fast path, and typing is for when none of them is what you mean.
    /// Nil whenever nothing is waiting on an answer.
    @Published public var pendingApproval: ApprovalRequest?
    /// A tool/edit permission prompt relayed from the host (only while it grants `tool_approvals`).
    @Published public var pendingToolApproval: ToolApprovalRequest?
    /// Why the last question went away without this phone answering it
    /// ("Answered on the desktop", "no longer open"). Shown once, then cleared.
    @Published public var approvalNotice: String?

    /// Command ids whose streamed reply belongs to this transcript.
    private var llmIdeCommandIds: Set<String> = []
    /// The turn Stop should cancel — the most recently minted commandId. The id
    /// SET stays (a late frame for an older turn must still be routable), but
    /// cancellation needs a deterministic target.
    private var currentCommandId: String?
    // TO BE REPLACED IN S4 (command-bus spec R-C2, docs/superpowers/plans/2026-10-31-command-bus-spec.md
    // section 8): the idle timeout below (which sends Cancel) is phone-side retry/cancel policy that the core's replay and detach (`chat.attach` plus a transport
    // heartbeat) will own. They are kept as they are for now; do not extend them. Tracked as the
    // "phone chat policy removed" row of the S4 exit checklist (docs/mobile/verification.md).
    private var streamTimeoutTask: Task<Void, Never>?
    /// Turns this store sent a cancel for, so the host's answering `error` is dropped rather than shown or
    /// applied to a newer turn. Removed when that error (or a done) arrives.
    private var cancelledCommandIds: Set<String> = []
    /// How long Stop waits for the host's answering event before it frees the screen itself (tests shorten it).
    public var cancelGraceNanos: UInt64 = 6_000_000_000

    private weak var context: ChatHostContext?

    /// "ask" (the Chat tab) or "execute" (the Execute tab): each is its own chat on the desktop, with its own
    /// transcript, new-chat and delete. Only "execute" is named on the wire; the default keeps the legacy chat.
    public let surface: String
    private var wireSurface: String? { surface == "execute" ? "execute" : nil }

    public init(context: ChatHostContext, surface: String = "ask") {
        self.context = context
        self.surface = surface
        // The connection routes its `HostEvent`s to every registered sink; this store keeps only its own turns.
        context.registerSink(self)
    }

    /// The project every project-scoped frame names (ADR 0022); nil keeps the v1 team behavior.
    private var selectedProjectId: String? { context?.selectedProjectId }

    /// Guards a snapshot reply so an older project's load cannot overwrite a newer selection's transcript.
    private var historyTicket = 0

    /// The project a scoped frame should name (the context waits for the first `projects.list` reply).
    private func scopedProjectId() async -> String? { await context?.scopedProjectId() }

    /// Send a refused frame's reason to the picker. A non-project error is left to the caller.
    @discardableResult
    private func noteProjectRefusal(_ error: Error) -> Bool { context?.noteProjectRefusal(error) == true }

    // MARK: — Send

    /// Ask llm-ide's agent a question through `connection.host`. The reply streams back as
    /// `HostEvent`s (`handle`), landing in `llmIdeMessages`.
    ///
    /// `files` carry text already extracted on-device (PDF/`.md`/`.txt`), never binary. Returns false only when
    /// the host's limits refuse the message before any turn starts; the caller then keeps the composer as is.
    @discardableResult
    public func sendLlmideChat(_ text: String, files: [ChatFileText] = [], mode: String? = nil) async -> Bool {
        guard context?.isConnected == true else {
            context?.errorMessage = "Not connected to the desktop — wait for Live status, then try again."
            return true
        }
        // A send typed before projects.list replied still names the selected project (L4).
        let projectId = await scopedProjectId()
        guard context?.isConnected == true else {
            context?.errorMessage = "Not connected to the desktop — wait for Live status, then try again."
            return true
        }
        guard !isStreaming else { return false } // a second tap while the first waited for the list
        // Validated against the `chat.send` schema limits before any turn starts.
        var request: HostApiChatSendRequest
        switch HostApiChatSendPolicy.request(text: text, files: files, projectId: projectId) {
        case .send(let r): request = r
        case .refuse(let message): context?.errorMessage = message; return false
        }
        request.mode = mode ?? "ask"
        request.surface = wireSurface
        // The host's own session store is the transcript: the phone sends only the new text (and files).
        let id = mintStreamingTurn(messages: &llmIdeMessages, commandIds: &llmIdeCommandIds, userText: text)
        isStreaming = true
        currentCommandId = id
        startStreamTimeout(for: id)
        Task { [weak self] in
            do {
                _ = try await self?.context?.host.send(.chatSend, request, id: id, as: HostApiChatSendResult.self)
            } catch {
                self?.chatSendFailed(id, error)
            }
        }
        return true
    }

    /// An encode failure disconnects; a host refusal (`denied`, `busy`, …) only ends the turn. A project
    /// refusal is shown by the picker instead of the connection banner.
    private func chatSendFailed(_ id: String, _ error: Error) {
        let r = error as? HostApiRejection
        let local = HostApiChatNotices.disconnectsAfterSendFailure(error)
        if noteProjectRefusal(error) {
            handleChatError(commandId: id)
            if local { context?.disconnect() }
            return
        }
        context?.errorMessage = r?.message ?? (local ? "Failed to encode chat message: \(error.localizedDescription)"
                                                         : "The desktop sent a reply this app could not read.")
        handleChatError(commandId: id)
        if local { context?.disconnect() }
    }

    /// Load the host's shared chat transcript (`chat.snapshot`) for the selected project, after the first
    /// projects.list reply so the first frame names the project (L4).
    public func loadSharedHistory() {
        guard context?.isConnected == true else { return }
        historyTicket += 1
        let ticket = historyTicket
        Task { [weak self] in
            guard let self else { return }
            let projectId = await self.scopedProjectId()
            do {
                let result = try await self.context?.host.send(
                    .chatSnapshot, HostApiChatSnapshotRequest(limit: 50, projectId: projectId, surface: self.wireSurface),
                    as: HostApiChatSnapshotResult.self)
                guard ticket == self.historyTicket else { return } // a newer project's load won
                if let result { self.applySnapshot(result) }
            } catch {
                guard ticket == self.historyTicket else { return }
                self.noteProjectRefusal(error)
            }
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

    /// The transcript is cleared only once the desktop confirms; a refusal leaves it on screen with the reason,
    /// instead of emptying it and having the next reload bring it back.
    public func clearLlmIdeChat() {
        Task { [weak self] in
            guard let self else { return }
            do {
                let request = HostApiChatHistoryClearRequest(projectId: self.selectedProjectId, surface: self.wireSurface)
                if try await self.context?.host.send(.chatHistoryClear, request,
                                                        as: HostApiChatHistoryClearResult.self).cleared == true {
                    self.llmIdeMessages.removeAll()
                } else {
                    self.context?.errorMessage = "The desktop did not clear that chat."
                }
            } catch {
                guard !self.noteProjectRefusal(error) else { return }
                if let r = error as? HostApiRejection, r.code != "host_unreachable" {
                    self.context?.errorMessage = r.message
                }
            }
        }
    }

    /// Start a fresh phone chat on the desktop and clear this transcript. The old chat stays in History.
    public func newChat() {
        guard !isStreaming, let host = context?.host else { return }
        Task { [weak self] in
            do {
                _ = try await host.send(.chatNew, HostApiChatNewRequest(surface: self?.wireSurface), as: HostApiChatNewResult.self)
                self?.llmIdeMessages.removeAll()
                self?.approvalNotice = nil
            } catch {
                if let rejection = error as? HostApiRejection { self?.context?.errorMessage = rejection.message }
            }
        }
    }

    /// Cancel the in-flight chat turn on the host.
    public func cancelStreaming() {
        // `Set.first` is nondeterministic — with two ids in flight Stop could
        // cancel the wrong turn. Track the live one explicitly.
        guard let id = currentCommandId else { return }
        sendCancel(id)
    }

    /// `id` is the turn being cancelled (`chat.cancel` names none); it is recorded so the host's answering
    /// error is dropped (see `handle`).
    private func sendCancel(_ id: String) {
        cancelledCommandIds.insert(id)
        Task { [weak self] in
            var result: HostApiChatCancelResult?
            do {
                let request = HostApiChatCancelRequest(projectId: self?.selectedProjectId)
                result = try await self?.context?.host.send(.chatCancel, request, as: HostApiChatCancelResult.self)
            } catch {
                // Stop still ends the local turn even when the host refuses the project.
                _ = self?.noteProjectRefusal(error)
            }
            guard let self else { return }
            if HostApiChatTurn.endsAfterCancel(cancelled: result?.cancelled) {
                self.cancelledCommandIds.remove(id)
                // A late reply must not end the next turn's spinner.
                if self.currentCommandId == id { self.handleChatError(commandId: id) }
                return
            }
            // The host accepted the cancel but its answering event may never come (a turn parked on a prompt):
            // Stop must always free the screen, so end the turn here after a short grace.
            try? await Task.sleep(nanoseconds: self.cancelGraceNanos)
            if self.currentCommandId == id { self.cancelledCommandIds.remove(id); self.handleChatError(commandId: id) }
        }
    }

    // MARK: — Approvals and inbound HostEvents (routed by ConnectionService)

    /// Answer the parked question. `selection` is the chosen labels per
    /// question index; a multi-select answer is sorted and comma-joined, which
    /// is the form the server passes through verbatim.
    ///
    /// The card comes down immediately. The turn resumes on the host, and a
    /// failure there is the host's to show — this surface cannot render a
    /// decision error usefully, and leaving a tappable question up after the
    /// answer was sent invites a second answer to a question that is gone.
    public func submitApproval(selection: [Int: Set<String>]) {
        guard let request = pendingApproval else { return }
        let answers = request.answers(from: selection)
        guard !answers.isEmpty else { return }
        let answer = HostApiApprovalsAnswerRequest(answers: answers, commandId: request.commandId,
                                                   projectId: selectedProjectId, requestId: request.requestId)
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await self.context?.host.send(.approvalsAnswer, answer, as: HostApiApprovalsAnswerResult.self) }
            catch {
                guard !self.noteProjectRefusal(error) else { return }
                if let r = error as? HostApiRejection, r.code != "host_unreachable" {
                    self.context?.errorMessage = r.message
                }
            }
        }
        pendingApproval = nil
        approvalNotice = nil
    }

    /// Drop any question / tool prompt: its turn is gone (connection lost or reset).
    public func clearPendingPrompts() {
        pendingApproval = nil
        pendingToolApproval = nil
    }

    public func submitToolApproval(allow: Bool) {
        // A card left over from before the host withdrew `tool_approvals` never sends (see `.capabilities`).
        guard let request = pendingToolApproval else { return }
        guard context?.host.capabilities.contains(HostApiCommand.toolApprovalsAnswer.capability) == true else {
            // Never leave a card whose buttons do nothing (Task 6 review M2).
            pendingToolApproval = nil
            approvalNotice = HostApiChatNotices.toolApprovalsOff
            return
        }
        let answer = HostApiToolApprovalsAnswerRequest(commandId: request.commandId, decision: allow ? "allow_once" : "deny",
                                                       projectId: selectedProjectId, requestId: request.requestId)
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await self.context?.host.send(.toolApprovalsAnswer, answer, as: HostApiToolApprovalsAnswerResult.self) }
            catch {
                guard !self.noteProjectRefusal(error) else { return }
                if let r = error as? HostApiRejection, r.code != "host_unreachable" {
                    self.context?.errorMessage = r.message
                }
            }
        }
        pendingToolApproval = nil
        approvalNotice = nil
    }

    public func handle(_ event: HostEvent) {
        let d = JSONDecoder()
        switch event {
        case .event(.chatDelta, let payload, let replyTo?):
            // Every chunk proves the host is alive, so restart the timeout — it is an IDLE breaker, not a wall clock.
            guard ownsCommand(replyTo), let e = try? d.decode(HostApiChatDeltaEvent.self, from: payload), !e.text.isEmpty else { return }
            appendToLastAssistant(&llmIdeMessages, e.text)
            startStreamTimeout(for: replyTo)
        case .event(.chatDone, let payload, _):
            guard let e = try? d.decode(HostApiChatDoneEvent.self, from: payload) else { return }
            cancelledCommandIds.remove(e.requestId)
            guard ownsCommand(e.requestId) else { return }
            finishTurn(e.requestId)
        case .event(.chatError, let payload, let replyTo):
            if let replyTo {
                // The host's answer to our own Cancel: end the turn if Stop is still waiting on it, but say
                // nothing, and never let it touch a newer turn.
                if cancelledCommandIds.remove(replyTo) != nil {
                    if ownsCommand(replyTo) { handleChatError(commandId: replyTo) }
                    return
                }
                guard ownsCommand(replyTo) else { return }
                handleChatError(commandId: replyTo)
            } else {
                handleChatError()
            }
            if let e = try? d.decode(HostApiChatErrorEvent.self, from: payload), e.message != "Cancelled" {
                context?.errorMessage = e.message
            }
        case .event(.approvalRequest, let payload, _):
            // Only this phone's own turn.
            guard let e = try? d.decode(HostApiApprovalRequestEvent.self, from: payload) else { return }
            let request = ApprovalRequest(event: e)
            if !request.questions.isEmpty, ownsCommand(request.commandId) {
                approvalNotice = nil
                pendingApproval = request
            }
        case .event(.toolApprovalRequest, let payload, _):
            // Same ownership rule as questions.
            guard let e = try? d.decode(HostApiToolApprovalRequestEvent.self, from: payload) else { return }
            let request = ToolApprovalRequest(event: e)
            if ownsCommand(request.commandId) {
                approvalNotice = nil
                pendingApproval = nil
                pendingToolApproval = request
            }
        case .event(.approvalCleared, let payload, _):
            // Only for the card actually on screen: a late clear for an older question must not take down a
            // NEWER one the agent has since asked.
            guard let e = try? d.decode(HostApiApprovalClearedEvent.self, from: payload) else { return }
            let cleared = ApprovalCleared(event: e)
            if pendingApproval?.requestId == cleared.requestId { pendingApproval = nil; approvalNotice = cleared.reason }
            if pendingToolApproval?.requestId == cleared.requestId { pendingToolApproval = nil; approvalNotice = cleared.reason }
        case .capabilities(let caps):
            // The host withdrew tool approvals mid-session: the card can no longer be
            // answered, so take it down and say why instead of leaving a tap that would be refused.
            if pendingToolApproval != nil, !caps.contains(HostApiCommand.toolApprovalsAnswer.capability) {
                pendingToolApproval = nil
                approvalNotice = HostApiChatNotices.toolApprovalsOff
            }
        case .resync:
            // A missed-event gap (spec "Wire envelope"): take a fresh snapshot. It is applied once not streaming.
            loadSharedHistory()
        case .event, .disconnected:
            break
        }
    }

    public func ownsCommand(_ id: String) -> Bool { llmIdeCommandIds.contains(id) }

    /// Re-attach image thumbnails the server transcript can't carry, matching
    /// on (role, text) from the most recent local turns.
    public static func preservingAttachments(from local: [ChatMessage],
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

    /// The end of a turn (`chat.done`), keyed by the finished request.
    private func finishTurn(_ id: String) {
        streamTimeoutTask?.cancel()
        isStreaming = false
        // The turn is over, so its question (if any) can no longer be
        // answered — the requestId is dead server-side. The host sends an
        // explicit clear too; this covers the event arriving first. Scoped
        // to THIS turn.
        if pendingApproval?.commandId == id { pendingApproval = nil }
        if pendingToolApproval?.commandId == id { pendingToolApproval = nil }
        llmIdeCommandIds.remove(id)
        if currentCommandId == id { currentCommandId = nil }
        loadSharedHistory()
    }

    public func handleChatError(commandId: String? = nil) {
        streamTimeoutTask?.cancel()
        isStreaming = false
        if let commandId {
            llmIdeCommandIds.remove(commandId)
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
            cancelledCommandIds.removeAll()
            currentCommandId = nil
        }
        removeTrailingEmptyAssistant(&llmIdeMessages)
    }

    /// Blank slate for a newly paired host. Without this the previous machine's
    /// transcript stays on screen (and its in-flight ids stay routable).
    public func resetForNewDevice() {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = nil
        isStreaming = false
        llmIdeCommandIds.removeAll()
        cancelledCommandIds.removeAll()
        currentCommandId = nil
        pendingApproval = nil
        pendingToolApproval = nil
        llmIdeMessages.removeAll()
    }

    /// Idle window: long, because the host sends no progress events to restart it while a tool runs or a
    /// question waits for an answer (Plan 4 decision 7).
    public static let idleSeconds: UInt64 = 960

    private func startStreamTimeout(for commandId: String) {
        streamTimeoutTask?.cancel()
        streamTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.idleSeconds * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            guard self.llmIdeCommandIds.contains(commandId) else { return }
            self.context?.errorMessage =
                "Timed out waiting for the desktop — check that LLM-IDE is running there."
            self.handleChatError(commandId: commandId)
            self.sendCancel(commandId)
        }
    }
}

/// The Execute tab's chat: a distinct type so SwiftUI can hand the view its own store next to the Chat tab's.
@MainActor
public final class ExecuteChatStore: LlmIdeChatStore {
    public init(context: ChatHostContext) { super.init(context: context, surface: "execute") }
}

extension LlmIdeChatStore: HostEventSink {}
