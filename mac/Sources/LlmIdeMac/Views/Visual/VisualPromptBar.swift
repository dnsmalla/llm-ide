import SwiftUI

/// Visual's prompt bar: the shared `GenerationPromptBar` (Generate/Edit/Save),
/// unmodified, plus one Visual-only addition shown only in "Use chat" mode —
/// a "Save chat output" control that writes the chat panel's latest assistant
/// reply to the same output folder `GenerationPromptBar`'s own Save uses.
///
/// Built as a wrapper rather than editing `GenerationPromptBar.swift` itself:
/// that file is shared with Doc Gen, and Doc Gen has no "Use chat" concept —
/// composing around it keeps Doc Gen byte-identical while giving Visual its
/// extra affordance.
struct VisualPromptBar: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient

    @AppStorage("VISUAL_USE_CHAT") private var useChatMode = false

    /// The reply text last written by `saveChatOutput`, or nil before the
    /// first save. Gates double-press: pressing Save again for the SAME
    /// reply is a no-op instead of writing a second `chat-output-1.md` —
    /// only a genuinely new reply re-arms the button.
    @State private var lastSavedChatReply: String?

    @EnvironmentObject private var outputStore: DocGenOutputStore
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore

    private var projectRoot: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
    }

    /// The shared engine `CodeAssistantPanel(scope: .visual, …)` renders —
    /// same lookup, so this always reads the conversation actually on
    /// screen. Registered as an `@Observable` read: this view's body
    /// re-evaluates whenever `messages` changes, same as the panel itself.
    private var chatEngine: ChatEngine {
        ChatEngineRegistry.shared.engine(for: .visual, api: api)
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
        VStack(spacing: 0) {
            GenerationPromptBar(vm: vm, api: api)
            if useChatMode {
                Divider()
                saveChatOutputRow
            }
        }
    }

    private var saveChatOutputRow: some View {
        let reply = latestAssistantReply
        let alreadySaved = reply != nil && reply == lastSavedChatReply
        return Button {
            guard let reply, !alreadySaved else { return }
            vm.saveChatOutput(content: reply, api: api, config: outputStore.config, projectRoot: projectRoot)
            lastSavedChatReply = reply
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
