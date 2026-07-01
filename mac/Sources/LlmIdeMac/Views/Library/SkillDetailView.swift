import SwiftUI

/// Read-only detail pane for a skill (global tool, internal KB skill,
/// or plugin-contributed skill). Skills are always locked — editing
/// them requires changing the skill file on disk and restarting the
/// server (or using the Plugin install flow for plugin skills).
struct SkillDetailView: View {
    let skill: LlmIdeAPIClient.SkillEntry
    /// Non-nil when the skill was contributed by a plugin.
    let pluginName: String?
    /// Source group label: "Global Tool", "Core Skill", or plugin display name.
    let sourceName: String
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().padding(.vertical, 16)
                descriptionSection
                Divider().padding(.vertical, 16)
                metadataSection
                if pluginName != nil {
                    Divider().padding(.vertical, 16)
                    pluginNote
                } else {
                    Divider().padding(.vertical, 16)
                    coreNote
                }
                Spacer(minLength: 40)
            }
            .padding(.horizontal, 24)
            .padding(.top, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.current.body)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(kindColor.opacity(0.15))
                    .frame(width: 50, height: 50)
                Image(systemName: kindIcon)
                    .font(.title2.weight(.medium))
                    .foregroundStyle(kindColor)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(skill.name)
                        .font(.title2.weight(.semibold))
                        .textSelection(.enabled)
                    lockedBadge
                    kindBadge
                }
                Text(sourceName)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 4)
        }
    }

    private var lockedBadge: some View {
        HStack(spacing: 3) {
            Image(systemName: "lock.fill")
                .font(.caption2.weight(.semibold))
            Text(pluginName == nil ? "Built-in" : "Plugin")
                .font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(theme.current.surface2, in: Capsule())
        .foregroundStyle(theme.current.textMuted)
    }

    private var kindBadge: some View {
        Text(skill.kind.capitalized)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(kindColor.opacity(theme.current.isDark ? 0.20 : 0.15), in: Capsule())
            .foregroundStyle(kindColor)
    }

    // MARK: - Description

    private var descriptionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Description", systemImage: "text.alignleft")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            if skill.description.isEmpty {
                Text("No description provided.")
                    .font(.body)
                    .foregroundStyle(.tertiary)
            } else {
                Text(skill.description)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: - Metadata

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Details", systemImage: "list.bullet.rectangle")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            metaRow("Skill name", value: skill.name, monospaced: true)
            metaRow("Kind", value: skill.kind == "write" ? "Write — proposes changes" : "Read — returns information")
            metaRow("Source", value: sourceName)
            if let plugin = pluginName {
                metaRow("Plugin", value: plugin, monospaced: true)
            }
        }
    }

    private func metaRow(_ label: String, value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 100, alignment: .leading)
            if monospaced {
                Text(value)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
            } else {
                Text(value)
                    .font(.callout)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: - Locked notes

    private var coreNote: some View {
        noticeRow(
            icon: "lock.shield",
            color: .orange,
            title: "Core skill — cannot be removed",
            body: "This skill is built into the LLM IDE server. It is always available to the agent and cannot be deleted from the Library."
        )
    }

    private var pluginNote: some View {
        noticeRow(
            icon: "puzzlepiece.extension",
            color: .teal,
            title: "Plugin skill — managed by \(pluginName ?? "plugin")",
            body: "This skill is contributed by the \"\(pluginName ?? "plugin")\" plugin. Uninstalling the plugin removes this skill from the agent's toolkit."
        )
    }

    private func noticeRow(icon: String, color: Color, title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.callout)
                .foregroundStyle(color)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.callout.weight(.medium))
                Text(body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(color.opacity(theme.current.isDark ? 0.10 : 0.07),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: - Kind helpers

    private var kindColor: Color { skill.kind == "write" ? .orange : .blue }
    private var kindIcon: String { skill.kind == "write" ? "pencil.and.list.clipboard" : "magnifyingglass.circle" }
}
