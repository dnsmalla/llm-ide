import SwiftUI

/// Visual's left panel — mirrors `DocGenSourcePanel`'s three sections (Setup,
/// Template & Command, Sources) so the generation flow reads identically to
/// Doc Gen, plus one Visual-only addition: the "Use chat" toggle.
///
/// Deliberately its own type rather than a shared one: the expanded-sections
/// and source-tab `@AppStorage` keys must be namespaced separately from Doc
/// Gen's ("docgen.…") so the two panels don't fight over one persisted
/// collapse/tab state, and "Use chat" must never appear in Doc Gen at all.
struct VisualSourcePanel: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient
    /// Visual's own "talk to chat instead" toggle. Owned here (not on
    /// `GenerationViewModel`, which Doc Gen shares) so it can never leak into
    /// Doc Gen's UI. `VisualView` reads this same key to decide the center
    /// panel's fallback tone and the prompt bar's extra "Save chat output"
    /// control, and mirrors it onto `vm.relaxRequirements`.
    @AppStorage("VISUAL_USE_CHAT") var useChatMode = false

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
    private var unreadableImageSources: [String] {
        vm.selectedSources.compactMap { source -> String? in
            guard case .file(let url, let name) = source, ImageShowPanel.isImage(url) else { return nil }
            return name
        }.sorted()
    }

    var body: some View {
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
                        sourceTabStorageKey: "visual.sourceTab")
                    if !unreadableImageSources.isEmpty {
                        imageSourceWarning
                    }
                }
                .padding(.bottom, 12)
            }
            .disabled(vm.isBusy)
            .opacity(vm.isBusy ? 0.5 : 1)

            Divider()
            footer
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { vm.relaxRequirements = useChatMode }
        .onChange(of: useChatMode) { _, newValue in vm.relaxRequirements = newValue }
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
                 ? "Template, command and sources are optional — talk to the chat panel and save its reply when you're happy with it."
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
                Text("Generate reads sources as text, so \(unreadableImageSources.count == 1 ? "this image" : "these images") will be skipped. Turn on Use chat above to attach images to the chat instead.")
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
