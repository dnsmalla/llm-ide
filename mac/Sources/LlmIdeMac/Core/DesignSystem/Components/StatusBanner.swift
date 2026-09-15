import SwiftUI

/// Inline status banner with severity-driven styling.
/// Replaces the per-sheet errorBanner/infoBanner helpers.
struct StatusBanner: View {
    enum Severity {
        case error
        case info
        case warning
    }

    let severity: Severity
    let message: String
    var onDismiss: (() -> Void)? = nil

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .font(.callout)
                .accessibilityHidden(true)
            Text(message)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss message")
                .help("Dismiss")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var icon: String {
        switch severity {
        case .error:   return "exclamationmark.triangle.fill"
        case .info:    return "info.circle.fill"
        case .warning: return "exclamationmark.circle.fill"
        }
    }

    private var tint: Color {
        switch severity {
        case .error:   return .red
        case .info:    return .blue
        case .warning: return .orange
        }
    }
}
