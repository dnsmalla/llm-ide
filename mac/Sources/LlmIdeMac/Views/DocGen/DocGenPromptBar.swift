import SwiftUI

/// Step 3 of Doc Gen: a short prompt, then Generate — and, once a run finishes,
/// Edit and Save. Sits above the chat panel rather than inside it, because
/// `CodeAssistantPanel` is shared with Explorer, Review and Visual.
struct DocGenPromptBar: View {
    @ObservedObject var vm: DocGenViewModel
    let api: LlmIdeAPIClient

    @EnvironmentObject private var outputStore: DocGenOutputStore
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore

    /// Guards "Start another" — shown only when `vm.editedContent` has
    /// diverged from the generated text, so unsaved edits aren't lost silently.
    @State private var showDiscardConfirmation = false

    private var projectRoot: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch vm.generationState {
            case .idle, .error:
                promptField
                generateButton
            case .generating:
                generatingRow
            case .done(let generatedText, _):
                doneRow(generatedText: generatedText)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Idle

    private var promptField: some View {
        TextField("Add a short prompt (optional)", text: $vm.prompt, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.callout)
            .lineLimit(1...4)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Color.secondary.opacity(0.15), lineWidth: 1)
            )
    }

    private var generateButton: some View {
        Button { vm.generate(api: api) } label: {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").font(.system(size: 12, weight: .semibold))
                Text("Generate").font(.callout.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(vm.canGenerate ? theme.current.accent : Color.secondary.opacity(0.18))
            )
            .foregroundStyle(vm.canGenerate ? .white : Color.secondary.opacity(0.5))
        }
        .buttonStyle(.plain)
        .disabled(!vm.canGenerate)
        .help(vm.canGenerate
              ? "Generate the document"
              : "Choose a template or command, and at least one source")
        .animation(.easeInOut(duration: 0.15), value: vm.canGenerate)
    }

    // MARK: - Generating

    /// The Generate button is gone entirely while a run is in flight — the
    /// view model flips to `.generating` synchronously on click, so there is no
    /// window in which a second press could land.
    private var generatingRow: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text("Generating…")
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            Button { vm.cancelGeneration() } label: {
                HStack(spacing: 5) {
                    Image(systemName: "stop.fill").font(.system(size: 9))
                    Text("Cancel").font(.callout)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Done

    private func doneRow(generatedText: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.success)
                Text("Document ready")
                    .font(.callout.weight(.medium))
                Spacer()
            }

            HStack(spacing: 8) {
                Button {
                    vm.isEditing.toggle()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "pencil").font(.system(size: 11))
                        Text(vm.isEditing ? "Done Editing" : "Edit").font(.callout)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)

                Button {
                    vm.save(content: vm.editedContent,
                            api: api,
                            config: outputStore.config,
                            projectRoot: projectRoot)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "square.and.arrow.down.fill").font(.system(size: 11))
                        Text("Save").font(.callout.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(theme.current.accent, in: RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .help("Save to the folder set in Setup")
            }

            Button {
                if vm.editedContent == generatedText {
                    // No divergence from what was generated — nothing to lose.
                    vm.resetToIdle()
                } else {
                    showDiscardConfirmation = true
                }
            } label: {
                Text("Start another")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .confirmationDialog(
                "Discard your edits to this document?",
                isPresented: $showDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("Discard & Start Another", role: .destructive) {
                    vm.resetToIdle()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your changes have not been saved. Starting another document discards them.")
            }
        }
    }
}
