import SwiftUI

/// Visual's centre panel: the shared generation body (toolbar, setup view,
/// generating view, done view, error view — `GenerationEditorPanel`, the
/// same one Doc Gen uses) while `viewingImage` is false, and
/// `ImageShowPanel` (with a "back" banner) while it's true.
///
/// Before this file mirrored only the done/error states of Doc Gen's centre
/// panel and defaulted to the image the rest of the time. Now it mirrors
/// Doc Gen's centre panel in EVERY state — idle shows the same toolbar +
/// selected-sources card + steps checklist, generating shows the same
/// progress row + shimmer skeleton — and the image is reached through an
/// explicit "View Image" control (`toolbarAccessory` on the shared panel)
/// rather than being the default. The image `selectedURL` binding is
/// threaded straight through untouched, so flipping between the shared
/// panel and the image never loses the tree selection.
struct VisualCenterPanel: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient
    @Binding var selectedURL: URL?

    @EnvironmentObject private var theme: ThemeStore

    /// True while the user has explicitly asked to see the image instead of
    /// the shared generation panel — via the toolbar's "View Image" control,
    /// available in every generation state (idle, generating, done, error).
    /// Reset the moment a fresh run starts (or the document is discarded
    /// back to idle) so the NEXT result is shown by default rather than
    /// staying pinned on whatever the user last chose.
    @State private var viewingImage = false

    private var hasDocument: Bool {
        switch vm.generationState {
        case .done, .error: return true
        case .idle, .generating: return false
        }
    }

    private var isGenerating: Bool {
        if case .generating = vm.generationState { return true }
        return false
    }

    var body: some View {
        Group {
            if viewingImage {
                imageView
            } else {
                GenerationEditorPanel(
                    vm: vm,
                    api: api,
                    sourcesEmptyHint: "Tick a file's checkbox in the Data or Code tab on the left — " +
                        "tapping its name instead previews it here as the image.",
                    steps: [
                        GenerationChecklistStep(
                            title: "Choose a template or command",
                            detail: "Pick either one in the Template & Command section on the left — " +
                                "optional with Use chat on",
                            // NOTE: intentionally does NOT include `|| vm.relaxRequirements` —
                            // a checkmark + strikethrough means "you did this", and Use chat
                            // only makes this step OPTIONAL, not done. See the toolbar hint in
                            // `GenerationEditorPanel`, which would otherwise contradict this.
                            done: vm.selectedTemplate != nil || vm.selectedCommand != nil),
                        GenerationChecklistStep(
                            title: "Select files from Data or Code",
                            detail: "Tick a file's checkbox to use it as a source; tapping its NAME " +
                                "previews it here instead — still required even with Use chat on",
                            done: !vm.selectedSources.isEmpty),
                        GenerationChecklistStep(
                            title: "Add a prompt and generate",
                            detail: "Write a short prompt in the panel on the right, then press Generate",
                            done: false),
                    ]
                ) {
                    viewImageButton
                }
            }
        }
        .onChange(of: vm.generationState) { _, newValue in
            switch newValue {
            case .idle, .generating: viewingImage = false
            case .done, .error: break
            }
        }
    }

    private var viewImageButton: some View {
        Button {
            viewingImage = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "photo")
                Text("View Image")
            }
            .font(.caption.weight(.medium))
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.current.accent)
    }

    // MARK: - Image side

    private var imageView: some View {
        VStack(spacing: 0) {
            if isGenerating {
                banner(
                    icon: "sparkles",
                    text: "Generating the document…",
                    tint: theme.current.accent,
                    action: ("Back to progress", { viewingImage = false }))
            } else {
                banner(
                    icon: "arrow.uturn.backward",
                    text: "Viewing image",
                    tint: theme.current.accent,
                    action: (hasDocument ? "Back to result" : "Back to setup", { viewingImage = false }))
            }
            ImageShowPanel(selectedURL: $selectedURL)
        }
    }

    private func banner(icon: String, text: String, tint: Color,
                        action: (label: String, perform: () -> Void)?) -> some View {
        HStack(spacing: 8) {
            if icon == "sparkles" {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: icon).font(.caption).foregroundStyle(tint)
            }
            Text(text).font(.caption).foregroundStyle(.secondary)
            Spacer()
            if let action {
                Button(action.label, action: action.perform)
                    .font(.caption.weight(.medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(tint)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(tint.opacity(0.08))
    }
}
