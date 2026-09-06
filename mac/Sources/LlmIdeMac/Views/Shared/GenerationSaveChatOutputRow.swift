import SwiftUI

/// The "Save chat output" control shown under the shared `GenerationPromptBar`
/// when a tab's "Use chat" mode is on. Writes the chat panel's latest
/// COMPLETED assistant reply to the configured output folder via
/// `GenerationViewModel.saveChatOutput`, which deliberately does NOT touch
/// the generated document's `isSaved`/`editedContent`/filename.
///
/// Originally Visual-only (`VisualPromptBar`); hoisted here once Doc Gen
/// grew its own "Use chat" mode, because the two copies differ ONLY in which
/// `ChatScope` they read from `ChatEngineRegistry` — everything else (the
/// completed-reply filter, the double-press dedupe, the disabled/help text)
/// is identical, and two copies drifting apart is exactly what the
/// Doc Gen/Visual `Views/Shared` split exists to prevent. Lives under
/// `Views/Shared` (never excluded by `mac/Package.swift`) for the same
/// reason `GenerationViewModel`/`GenerationPromptBar`/etc. do: `Views/Visual`
/// depends on it and is never excluded, even though `Views/DocGen` is.
struct GenerationSaveChatOutputRow: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient
    /// Which chat this row reads from — `.visual` or `.docGen`. Each tab's
    /// `CodeAssistantPanel(scope:)` uses the same value, so this always
    /// reads the conversation actually on screen for that tab.
    let scope: ChatScope

    @EnvironmentObject private var outputStore: DocGenOutputStore
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore

    private var projectRoot: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
    }

    /// The shared engine `CodeAssistantPanel(scope: scope, …)` renders for
    /// this tab — same lookup, so this always reads the conversation
    /// actually on screen. Registered as an `@Observable` read: this view's
    /// body re-evaluates whenever `messages` changes, same as the panel
    /// itself.
    private var chatEngine: ChatEngine {
        ChatEngineRegistry.shared.engine(for: scope, api: api)
    }

    /// The most recent assistant reply, or nil if there isn't one yet.
    ///
    /// Requires `status == .done` rather than merely excluding `.streaming`:
    /// `ChatMessage.Status` also has `.stopped` (the user pressed Stop
    /// mid-reply — `ChatEngine.finishStreamingTurn` keeps the partial
    /// streamed text in `content`, only the wire encoder adds a "(stopped)"
    /// marker) and `.failed` (a turn that errored mid-stream, same partial
    /// `content` left in place, with the error in `metadata.failedError`).
    /// Both hold genuinely incomplete text — saving one under this feature's
    /// normal "Save chat output" label would write a truncated document with
    /// no indication to the user that it isn't what they think it is.
    ///
    /// Broken into explicit, separately-typed steps (find the message, then
    /// trim its content, then decide) rather than one chained guard: a
    /// closure predicate combined with `.trimmingCharacters(...).isEmpty`
    /// negation in a single condition is the same type-checker blowup shape
    /// `GenerationEditorPanel.generatingTitle` was pulled out to avoid — passing
    /// today doesn't mean it stays fast (or under the limit) on a different
    /// toolchain.
    private var latestAssistantReply: String? {
        let doneMessages = chatEngine.messages.filter { message -> Bool in
            message.role == .assistant && message.status == .done
        }
        guard let last = doneMessages.last else { return nil }
        let trimmed: String = last.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return last.content
    }

    var body: some View {
        let reply = latestAssistantReply
        let alreadySaved = reply != nil && reply == vm.lastSavedChatReply
        return Button {
            guard let reply, !alreadySaved else { return }
            vm.saveChatOutput(content: reply, api: api, config: outputStore.config, projectRoot: projectRoot)
            vm.lastSavedChatReply = reply
        } label: {
            HStack(spacing: 5) {
                Image(systemName: alreadySaved ? "checkmark.square" : "square.and.arrow.down.on.square")
                    .font(.system(size: 11))
                Text(alreadySaved ? "Chat output saved" : "Save chat output")
                    .font(.callout.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(reply != nil && !alreadySaved ? theme.current.accent : Color.secondary.opacity(0.18))
            )
            .foregroundStyle(reply != nil && !alreadySaved ? .white : Color.secondary.opacity(0.5))
        }
        .buttonStyle(.plain)
        .disabled(reply == nil || alreadySaved)
        .help(
            reply == nil
                ? "No finished assistant reply yet — send a message in the chat panel first"
                : alreadySaved
                    ? "Already saved this reply — send another message to save again"
                    : "Save the chat's latest reply to the folder set in Setup (does not affect the generated document)")
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
