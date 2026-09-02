import SwiftUI

/// The "Settings" card in an Auto Task's detail pane: where the task reads,
/// where it writes, and which agent skill it runs under.
///
/// Paths are chosen from the Library (`LibraryFolderPicker`) rather than a
/// free-form disk browser — the Library is where a project's content lives, and
/// a task pointed outside it would be reading something the project does not
/// track. The value is stored project-relative, so it survives the project
/// moving on disk.
struct AutoTaskSettingsSection: View {
    /// Task id — `AutoTask.rawValue` or `CustomAutoTask.id`.
    let taskId: String
    @ObservedObject var configs: AutoTaskConfigStore
    @ObservedObject var skills: AutoTaskSkillCatalog
    /// Project root the relative paths resolve against; nil when none is open.
    let projectRoot: URL?
    /// Whether this task's file changes survive the run. False for every review
    /// task (`runCLI` reverts the tree afterwards), which is why the output
    /// path reads differently for them — see `AutoTaskPromptComposer.compose`.
    let writesFiles: Bool

    @EnvironmentObject private var theme: ThemeStore

    private enum ActivePicker: String, Identifiable {
        case input, output
        var id: String { rawValue }
    }
    @State private var activePicker: ActivePicker?

    private var config: AutoTaskConfig { configs.config(for: taskId) }

    var body: some View {
        AutoTaskSectionCard("Settings", systemImage: "slider.horizontal.3",
                            accessory: AnyView(reloadSkillsButton)) {
            VStack(alignment: .leading, spacing: Spacing.md) {
                AutoTaskField("Input path",
                              hint: "What the task reads. Empty means the whole project.") {
                    pathRow(value: config.inputPath, picker: .input) { updated in
                        var next = config
                        next.inputPath = updated
                        configs.update(next, for: taskId)
                    }
                }

                AutoTaskField("Output path", hint: outputHint) {
                    pathRow(value: config.outputPath, picker: .output) { updated in
                        var next = config
                        next.outputPath = updated
                        configs.update(next, for: taskId)
                    }
                }

                AutoTaskField("Skill", hint: skillHint) {
                    skillPicker
                }
            }
        }
        .sheet(item: $activePicker) { picker in
            LibraryFolderPicker(
                title: picker == .input ? "Input folder" : "Output folder",
                projectRoot: projectRoot,
                selection: picker == .input ? config.inputPath : config.outputPath
            ) { path in
                var next = config
                if picker == .input { next.inputPath = path } else { next.outputPath = path }
                configs.update(next, for: taskId)
            }
        }
        .onAppear { skills.reload(projectRoot: projectRoot) }
        .onChange(of: projectRoot) { _, root in skills.reload(projectRoot: root) }
    }

    // MARK: - Path row

    /// What the output path means for this task. A review task's edits are
    /// reverted after the run, so the setting names a destination for the model
    /// to describe rather than one it writes to — saying otherwise would
    /// promise a file that gets deleted seconds later.
    private var outputHint: String {
        writesFiles
            ? "Where the task writes what it produces."
            : "This task is read-only — its edits are reverted after the run. The path is passed as the intended destination, and findings go to the log."
    }

    /// A monospaced path field with a Library "Choose…" button. The field is
    /// editable as well as pickable: a folder that has no indexed files yet
    /// (a task's brand-new output directory) can be typed in directly, which
    /// the picker alone could not express.
    @ViewBuilder
    private func pathRow(value: String?, picker: ActivePicker,
                         set: @escaping (String?) -> Void) -> some View {
        HStack(spacing: 6) {
            TextField("Whole project", text: Binding(
                get: { value ?? "" },
                set: {
                    let trimmed = $0.trimmingCharacters(in: .whitespaces)
                    set(trimmed.isEmpty ? nil : trimmed)
                }
            ))
            .textFieldStyle(.roundedBorder)
            .font(Typography.mono)
            // Disabled with no project for the same reason as the pickers: a
            // path typed here would land in the store's no-project bucket,
            // which nothing surfaces again once a project opens.
            .disabled(projectRoot == nil)

            Button("Choose…") { activePicker = picker }
                .controlSize(.small)
                .disabled(projectRoot == nil)

            if value != nil {
                Button {
                    set(nil)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(theme.current.textMuted)
                }
                .buttonStyle(.borderless)
                .help("Clear")
            }
        }
    }

    // MARK: - Skill

    private var skillHint: String {
        guard projectRoot != nil else {
            return "Open a project to choose a skill."
        }
        if !skills.hasScanned { return "Reading the project's skills…" }
        if skills.skills.isEmpty {
            return "No skills found in this project's .claude/skills/. Rebuild the project to install the central kit."
        }
        if let name = config.skillName {
            return "The prompt is prefixed with “\(AutoTaskSkillCatalog.directive(for: name))”."
        }
        return "Runs the prompt under one of the project's agent skills."
    }

    private var skillPicker: some View {
        Picker("Skill", selection: Binding(
            get: { config.skillName ?? "" },
            set: { name in
                var next = config
                next.skillName = name.isEmpty ? nil : name
                next.skillDirective = name.isEmpty ? nil : AutoTaskSkillCatalog.directive(for: name)
                configs.update(next, for: taskId)
            }
        )) {
            Text("None").tag("")
            // A skill saved earlier but no longer on disk still needs a row, or
            // selecting it would silently snap the picker back to "None" and
            // wipe a setting the user never touched.
            if let saved = config.skillName, !skills.skills.contains(where: { $0.name == saved }) {
                Text("\(saved) (not installed)").tag(saved)
            }
            ForEach(skills.skills) { skill in
                Text(skill.name).tag(skill.name)
            }
        }
        .labelsHidden()
        .disabled(projectRoot == nil)
    }

    private var reloadSkillsButton: some View {
        Button {
            skills.reload(projectRoot: projectRoot, force: true)
        } label: {
            Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.borderless)
        .font(Typography.caption)
        .foregroundStyle(theme.current.textMuted)
        .help("Rescan this project's .claude/skills/")
        .disabled(projectRoot == nil)
    }
}
