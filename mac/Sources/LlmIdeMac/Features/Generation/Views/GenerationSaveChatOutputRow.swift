import SwiftUI

/// The "Save chat output" control shown under the shared `GenerationPromptBar`
/// when a tab's "Use chat" mode is on. Writes the chat panel's latest
/// COMPLETED assistant reply to the configured output folder via
/// `GenerationViewModel.saveChatOutput`, which deliberately does NOT touch
/// the generated document's `isSaved`/`editedContent`/filename.
///
/// Originally Visual-only (`VisualPromptBar`); hoisted here once Doc Gen
/// grew its own "Use chat" mode, because the two copies differ ONLY in which
/// `ChatScope` they read the chat output for — everything else (the
/// completed-reply filter, the double-press dedupe, the disabled/help text)
/// is identical, and two copies drifting apart is exactly what the
/// Doc Gen/Visual `Views/Shared` split exists to prevent. Lives under
/// `Views/Shared` for the same reason `GenerationViewModel`/
/// `GenerationPromptBar`/etc. do: `Views/DocGen` and `Views/Visual` are
/// peers that both render it, so neither should have to import from the
/// other. (Not a build-exclusion constraint — see `GenerationEditorPanel`
/// for why that rationale does not apply here.)
struct GenerationSaveChatOutputRow: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient
    /// Which chat this row reads from — `.visual` or `.docGen`. Each tab's
    /// chat panel (`ChatPanelRequest.scope`) uses the same value, so this always
    /// reads the conversation actually on screen for that tab.
    let scope: ChatScope

    @EnvironmentObject private var outputStore: DocGenOutputStore
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore

    private var projectRoot: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
    }

    /// The most recent assistant reply that finished normally, or nil if
    /// there isn't one yet. Read through `ChatOutputRegistry` (installed by
    /// Shell) so this feature never names Chat's engine; the provider reads
    /// the same shared engine the chat panel for `scope` renders, observably,
    /// so this body re-evaluates whenever that conversation changes. Stopped
    /// or failed replies are excluded — see `ChatOutputProviding`.
    private var latestAssistantReply: String? {
        ChatOutputRegistry.shared.latestCompletedAssistantReply(scope: scope, api: api)
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
