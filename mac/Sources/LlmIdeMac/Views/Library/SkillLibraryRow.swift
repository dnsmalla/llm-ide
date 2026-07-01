import SwiftUI

/// Sidebar row for a skill entry in the Library.
///
/// Shows a kind badge (read / write), the skill name, and a short
/// description. A lock icon distinguishes built-in (core / global)
/// skills from plugin-contributed ones.
struct SkillLibraryRow: View {
    @EnvironmentObject private var theme: ThemeStore
    let skill: LlmIdeAPIClient.SkillEntry
    /// When non-nil the row shows a plugin badge instead of a lock.
    let pluginName: String?

    var body: some View {
        HStack(spacing: 8) {
            kindDot
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(skill.name)
                        .font(.callout)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    sourceBadge
                }
                if !skill.description.isEmpty {
                    Text(skill.description)
                        .font(Typography.fileMeta)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Kind indicator dot

    private var kindDot: some View {
        ZStack {
            Circle()
                .fill(kindColor.opacity(0.15))
                .frame(width: 28, height: 28)
            Image(systemName: kindIcon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(kindColor)
        }
    }

    private var kindColor: Color { skill.kind == "write" ? theme.current.warning : theme.current.info }
    private var kindIcon: String  { skill.kind == "write" ? "pencil" : "magnifyingglass" }

    // MARK: - Source badge (lock = built-in, puzzle = plugin)

    private var sourceBadge: some View {
        Group {
            if pluginName != nil {
                Image(systemName: "puzzlepiece.extension.fill")
                    .font(.caption2)
                    .foregroundStyle(.teal.opacity(0.7))
            } else {
                Image(systemName: "lock.fill")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
