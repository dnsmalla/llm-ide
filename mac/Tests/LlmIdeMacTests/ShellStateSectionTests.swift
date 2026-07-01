import Testing
@testable import LlmIdeMac

/// Pins the section-navigation contract: the always-on sections can never
/// be hidden, every section has display metadata, and the removed
/// "Review Code" section stays gone.
struct ShellStateSectionTests {
    typealias Section = ShellState.Section

    @Test func alwaysOnSectionsAreNotHideable() {
        // library is the landing fallback, settings is the only way back,
        // live is capture-conditional — none may appear in the hideable set.
        for s in [Section.library, .settings, .live] {
            #expect(!Section.userHideable.contains(s))
        }
    }

    @Test func hideableSectionsAreRealAndDistinct() {
        let set = Set(Section.userHideable)
        #expect(set.count == Section.userHideable.count) // no duplicates
        // Every hideable section is a real case (compile-enforced) and is
        // not one of the always-on three.
        for s in Section.userHideable {
            #expect(![Section.library, .settings, .live].contains(s))
        }
    }

    @Test func everySectionHasDisplayMetadata() {
        for s in Section.allCases {
            #expect(!s.label.isEmpty)
            #expect(!s.systemImage.isEmpty)
        }
    }

    @Test func labelsAreUnique() {
        let labels = Section.allCases.map(\.label)
        #expect(Set(labels).count == labels.count)
    }

    @Test func reviewCodeSectionIsRemoved() {
        // The standalone "Review Code" section was removed; Explorer owns
        // the file-browser role. No remaining section should carry its
        // label, and the deep-link tab must not resolve.
        #expect(!Section.allCases.map(\.label).contains("Review Code"))
        #expect(Section(deepLinkTabName: "review") == nil)
    }
}
