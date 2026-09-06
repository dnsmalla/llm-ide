import SwiftUI

/// Doc Gen's centre panel. Thin wrapper over the shared
/// `GenerationEditorPanel` (`Views/Shared/GenerationEditorPanel.swift`),
/// which Visual's `VisualCenterPanel` also builds on — see that file's doc
/// comment for why the shared body lives outside `Views/DocGen` (this
/// directory is excluded from lite/min builds; the shared body must not be).
///
/// Kept as its own type/file — rather than calling `GenerationEditorPanel`
/// directly from `DocGenView` — so Doc Gen's own copy (the steps checklist
/// text and the "no sources" hint, both specific to Doc Gen's Code / LLM Doc
/// / Data sources tabs) stays declared here, easy to find and change without
/// touching the shared file Visual also depends on.
struct DocGenEditorPanel: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient

    var body: some View {
        GenerationEditorPanel(
            vm: vm,
            api: api,
            sourcesEmptyHint: "Check files from Code, LLM Doc or Data in the left panel.",
            steps: [
                GenerationChecklistStep(
                    title: "Choose a template or command",
                    detail: "Pick either one in the Template & Command section on the left",
                    done: vm.selectedTemplate != nil || vm.selectedCommand != nil),
                GenerationChecklistStep(
                    title: "Select code or doc files or folders",
                    detail: "Tick files, or a whole folder, in the Sources section on the left",
                    done: !vm.selectedSources.isEmpty),
                GenerationChecklistStep(
                    title: "Add a prompt and generate",
                    detail: "Write a short prompt in the panel on the right, then press Generate",
                    done: false),
            ])
    }
}
