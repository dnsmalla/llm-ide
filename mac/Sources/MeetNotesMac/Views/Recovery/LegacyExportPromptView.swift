import SwiftUI

struct LegacyExportPromptView: View {
    let onExport: () -> Void
    let onSkip: () -> Void
    let onDontAsk: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "tray.and.arrow.down")
                .font(.largeTitle).foregroundStyle(.tint)
            Text("Export legacy meetings?")
                .font(.title2.weight(.semibold))
            Text("Meetings stored from before the new file-based system can be exported to your Notes folder as .md files. This runs once.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 400)
            HStack {
                Button("Don't ask again", action: onDontAsk)
                Spacer()
                Button("Skip for now", action: onSkip)
                Button("Export now", action: onExport).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 480)
    }
}
