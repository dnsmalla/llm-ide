import SwiftUI

struct DocGenView: View {
    let api: LlmIdeAPIClient
    @StateObject private var vm = DocGenViewModel()
    /// Sources panel visible by default so template + Library pickers are discoverable.
    @AppStorage("DOCGEN_SOURCES_VISIBLE") private var sourceVisible = true
    /// Chat open-state is persisted (default open) so the assistant reads as
    /// the primary surface — same pattern as Explorer / Review / Visual. A
    /// manual close sticks across launches.
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

            if chatVisible {
                CodeAssistantPanel(
                    api: api,
                    scope: .docGen,
                    initialURL: nil,
                    showFileAttachButtons: true,
                    showModelPicker: true)
                    .persistedPanelWidth($chatPanelWidth, minWidth: 180, floor: 220)
                    .transition(.move(edge: .trailing))
            }
            }
        }
        .firstLaunchOpenChat(flagKey: "DID_AUTO_OPEN_DOCGEN_CHAT_V1",
                             width: $chatPanelWidth, visible: $chatVisible)
        }
    }
}
