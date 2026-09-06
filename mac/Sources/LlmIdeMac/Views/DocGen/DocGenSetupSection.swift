import AppKit
import SwiftUI

/// Where generated documents go. Only local-folder output is wired; Box, Slack
/// and email render disabled so the panel is honest about what works today.
struct DocGenSetupSection: View {
    @Binding var isExpanded: Bool

    @EnvironmentObject private var outputStore: DocGenOutputStore
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore

    private var projectRoot: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
    }

    private var resolvedPath: String {
        outputStore.config.resolvedDirectory(projectRoot: projectRoot)?.path
            ?? "Downloads"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DocGenSectionHeader(
                title: "Setup",
                icon: "gearshape",
                color: theme.current.accent,
                isExpanded: $isExpanded)

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(DocGenOutputDestination.allCases) { destination in
                        destinationRow(destination)
                    }
                    if outputStore.config.destination == .localFolder {
                        folderRow
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
    }

    private func destinationRow(_ destination: DocGenOutputDestination) -> some View {
        let selected = outputStore.config.destination == destination
        return Button {
            guard destination.isAvailable else { return }
            var config = outputStore.config
            config.destination = destination
            outputStore.update(config)
        } label: {
            HStack(spacing: 9) {
                ZStack {
                    Circle()
                        .strokeBorder(selected ? theme.current.accent : Color.secondary.opacity(0.3),
                                      lineWidth: 1.5)
                        .frame(width: 15, height: 15)
                    if selected { Circle().fill(theme.current.accent).frame(width: 7, height: 7) }
                }
                Image(systemName: destination.icon)
                    .font(.system(size: 11))
                    .foregroundStyle(destination.isAvailable ? .secondary : .tertiary)
                    .frame(width: 14)
                Text(destination.displayName)
                    .font(.callout)
                    .foregroundStyle(destination.isAvailable ? .primary : .tertiary)
                Spacer(minLength: 0)
                if !destination.isAvailable {
                    Text("Coming soon")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.12), in: Capsule())
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!destination.isAvailable)
        .help(destination.isAvailable
              ? "Save generated documents to a folder"
              : "\(destination.displayName) delivery isn't available yet")
    }

    private var folderRow: some View {
        HStack(spacing: 8) {
            Text(resolvedPath)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
                .help(resolvedPath)
            Spacer(minLength: 0)
            Button("Choose…") { chooseFolder() }
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundStyle(theme.current.accent)
            if outputStore.config.localFolderPath != nil {
                Button {
                    var config = outputStore.config
                    config.localFolderPath = nil
                    outputStore.update(config)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Use the project's data/ folder")
            }
        }
        .padding(.leading, 24)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        var config = outputStore.config
        config.localFolderPath = url.path
        outputStore.update(config)
    }
}

/// Collapse chevron + icon + label, matching the Library sidebar's
/// section-header convention. Lifted out of `DocGenSourcePanel` so all three
/// sections render an identical header.
struct DocGenSectionHeader: View {
    let title: String
    let icon: String
    let color: Color
    @Binding var isExpanded: Bool

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .frame(width: 10)
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(color.opacity(0.9))
                SectionLabel(title, size: 10)
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Collapse \(title)" : "Expand \(title)")
    }
}
