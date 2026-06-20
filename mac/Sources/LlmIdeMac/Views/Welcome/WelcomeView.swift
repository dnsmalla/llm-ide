import SwiftUI
import AppKit

/// Entry point shown when no project is active. A centered hero with two
/// clearly-separated paths — start a *new* project or *open an existing*
/// one — a plain-language explainer, and a polished recent-projects list.
struct WelcomeView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    @State private var error: String?

    var body: some View {
        let t = theme.current
        ScrollView {
            VStack(spacing: Spacing.xxl) {
                hero(t)
                if let archived = projectStore.corruptStateArchivedAt {
                    corruptStateBanner(archived, t)
                }
                actionCards(t)
                explainer(t)
                if !projectStore.recents.isEmpty { recentsSection(t) }
                if let err = error { errorBanner(err, t) }
            }
            .frame(maxWidth: 840)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Spacing.xl)
            .padding(.vertical, Spacing.xxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.body)
    }

    // MARK: - Hero

    private func hero(_ t: Theme) -> some View {
        VStack(spacing: Spacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(t.accent.opacity(0.15))
                    .frame(width: 64, height: 64)
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(t.accent)
            }
            Text("LLM IDE")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(t.text)
            Text("Meeting intelligence & project control. Each project lives in its own folder — meetings, notes, plans, and code, side by side.")
                .font(Typography.body)
                .foregroundStyle(t.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Spacing.lg)
    }

    // MARK: - Action cards

    private func actionCards(_ t: Theme) -> some View {
        HStack(alignment: .top, spacing: Spacing.lg) {
            ActionCard(
                icon: "folder.badge.plus",
                tint: t.accent,
                title: "New Project",
                subtitle: "Pick an empty folder. LLM IDE sets up the workspace and you start fresh.",
                cta: "Choose Folder…",
                theme: t,
                action: newProject)

            ActionCard(
                icon: "folder",
                tint: t.accent2,
                title: "Open Existing",
                subtitle: "Resume a LLM IDE project, or adopt a folder you've already cloned.",
                cta: "Open Folder…",
                theme: t,
                action: openExisting)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Explainer

    private func explainer(_ t: Theme) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "info.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(t.accent2)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text("What counts as a project folder?")
                    .font(Typography.captionStrong)
                    .foregroundStyle(t.text)
                Text("A project keeps **meetings/**, **notes/**, and **plans/** together with its own settings. Choose an empty folder to start, an existing project to resume, or a cloned code repo — LLM IDE adds what it needs without overwriting your files.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .fill(t.accent2.opacity(0.07)))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .strokeBorder(t.accent2.opacity(0.18), lineWidth: 1))
    }

    // MARK: - Recents

    private func recentsSection(_ t: Theme) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("RECENT PROJECTS")
                    .font(Typography.treeHeader)
                    .foregroundStyle(t.textMuted)
                Spacer()
                Text("\(projectStore.recents.count)")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            VStack(spacing: Spacing.xs) {
                ForEach(projectStore.recents) { entry in
                    RecentRow(entry: entry, theme: t) {
                        do { try projectStore.switchTo(recent: entry); error = nil }
                        catch { self.error = error.localizedDescription }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Corrupt-state notice

    private func corruptStateBanner(_ archived: URL, _ t: Theme) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(t.accent4)
                .font(.system(size: 13))
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text("Recent-projects list was reset")
                    .font(Typography.captionStrong)
                    .foregroundStyle(t.text)
                Text("The saved list was unreadable and has been archived to \(archived.lastPathComponent). Your project folders are untouched — reopen them with “Open Folder”.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button("Dismiss") { projectStore.acknowledgeCorruptState() }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .fill(t.accent4.opacity(0.10)))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .strokeBorder(t.accent4.opacity(0.30), lineWidth: 1))
    }

    // MARK: - Error

    private func errorBanner(_ message: String, _ t: Theme) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(t.danger)
                .font(.system(size: 13))
                .padding(.top, 1)
            Text(message)
                .font(Typography.caption)
                .foregroundStyle(t.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .fill(t.danger.opacity(0.10)))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .strokeBorder(t.danger.opacity(0.30), lineWidth: 1))
    }

    // MARK: - Actions

    /// New project: the user picks a PARENT location and types a project name;
    /// we create `<parent>/<name>/` and scaffold the workspace INSIDE that new
    /// folder. This avoids the old behaviour where picking e.g. the Desktop
    /// dumped source/code/data/notes/system directly onto the Desktop. The named
    /// folder is created fresh, so scaffolding into it is always clean. Code
    /// only lands in code/ once a GitHub/GitLab repo is set up.
    private func newProject() {
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.title = "New Project"
        panel.prompt = "Create Project"
        panel.nameFieldLabel = "Project name:"
        panel.nameFieldStringValue = "New Project"
        panel.message = "Choose where to create the project. A new folder with this name is created and set up inside it."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            // NSSavePanel returns <parent>/<typed-name>. Create that folder
            // (no-op if it already exists) and scaffold inside it.
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            try projectStore.ensureProjectScaffold(at: url)
            try projectStore.openFolder(at: url)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Open existing: an already-scaffolded project or an adopted folder.
    private func openExisting() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open Project"
        panel.message = "Choose a LLM IDE project folder (or a cloned repo) to open."
        open(panel)
    }

    private func open(_ panel: NSOpenPanel) {
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try projectStore.openFolder(at: url); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

// MARK: - Action card

private struct ActionCard: View {
    let icon: String
    let tint: Color
    let title: String
    let subtitle: String
    let cta: String
    let theme: Theme
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(tint.opacity(0.15))
                        .frame(width: 38, height: 38)
                    Image(systemName: icon)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(tint)
                }
                Text(title)
                    .font(Typography.title)
                    .foregroundStyle(theme.text)
                Text(subtitle)
                    .font(Typography.caption)
                    .foregroundStyle(theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 5) {
                    Text(cta)
                        .font(Typography.button)
                        .foregroundStyle(tint)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(tint)
                        .offset(x: hovering ? 3 : 0)
                }
                .padding(.top, Spacing.xs)
            }
            .padding(Spacing.lg)
            .frame(maxWidth: .infinity, minHeight: 168, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
                    .fill(theme.surface))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
                    .strokeBorder(hovering ? tint.opacity(0.55) : theme.border,
                                  lineWidth: 1))
            .shadow(color: .black.opacity(hovering ? 0.12 : 0),
                    radius: hovering ? 10 : 0, y: hovering ? 4 : 0)
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hovering = h } }
    }
}

// MARK: - Recent row

private struct RecentRow: View {
    let entry: ProjectStore.RecentEntry
    let theme: Theme
    let action: () -> Void

    @State private var hovering = false

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.md) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(theme.accent.opacity(0.12))
                        .frame(width: 32, height: 32)
                    Image(systemName: "folder.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.accent)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.displayName)
                        .font(Typography.bodyStrong)
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                    Text(entry.path)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: Spacing.sm)
                Text(Self.relativeFormatter.localizedString(
                    for: entry.lastOpenedAt, relativeTo: Date()))
                    .font(Typography.caption)
                    .foregroundStyle(theme.textMuted)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.textMuted.opacity(hovering ? 1 : 0.5))
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .background(
                RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                    .fill(hovering ? theme.surface2 : theme.surface))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hovering = h } }
    }
}
