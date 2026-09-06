import SwiftUI

/// Visual's centre panel: `ImageShowPanel` while idle (with a status banner
/// on top while a run is in flight — the image itself stays at full opacity,
/// not dimmed), and the generated document once a run completes or fails —
/// with a control back to the image either way. The
/// image `selectedURL` binding is threaded straight through untouched, so
/// flipping between image and document never loses the tree selection.
struct VisualCenterPanel: View {
    @ObservedObject var vm: GenerationViewModel
    @Binding var selectedURL: URL?

    @EnvironmentObject private var theme: ThemeStore

    /// True once the user has manually flipped back to the image after a
    /// document finished (or failed). Reset the moment a fresh run starts (or
    /// the document is discarded back to idle) so the NEXT result is shown by
    /// default rather than staying pinned on whatever the user last chose.
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

    private var showingDocument: Bool { hasDocument && !viewingImage }

    var body: some View {
        Group {
            if showingDocument {
                documentView
            } else {
                imageView
            }
        }
        .onChange(of: vm.generationState) { _, newValue in
            switch newValue {
            case .idle, .generating: viewingImage = false
            case .done, .error: break
            }
        }
    }

    // MARK: - Image side

    private var imageView: some View {
        VStack(spacing: 0) {
            if isGenerating {
                banner(
                    icon: "sparkles",
                    text: "Generating the document — the image stays visible until it's ready…",
                    tint: theme.current.accent,
                    action: nil)
            } else if hasDocument {
                banner(
                    icon: "arrow.uturn.backward",
                    text: "Viewing image",
                    tint: theme.current.accent,
                    action: ("Back to result", { viewingImage = false }))
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

    // MARK: - Document side

    @ViewBuilder
    private var documentView: some View {
        switch vm.generationState {
        case .done(let text, let skipped):
            doneDocument(text: text, skipped: skipped)
        case .error(let message):
            errorDocument(message: message)
        case .idle, .generating:
            EmptyView() // unreachable — showingDocument gates on hasDocument
        }
    }

    private func doneDocument(text: String, skipped: [String]) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.current.success)
                Text(vm.isSaved
                     ? "Saved — press Start another in the right panel to generate a new document"
                     : "Document ready — press Edit in the right panel to revise it")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    viewingImage = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "photo")
                        Text("View image")
                    }
                    .font(.caption.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.current.accent)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(theme.current.success.opacity(0.06))

            if !skipped.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(theme.current.warning)
                    Text("\(skipped.count) source\(skipped.count == 1 ? "" : "s") could not be read and were skipped: \(skipped.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(theme.current.warning.opacity(0.08))
            }

            Divider()

            // Read-only, same as Doc Gen: revising the document is
            // prompt-driven via Edit in the right panel's prompt bar, not
            // free-form typing here.
            TextEditor(text: $vm.editedContent)
                .font(.system(.callout, design: .monospaced))
                .scrollContentBackground(.hidden)
                .background(Color(nsColor: .textBackgroundColor))
                .disabled(true)
                .opacity(0.85)
                .onAppear { if vm.editedContent.isEmpty { vm.editedContent = text } }
                .onChange(of: text) { _, new in vm.editedContent = new }
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func errorDocument(message: String) -> some View {
        VStack(spacing: 20) {
            ZStack {
                Circle().fill(theme.current.danger.opacity(0.1)).frame(width: 64, height: 64)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(theme.current.danger.opacity(0.7))
            }
            VStack(spacing: 6) {
                Text("Generation Failed").font(.headline)
                Text(message)
                    .font(.callout).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 340)
            }
            HStack(spacing: 10) {
                Button("Try Again") { vm.resetToIdle() }
                    .buttonStyle(.borderedProminent)
                Button("View Image") { viewingImage = true }
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}
