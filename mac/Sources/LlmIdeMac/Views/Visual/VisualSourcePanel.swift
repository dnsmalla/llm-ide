import SwiftUI

/// Visual's left panel — mirrors `DocGenSourcePanel`'s three sections (Setup,
/// Template & Command, Sources) so the generation flow reads identically to
/// Doc Gen, plus the "Use chat" toggle both tabs now carry independently
/// (see `DocGenSourcePanel`'s own copy).
///
/// Deliberately its own type rather than a shared one: the expanded-sections
/// and source-tab `@AppStorage` keys must be namespaced separately from Doc
/// Gen's ("docgen.…") so the two panels don't fight over one persisted
/// collapse/tab state, and each tab's "Use chat" toggle must stay on its own
/// key so the two modes never share state.
struct VisualSourcePanel: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient
    /// The image viewer's selection, owned by `VisualView` and threaded
    /// straight through to `GenerationSourceTree` so tapping a file's name
    /// here opens it in `VisualCenterPanel` — see
    /// `GenerationSourceTree.selectedURL` for why this is a distinct tap
    /// target from the source-ticking checkbox.
    @Binding var selectedURL: URL?
    /// Visual's own "talk to chat instead" toggle. Own key so it never
    /// shares state with Doc Gen's `DOCGEN_USE_CHAT` — see
    /// `DocGenSourcePanel` for the identical pattern this mirrors.
    /// `VisualPromptBar` declares its own `@AppStorage` on this same key to
    /// decide whether to show its "Save chat output" control — that is how
    /// `@AppStorage` sharing works, so each `private` declaration is still
    /// correct on its own. NOTE: this panel only writes the key — the mirror
    /// onto `vm.relaxRequirements` is owned by `VisualView` (always
    /// constructed for this tab), not here — see `VisualView.useChatMode`'s
    /// doc comment and `DocGenSourcePanel`'s identical note.
    @AppStorage("VISUAL_USE_CHAT") private var useChatMode = false

    /// See `DocGenSourcePanel.expandedSectionsRaw` for why this is an opt-in
    /// (expanded, not collapsed) set — same reasoning, own key so Visual's
    /// collapse state doesn't collide with Doc Gen's.
    @AppStorage("visual.expandedSections") private var expandedSectionsRaw = "template,sources"

    @EnvironmentObject private var theme: ThemeStore

    private var expandedSet: Set<String> {
        Set(expandedSectionsRaw.split(separator: ",").map(String.init))
    }

    private func sectionExpanded(_ id: String) -> Binding<Bool> {
        Binding(
            get: { expandedSet.contains(id) },
            set: { open in
                var set = expandedSet
                if open { set.insert(id) } else { set.remove(id) }
                expandedSectionsRaw = set.sorted().joined(separator: ",")
            }
        )
    }

    /// Ticked sources that `/generate-doc` cannot read (it loads every source
    /// as UTF-8 text — see `GenerationViewModel.generate`). Visual's whole
    /// library is image-centric, so this is the common case here, not the
    /// exception Doc Gen sees. Computed up front — before Generate is even
    /// pressed — so the limitation is visible while the user is still
    /// picking sources, not just after a run comes back with a skipped list.
    ///
    /// Deliberately NOT `ImageShowPanel.isImage` alone: that set includes
    /// `svg`, but SVG is XML text — `/generate-doc` reads it fine as UTF-8.
    /// Warning on it would tell users a working source is broken.
    private var unreadableImageSources: [String] {
        vm.selectedSources.compactMap { source -> String? in
            guard case .file(let url, let name) = source,
                  ImageShowPanel.isImage(url),
                  url.pathExtension.lowercased() != "svg"
            else { return nil }
            return name
        }.sorted()
    }

    var body: some View {
        VStack(spacing: 0) {
            // "Use chat" is a run input exactly like Setup/Template/Sources
            // below — grouped into the SAME `.disabled` region as those (not
            // a sibling outside it), so it can't be flipped mid-run either.
            // See `DocGenSourcePanel`'s identical structure.
            VStack(spacing: 0) {
                useChatToggle
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        GenerationSetupSection(isExpanded: sectionExpanded("setup"))
                        Divider().padding(.vertical, 6)
                        GenerationTemplateSection(vm: vm, isExpanded: sectionExpanded("template"))
                        Divider().padding(.vertical, 6)
                        GenerationSourceTree(
                            vm: vm, isExpanded: sectionExpanded("sources"),
                            categories: [.data, .code],
                            sourceTabStorageKey: "visual.sourceTab",
                            selectedURL: $selectedURL)
                        if !unreadableImageSources.isEmpty {
                            imageSourceWarning
                        }
                    }
                    .padding(.bottom, 12)
                }
            }
            .disabled(vm.isBusy)
            .opacity(vm.isBusy ? 0.5 : 1)

            Divider()
            footer
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Use chat toggle

    private var useChatToggle: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: $useChatMode) {
                HStack(spacing: 6) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.current.accent)
                    Text("Use chat")
                        .font(.callout.weight(.medium))
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            Text(useChatMode
                 ? "Template and command are optional — a source is still required. Talk to the chat panel and save its reply when you're happy with it."
                 : "Off: pick a template or command and at least one source, then Generate.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Image-source warning

    private var imageSourceWarning: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(theme.current.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(unreadableImageSources.count) image source\(unreadableImageSources.count == 1 ? "" : "s") ticked")
                    .font(.caption.weight(.medium))
                // NOTE: do not send users to "Use chat" for images. This
                // panel's chat (CodeAssistantPanel, CodeAssistant+Attachments)
                // base64-encodes image bytes with a `[binary:...]` prefix into
                // a plain-text attachment that nothing on the server ever
                // decodes back into a picture — the model would just
                // hallucinate over the blob while it eats ~40% of the
                // attachment budget.
                //
                // There is currently NO working way for a user to get an
                // image to a model from this app, on ANY chat surface.
                // /kb/agent/ask does accept real image content blocks
                // server-side (extension/routes/agent.mjs -> runClaude(...,
                // images)), and the iPhone's mobile chat used to feed it real
                // images that way — but the phone now shares the Mac's
                // `.quick` code-pipeline engine, whose transport has no image
                // parameter at all, so `MobileControlManager.handleChat`
                // refuses images outright. Neither `LlmChatSheet` nor
                // `MenuBarChatView` ever had an attach affordance to produce
                // one. Do not point a future change at any chat surface as a
                // working vision path without first wiring an attach UI AND
                // carrying the image through that pipeline.
                Text("Generate reads sources as text, so \(unreadableImageSources.count == 1 ? "this image" : "these images") will be skipped — image files can't be used as generation sources.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(theme.current.warning.opacity(0.08))
    }

    private var footer: some View {
        HStack(spacing: 7) {
            Image(systemName: "books.vertical")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("\(vm.selectedSources.count) selected")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
