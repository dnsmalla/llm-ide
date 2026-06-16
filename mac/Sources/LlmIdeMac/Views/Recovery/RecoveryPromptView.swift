import SwiftUI

struct RecoveryPromptView: View {
    @EnvironmentObject private var theme: ThemeStore
    let orphan: PartialRecovery.Orphan
    let onRecover: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "arrow.uturn.backward.circle.fill")
                .font(.largeTitle).foregroundStyle(theme.current.warning)
            Text("Unfinished recording found").font(.title2.weight(.semibold))
            Text("From \(orphan.startedAt.formatted(date: .abbreviated, time: .shortened)). Recover and finalize, or dismiss to leave the partial file in place.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            HStack {
                Button("Dismiss", action: onDismiss)
                Spacer()
                Button("Recover", action: onRecover).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24).frame(width: 480)
    }
}
