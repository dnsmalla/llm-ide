import SwiftUI

struct DocGenView: View {
    let api: LlmIdeAPIClient
    @StateObject private var vm = GenerationViewModel()
    /// Sources panel visible by default so template + Library pickers are discoverable.
    @AppStorage("DOCGEN_SOURCES_VISIBLE") private var sourceVisible = true
    /// Chat open-state is persisted (default open) so the assistant reads as
    /// the primary surface — same pattern as Explorer / Review / Visual. A
    /// manual close sticks across launches. NOTE: this only hides
    /// `CodeAssistantPanel` (the chat) — `DocGenPromptBar` (Generate/Edit/Save,
    /// plus "Save chat output" in Use chat mode) is the only place those
    /// actions live and must always render, so it is never gated by this flag.
    /// See DocGenView.body below.
    @AppStorage("DOCGEN_CHAT_VISIBLE") private var chatVisible = true
    /// Persisted chat-panel width (HSplitView has no width binding — read it
    /// back via GeometryReader, same pattern as the other sections).
    @AppStorage("DOCGEN_CHAT_PANEL_WIDTH") private var chatPanelWidth: Double = 180
    /// Owns the sync of "Use chat" into `vm.relaxRequirements` at the level
    /// that is ALWAYS constructed for this tab — `DocGenView` itself — rather
    /// than inside `DocGenSourcePanel`, which only exists in the view tree
    /// while `DOCGEN_SOURCES_VISIBLE` is true. That panel's toggle still
    /// writes this same key (a second `@AppStorage` on an identical key name
    /// observes the same underlying value), so flipping it there is
    /// reflected here even though the panel may not be mounted the next time
    /// this view appears — e.g. Use chat ON, Sources panel hidden, quit,
    /// relaunch: the panel is never constructed, but this `onAppear` still
    /// fires and still applies the persisted value.
    @AppStorage("DOCGEN_USE_CHAT") private var useChatMode = false

    var body: some View {
        VStack(spacing: 0) {
            SectionChromeBar(toggles: [
                SectionToggle(icon: "sidebar.left", isOn: sourceVisible,
                              helpOn: "Hide Sources", helpOff: "Show Sources") {
                    withAnimation(.easeInOut(duration: 0.2)) { sourceVisible.toggle() }
                }
            ]) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { chatVisible.toggle() }
                } label: {
                    Image(systemName: "sidebar.right").symbolVariant(chatVisible ? .fill : .none)
                }
                .buttonStyle(.borderless)
                .help(chatVisible ? "Hide Chat" : "Show Chat")
            }
            Divider()
            // Fixed-width sources column (HSplitView overrides a child's width
            // frame); HSplitView drives only the editor ↔ chat split.
            HStack(spacing: 0) {
            if sourceVisible {
                DocGenSourcePanel(vm: vm, api: api)
                    .frame(width: 240)
                    .transition(.move(edge: .leading))
                Divider()
            }

            HSplitView {
            DocGenEditorPanel(vm: vm, api: api)
                .frame(minWidth: 320, idealWidth: 460, maxWidth: .infinity)

            // The chat column (prompt bar + CodeAssistantPanel) is the ONLY
            // resizable HSplitView child besides the editor — present only
            // while chatVisible. When chat is hidden this HSplitView has a
            // single child (the editor), and the prompt bar moves OUTSIDE
            // the split entirely (below) as a fixed-width sibling, same
            // pattern as the sources column above. HSplitView does not
            // reliably honor a child's fixed frame (see that comment), so a
            // fixed-width prompt bar must never be an HSplitView child —
            // dragging its divider could balloon it past its 260pt cap.
            if chatVisible {
                VStack(spacing: 0) {
                    DocGenPromptBar(vm: vm, api: api)
                    Divider()
                    CodeAssistantPanel(
                        api: api,
                        scope: .docGen,
                        initialURL: nil,
                        showFileAttachButtons: true,
                        showModelPicker: true)
                }
                .persistedPanelWidth($chatPanelWidth, minWidth: 180, floor: 220)
                .transition(.move(edge: .trailing))
            }
            }

            // Chat hidden: the prompt bar still carries the only
            // Generate/Edit/Save controls in Doc Gen, so it must stay
            // reachable — as a fixed-width sibling OUTSIDE the HSplitView
            // above (never inside it; see the comment there). This never
            // touches `chatPanelWidth`, so toggling chat back on restores
            // the user's saved chat-column width exactly.
            if !chatVisible {
                Divider()
                DocGenPromptBar(vm: vm, api: api)
                    .frame(width: 260)
                    .transition(.move(edge: .trailing))
            }
        }
        .firstLaunchOpenChat(flagKey: "DID_AUTO_OPEN_DOCGEN_CHAT_V1",
                             width: $chatPanelWidth, visible: $chatVisible)
        }
        // Sync independent of DocGenSourcePanel's mount state — see
        // `useChatMode`'s doc comment above.
        .onAppear { vm.relaxRequirements = useChatMode }
        .onChange(of: useChatMode) { _, newValue in vm.relaxRequirements = newValue }
    }
}
