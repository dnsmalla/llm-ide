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

    /// The most recent assistant reply, or nil if there isn't one yet (no
    /// turn has completed) or the latest one is still streaming — saving a
    /// partial in-flight reply would write text the model hasn't finished
    /// composing.
    private var latestAssistantReply: String? {
        guard let last = chatEngine.messages.last(where: { $0.role == .assistant && $0.status != .streaming }),
              !last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
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
        Button {
            guard let reply = latestAssistantReply else { return }
            vm.save(content: reply, api: api, config: outputStore.config, projectRoot: projectRoot)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "square.and.arrow.down.on.square")
                    .font(.system(size: 11))
                Text("Save chat output")
                    .font(.callout.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(latestAssistantReply != nil ? theme.current.accent : Color.secondary.opacity(0.18))
            )
            .foregroundStyle(latestAssistantReply != nil ? .white : Color.secondary.opacity(0.5))
        }
        .buttonStyle(.plain)
        .disabled(latestAssistantReply == nil)
        .help(latestAssistantReply != nil
              ? "Save the chat's latest reply to the folder set in Setup"
              : "No finished assistant reply yet — send a message in the chat panel first")
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
