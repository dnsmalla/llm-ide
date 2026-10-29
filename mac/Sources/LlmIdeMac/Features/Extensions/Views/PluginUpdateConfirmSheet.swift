import SwiftUI

/// Shown when a Claude Code plugin update needs the user to accept a
/// marketplace-declared command first. Nothing has run yet: Accept re-sends
/// the update with this exact sha256, so the server only runs the command the
/// user saw here.
struct PluginUpdateConfirmSheet: View {
    let confirmation: PluginUpdateConfirmation
    let onAccept: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Update \(confirmation.pluginName)?")
                .font(.headline)
            Text("The plugin's marketplace declares a command that Claude Code runs during this update. "
                 + "Review it before accepting — nothing has run yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                Text("Command").font(.callout)
                ScrollView([.vertical, .horizontal]) {
                    Text(commandText)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(hasCommandText ? .primary : .secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(minHeight: 60, maxHeight: 180)
                .background(Color.primary.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("SHA-256").font(.callout)
                Text(confirmation.sha256)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }
                    .keyboardShortcut(.cancelAction)
                // Deliberately no default-action shortcut: accepting runs a
                // command, so Return must not do it.
                Button("Accept and update") { onAccept() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private var hasCommandText: Bool {
        !confirmation.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// An empty box would read as "nothing to review"; say so explicitly.
    private var commandText: String {
        hasCommandText ? confirmation.command : "(no command text provided)"
    }
}
