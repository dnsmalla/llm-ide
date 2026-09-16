import SwiftUI

/// Canonical sheet header: title + optional subtitle + right-aligned
/// Cancel button. Used by all the workflow/agent/issue sheets.
struct SheetHeader: View {
    let title: String
    var subtitle: String? = nil
    var cancelDisabled: Bool = false
    let onCancel: () -> Void

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Cancel", action: onCancel)
                .keyboardShortcut(.cancelAction)
                .disabled(cancelDisabled)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }
}
