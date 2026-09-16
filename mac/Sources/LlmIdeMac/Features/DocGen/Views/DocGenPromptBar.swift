import SwiftUI

/// Doc Gen's prompt bar: the shared `GenerationPromptBar` (Generate/Edit/Save),
/// unmodified, plus one Doc-Gen-only addition shown only in "Use chat" mode —
/// the shared `GenerationSaveChatOutputRow`, reading the `.docGen` chat.
///
/// Mirrors `VisualPromptBar` exactly, just against Doc Gen's own
/// `DOCGEN_USE_CHAT` key and `.docGen` scope — see `GenerationSaveChatOutputRow`
/// for why the save-row logic itself lives in `Views/Shared` rather than
/// being duplicated between the two wrappers.
struct DocGenPromptBar: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient

    /// Doc Gen's own "talk to chat instead" toggle — namespaced separately
    /// from Visual's `VISUAL_USE_CHAT` so the two tabs' modes never share
    /// state. `DocGenSourcePanel` owns the toggle UI itself, but NOT the
    /// mirror onto `vm.relaxRequirements` — that sync is owned by
    /// `DocGenView` (`Views/DocGen/DocGenView.swift`), which is always
    /// constructed for this tab, unlike `DocGenSourcePanel`, which only
    /// exists in the tree while Sources is visible. Verify against
    /// `DocGenView.useChatMode`'s doc comment rather than assuming.
    @AppStorage("DOCGEN_USE_CHAT") private var useChatMode = false

    var body: some View {
        VStack(spacing: 0) {
            GenerationPromptBar(vm: vm, api: api)
            if useChatMode {
                Divider()
                GenerationSaveChatOutputRow(vm: vm, api: api, scope: .docGen)
            }
        }
    }
}
