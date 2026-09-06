import SwiftUI

/// Step 3 of Doc Gen: a short prompt, then Generate — and, once a run finishes,
/// Edit and Save. Sits above the chat panel rather than inside it, because
/// `CodeAssistantPanel` is shared with Explorer, Review and Visual.
struct GenerationPromptBar: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient

    @EnvironmentObject private var outputStore: DocGenOutputStore
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore

    /// Guards "Start another" — shown only when the document hasn't been
    /// saved yet, so an unsaved revision isn't lost silently.
    @State private var showDiscardConfirmation = false
    /// Whether the edit-instruction field is expanded. Local UI state, not on
    /// the view model: it's transient (which control is showing), not part of
    /// the generation/document model.
    @State private var isShowingEditField = false

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
            case .done:
                doneRow()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(nsColor: .windowBackgroundColor))
        // The document only actually changes on a SUCCESSFUL generate or
        // applyEdit (a failed revision leaves `editedContent` untouched by
        // design — see `GenerationViewModel.applyEdit`). So this is the signal
        // to collapse the edit field back to the compact action row; on
        // failure it fires nothing, and the field stays open with
        // `vm.editError` visible so the user can retry without losing their
        // typed instruction or the document underneath.
        .onChange(of: vm.editedContent) { _, _ in
            isShowingEditField = false
        }
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
              : (vm.relaxRequirements
                 ? "Select at least one source to generate from, or ask in the chat panel instead"
                 : "Choose a template or command, and at least one source"))
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

    private func doneRow() -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.success)
                Text("Document ready")
                    .font(.callout.weight(.medium))
                Spacer()
            }

            if isShowingEditField {
                editPromptRow
            } else {
                actionRow
            }

            Button {
                if vm.isSaved {
                    // Already saved — nothing unsaved to lose.
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
                "Discard this document?",
                isPresented: $showDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("Discard & Start Another", role: .destructive) {
                    vm.resetToIdle()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This document has not been saved. Starting another discards it.")
            }
        }
    }

    /// Edit + Save, side by side. Both disable once the current document is
    /// saved (`vm.isSaved`) — re-pressing Save used to silently write a
    /// duplicate `-1.md` file, and a saved document has nothing left to edit
    /// until the user starts another or applies a further revision.
    private var actionRow: some View {
        HStack(spacing: 8) {
            Button {
                isShowingEditField = true
                vm.editError = nil // defensive: no stale error from an earlier attempt
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "pencil").font(.system(size: 11))
                    Text("Edit").font(.callout)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .disabled(vm.isSaved)
            .opacity(vm.isSaved ? 0.5 : 1)

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
            .disabled(vm.isSaved)
            .opacity(vm.isSaved ? 0.5 : 1)
            .help(vm.isSaved ? "Already saved" : "Save to the folder set in Setup")
        }
    }

    /// Shown after pressing Edit: a prompt-driven revision, not a typable
    /// editor. The document itself (`DocGenEditorPanel`) always stays
    /// read-only; typing an instruction here and pressing Apply Edit sends
    /// the current document back through `/generate-doc` for a full rewrite.
    ///
    /// Deliberately does NOT collapse back to `actionRow` when Apply Edit is
    /// pressed — only a successful revision does that (via the `onChange`
    /// on `body`). A failure keeps this field open, with `vm.editError`
    /// shown above it and the typed instruction still in place, so the user
    /// can adjust and retry without the document ever disappearing.
    private var editPromptRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = vm.editError {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(theme.current.danger)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button {
                        vm.editError = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Dismiss")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(theme.current.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            }

            TextField("Describe the change (e.g. \"Add a risks section\")",
                      text: $vm.editPrompt, axis: .vertical)
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

            HStack(spacing: 8) {
                Button {
                    isShowingEditField = false
                    vm.editPrompt = ""
                    vm.editError = nil
                } label: {
                    Text("Cancel")
                        .font(.callout)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)

                let canApply = !vm.editPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button {
                    vm.applyEdit(api: api)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "sparkles").font(.system(size: 11))
                        Text("Apply Edit").font(.callout.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(canApply ? theme.current.accent : Color.secondary.opacity(0.18))
                    )
                    .foregroundStyle(canApply ? .white : Color.secondary.opacity(0.5))
                }
                .buttonStyle(.plain)
                .disabled(!canApply)
            }
        }
    }
}
