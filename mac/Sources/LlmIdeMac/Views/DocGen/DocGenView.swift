import SwiftUI

struct DocGenView: View {
    let api: LlmIdeAPIClient
    @StateObject private var vm = DocGenViewModel()
    /// Sources panel visible by default so template + Library pickers are discoverable.
    @AppStorage("DOCGEN_SOURCES_VISIBLE") private var sourceVisible = true
    /// Chat open-state is persisted (default open) so the assistant reads as
    /// the primary surface — same pattern as Explorer / Review / Visual. A
    /// manual close sticks across launches. NOTE: this only hides
    /// `CodeAssistantPanel` (the chat) — `DocGenPromptBar` (Generate/Edit/Save)
    /// is the only place those actions live and must always render, so it is
    /// never gated by this flag. See DocGenView.body below.
    @AppStorage("DOCGEN_CHAT_VISIBLE") private var chatVisible = true
    /// Persisted chat-panel width (HSplitView has no width binding — read it
    /// back via GeometryReader, same pattern as the other sections).
    @AppStorage("DOCGEN_CHAT_PANEL_WIDTH") private var chatPanelWidth: Double = 180

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

            // The prompt bar carries the only Generate/Edit/Save controls in
            // Doc Gen, so it must render regardless of `chatVisible` — only
            // the chat below it (CodeAssistantPanel) is toggleable. When chat
            // is hidden the column collapses to a fixed, non-resizable width
            // sized for the bar alone, so it neither stretches into empty
            // space nor overwrites the user's saved chat width.
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
            } else {
                DocGenPromptBar(vm: vm, api: api)
                    .frame(width: 260)
                    .transition(.move(edge: .trailing))
            }
            }
        }
        .firstLaunchOpenChat(flagKey: "DID_AUTO_OPEN_DOCGEN_CHAT_V1",
                             width: $chatPanelWidth, visible: $chatVisible)
        }
    }
}
