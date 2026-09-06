import SwiftUI

/// Doc Gen's left panel: where output goes, what shape the document takes, and
/// which files feed it — in the order the user works through them — plus the
/// "Use chat" toggle, mirroring `VisualSourcePanel`'s.
struct DocGenSourcePanel: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient

    /// Doc Gen's own "talk to chat instead" toggle. Own key so it never
    /// shares state with Visual's `VISUAL_USE_CHAT` — see `VisualSourcePanel`
    /// for the identical pattern this mirrors, and `DocGenPromptBar`, which
    /// declares its own `@AppStorage` on this same key to decide whether to
    /// show its "Save chat output" control. This panel mirrors the value
    /// onto `vm.relaxRequirements`.
    @AppStorage("DOCGEN_USE_CHAT") private var useChatMode = false

    /// Persisted set of EXPANDED section ids (comma-joined). Absence ⇒
    /// collapsed, so this panel opens fully closed — the user expands what
    /// they need. Opt-in (rather than an opt-out "collapsed" set seeded with
    /// today's section ids) so a section added later is closed automatically
    /// with no key to remember to update here — see `LibraryView`'s
    /// `expandedSourceGroups` for the same reasoning applied to an
    /// already-shipped key, where a stale seeded default silently failed to
    /// take effect on any install that had already toggled a section.
    @AppStorage("docgen.expandedSections") private var expandedSectionsRaw = "template,sources"

    @EnvironmentObject private var theme: ThemeStore

    private var expandedSet: Set<String> {
        Set(expandedSectionsRaw.split(separator: ",").map(String.init))
    }

    /// Binding for a section's expanded state, persisted in
    /// `expandedSectionsRaw`. Drives every section's collapse chevron.
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
                        categories: [.code, .notes, .data],
                        sourceTabStorageKey: "docgen.sourceTab")
                }
                .padding(.bottom, 12)
            }
            // Setup, Template & Command, and Sources all live inside this
            // ScrollView — one `.disabled` here covers all three while a
            // generation (fresh or an applied edit) is in flight, instead of
            // desyncing the run's inputs from what's still selectable.
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
