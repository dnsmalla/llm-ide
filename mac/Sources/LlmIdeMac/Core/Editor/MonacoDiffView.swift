import SwiftUI

/// Read-only diff visual — the "view" half of Source Control's diff
/// experience, paired with a native SwiftUI hunk list (`HunkStagingList`,
/// where staging applies) for the "act" half. Declarative, exactly like
/// `MonacoEditorView`: set `original`/`modified`/`language` and SwiftUI's
/// normal re-render cycle applies the change through `MonacoHost`.
///
/// Unlike `MonacoRevealRequest`, `MonacoDiffRequest` needs no per-render
/// identity trick — it's `Equatable` on its full value, so `MonacoHost`'s
/// own diffing already treats "show the same diff again" as a correct
/// no-op. A fresh `MonacoDiffRequest` can be constructed inline here every
/// render.
struct MonacoDiffView: View {
    var original: String
    var modified: String
    var language: String = "plaintext"

    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        MonacoHost(
            theme: theme.current,
            diffRequest: MonacoDiffRequest(original: original, modified: modified, language: language),
            readOnly: true
        )
    }
}
