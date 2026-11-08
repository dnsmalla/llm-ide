import SwiftUI
import SharedProtocol

/// The chat's project scope: the projects the paired desktop offers, the caller's role on each, and the
/// host's reason when a frame is refused. Selecting a project scopes the next chat frame; the picker stays
/// usable after a refusal so another project can be tried.
struct ProjectPickerBar: View {
    @EnvironmentObject var projects: ProjectsStore
    /// A turn is in flight (or parked on an answer): switching then would send the answer to another project.
    let isBusy: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            if projects.state.projects.isEmpty {
                emptyOrLoading
            } else {
                picker
                if let error = projects.state.error {
                    notice(HostApiProjectNotices.loadError(error))
                }
            }
            if let refusal = projects.state.refusal {
                notice(HostApiProjectNotices.refusal(refusal))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.vertical, DesignSystem.Spacing.xs)
        .background(DesignSystem.Colors.background)
        .overlay(alignment: .bottom) { Divider() }
    }

    // MARK: — Pickers

    private var picker: some View {
        HStack(spacing: DesignSystem.Spacing.xs) {
            Image(systemName: "folder")
                .font(.system(size: 13))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Text("Project")
                .font(DesignSystem.Typography.captionFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Menu {
                ForEach(projects.state.projects, id: \.id) { project in
                    Button {
                        onSelect(project.id)
                    } label: {
                        if project.id == projects.state.selectedId {
                            Label("\(project.name) — \(project.role)", systemImage: "checkmark")
                        } else {
                            Text("\(project.name) — \(project.role)")
                        }
                    }
                }
            } label: {
                selectedLabel
            }
            .disabled(isBusy)
            Spacer(minLength: 0)
        }
    }

    private var selectedLabel: some View {
        let selected = projects.selectedProject
        return HStack(spacing: 6) {
            Text(selected?.name ?? HostApiProjectNotices.choose)
                .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .lineLimit(1)
            if let role = selected?.role {
                Text(role)
                    .font(DesignSystem.Typography.captionFont.weight(.medium))
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(DesignSystem.Colors.surfaceSecondary, in: Capsule())
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(DesignSystem.Colors.surface, in: Capsule())
        .overlay(Capsule().stroke(DesignSystem.Colors.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(selected.map { "Project \($0.name), role \($0.role)" } ?? HostApiProjectNotices.choose)
    }

    // MARK: — Empty, loading and refusals

    @ViewBuilder
    private var emptyOrLoading: some View {
        if !projects.state.loaded {
            Text(HostApiProjectNotices.loading)
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textSecondary)
        } else if let error = projects.state.error {
            notice(HostApiProjectNotices.loadError(error))
        } else {
            Text(HostApiProjectNotices.empty)
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A plain, dismissable-by-fixing-it message: text only, so the picker above stays tappable.
    private func notice(_ text: String) -> some View {
        Text(text)
            .font(DesignSystem.Typography.captionFont)
            .foregroundColor(DesignSystem.Colors.danger)
            .fixedSize(horizontal: false, vertical: true)
    }
}
