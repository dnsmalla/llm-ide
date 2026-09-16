import SwiftUI

/// One titled card in the Auto Task detail pane.
///
/// The pane used to be a flat stack of headings and controls; grouping each
/// concern (Settings, Template, Schedule, Log) into a bordered card is what
/// makes the four readable as separate decisions rather than one long form.
struct AutoTaskSectionCard<Content: View>: View {
    let title: String
    var systemImage: String
    /// Optional trailing controls in the header row (Save, Reload, …).
    var accessory: AnyView?
    @ViewBuilder var content: () -> Content

    @EnvironmentObject private var theme: ThemeStore

    init(_ title: String, systemImage: String, accessory: AnyView? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.accessory = accessory
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
                SectionLabel(title)
                Spacer(minLength: 8)
                if let accessory { accessory }
            }
            content()
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.current.surface)
        .overlay(RoundedRectangle(cornerRadius: Radius.sm)
            .strokeBorder(theme.current.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }
}

/// A label + control row, so every setting in the pane lines up on the same
/// left edge instead of each control choosing its own.
struct AutoTaskField<Content: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder var content: () -> Content

    @EnvironmentObject private var theme: ThemeStore

    init(_ label: String, hint: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.hint = hint
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            content()
            if let hint {
                Text(hint)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
