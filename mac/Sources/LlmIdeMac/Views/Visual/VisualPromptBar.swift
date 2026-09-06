import SwiftUI

/// Visual's prompt bar: the shared `GenerationPromptBar` (Generate/Edit/Save),
/// unmodified, plus one Visual-only addition shown only in "Use chat" mode —
/// the shared `GenerationSaveChatOutputRow`, reading the `.visual` chat.
///
/// Built as a wrapper rather than editing `GenerationPromptBar.swift` itself:
/// that file is shared with Doc Gen, and composing around it keeps both tabs'
/// prompt bars independent while sharing the "Save chat output" control
/// itself — see `GenerationSaveChatOutputRow` for why that piece moved to
/// `Views/Shared`, and `DocGenPromptBar` for Doc Gen's mirror of this file.
struct VisualPromptBar: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient

    /// Visual's own "talk to chat instead" toggle — namespaced separately
    /// from Doc Gen's `DOCGEN_USE_CHAT` so the two tabs' modes never share
    /// state. See `VisualSourcePanel`, which owns the toggle UI and mirrors
    /// this same key onto `vm.relaxRequirements`.
    @AppStorage("VISUAL_USE_CHAT") private var useChatMode = false

    var body: some View {
        VStack(spacing: 0) {
            GenerationPromptBar(vm: vm, api: api)
            if useChatMode {
                Divider()
                GenerationSaveChatOutputRow(vm: vm, api: api, scope: .visual)
            }
        }
    }
}
