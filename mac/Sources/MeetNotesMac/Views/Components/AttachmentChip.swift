import SwiftUI

/// Pill badge for a file attached to the code-assistant or review panel.
/// Displays a shortened path (parent/filename) with a dismiss button.
struct AttachmentChip: View {
    let path: String
    let charCount: Int
    let onRemove: () -> Void

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        let t = theme.current
        HStack(spacing: 4) {
            Image(systemName: "doc.text")
                .font(.system(size: 10))
                .foregroundStyle(t.textMuted)
            Text(displayPath)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(t.text)
                .help(path + "  ·  \(charCount) chars")
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(t.textMuted)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(t.body)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(t.border.opacity(0.6), lineWidth: 0.5))
    }

    private var displayPath: String {
        let parts = path.split(separator: "/")
        guard let last = parts.last else { return path }
        return parts.count >= 2 ? "\(parts[parts.count - 2])/\(last)" : String(last)
    }
}
