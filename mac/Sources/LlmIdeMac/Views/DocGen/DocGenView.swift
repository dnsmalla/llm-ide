import SwiftUI

struct DocGenView: View {
    let api: LlmIdeAPIClient
    @StateObject private var vm = DocGenViewModel()
    @State private var sourceVisible = false
    @State private var assistantVisible = true

    var body: some View {
        VStack(spacing: 0) {
            SectionChromeBar(toggles: [
                SectionToggle(icon: "sidebar.left", isOn: sourceVisible,
                              helpOn: "Hide Sources", helpOff: "Show Sources") {
                    withAnimation(.easeInOut(duration: 0.2)) { sourceVisible.toggle() }
                }
            ]) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { assistantVisible.toggle() }
                } label: {
                    Image(systemName: "sidebar.right").symbolVariant(assistantVisible ? .fill : .none)
                }
                .buttonStyle(.borderless)
                .help(assistantVisible ? "Hide Assistant" : "Show Assistant")
            }
            Divider()
            HSplitView {
            if sourceVisible {
                DocGenSourcePanel(vm: vm, api: api)
                    .frame(minWidth: 200, idealWidth: 240, maxWidth: 300)
                    .transition(.move(edge: .leading))
            }

            DocGenEditorPanel(vm: vm, api: api)
                .frame(minWidth: 320, idealWidth: 460, maxWidth: 560)

            if assistantVisible {
                CodeAssistantPanel(
                    api: api,
                    initialURL: nil,
                    showFileAttachButtons: false,
                    showModelPicker: true)
                    .frame(minWidth: 280, idealWidth: 360, maxWidth: .infinity)
                    .transition(.move(edge: .trailing))
            }
        }
        }
    }
}
