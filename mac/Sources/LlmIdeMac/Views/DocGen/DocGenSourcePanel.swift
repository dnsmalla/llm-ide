import SwiftUI

/// Doc Gen's left panel: where output goes, what shape the document takes, and
/// which files feed it — in the order the user works through them.
struct DocGenSourcePanel: View {
    @ObservedObject var vm: DocGenViewModel
    let api: LlmIdeAPIClient

    /// Persisted set of EXPANDED section ids (comma-joined). Absence ⇒
    /// collapsed, so this panel opens fully closed — the user expands what
    /// they need. Opt-in (rather than an opt-out "collapsed" set seeded with
    /// today's section ids) so a section added later is closed automatically
    /// with no key to remember to update here — see `LibraryView`'s
    /// `expandedSourceGroups` for the same reasoning applied to an
    /// already-shipped key, where a stale seeded default silently failed to
    /// take effect on any install that had already toggled a section.
    @AppStorage("docgen.expandedSections") private var expandedSectionsRaw = "template,sources"

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
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    DocGenSetupSection(isExpanded: sectionExpanded("setup"))
                    Divider().padding(.vertical, 6)
                    DocGenTemplateSection(vm: vm, isExpanded: sectionExpanded("template"))
                    Divider().padding(.vertical, 6)
                    DocGenSourceTree(vm: vm, isExpanded: sectionExpanded("sources"))
                }
                .padding(.bottom, 12)
            }

            Divider()
            footer
        }
        .background(Color(nsColor: .windowBackgroundColor))
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
