import SwiftUI

/// Settings card for `docGenUseServerStore` (docs-kit K1b). The preference is
/// read again the next time a project's Doc Gen files load, so reopen the
/// project after flipping it.
struct DocGenServerStoreCard: View {
    @AppStorage(DocGenServerStorePreference.key) private var useServer = false

    var body: some View {
        SettingsSectionCard(icon: "server.rack", title: "Doc Gen files") {
            Toggle("Use the server for Doc Gen files (beta)", isOn: $useServer)
            Text("Doc Gen's template and command files in a project's templates/ and commands/ folders are listed, saved and deleted through the server. Symlinked template folders are still listed from this Mac. If the server cannot answer, the Mac uses its own copy of the files. Reopen the project to apply a change.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
