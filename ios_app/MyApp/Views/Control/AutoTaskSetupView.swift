import SwiftUI
import SharedProtocol

/// The phone's half of the Mac's Auto Task Settings and Template cards: pick a
/// task's input folder, output folder, agent skill, and prompt template, and
/// edit the templates themselves.
///
/// The Mac stays the executor and the source of truth — every control sends a
/// request and the fresh `auto_task_setup_reply` drives what is shown, which is
/// the same contract the run/toggle controls already follow. Nothing is applied
/// optimistically, so the phone can never show a setting the Mac rejected.
struct AutoTaskSetupView: View {
    /// Which task is being configured (`AutoTaskInfo.id`).
    let taskId: String
    let taskLabel: String

    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @Environment(\.dismiss) private var dismiss

    @State private var editingTemplate: AutoTaskTemplateInfo?
    @State private var isCreatingTemplate = false

    private var isConnected: Bool { connection.connectionStatus == .connected }
    private var setup: AutoTaskSetupReply? { autoTaskStore.setup }
    private var config: AutoTaskConfigInfo { autoTaskStore.config(for: taskId) }

    var body: some View {
        List {
            if !isConnected {
                notConnectedSection
            } else if let setup, !setup.hasProject {
                noProjectSection
            } else if setup == nil {
                loadingSection
            } else {
                pathsSection
                skillSection
                templateSection
            }
        }
        .listStyle(.insetGrouped)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .scrollContentBackground(.hidden)
        .navigationTitle(taskLabel)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    autoTaskStore.autoTaskSetupList()
                } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh task setup")
            }
        }
        .onAppear { autoTaskStore.autoTaskSetupList() }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected { autoTaskStore.autoTaskSetupList() }
        }
        .sheet(item: $editingTemplate) { template in
            NavigationStack {
                AutoTaskTemplateEditorView(template: template)
                    .environmentObject(autoTaskStore)
            }
        }
        .sheet(isPresented: $isCreatingTemplate) {
            NavigationStack {
                AutoTaskTemplateEditorView(template: nil)
                    .environmentObject(autoTaskStore)
            }
        }
    }

    // MARK: — Paths

    private var pathsSection: some View {
        Section {
            folderPicker(title: "Input", value: config.inputPath,
                         emptyLabel: "Whole project") { path in
                update { $0.withInputPath(path) }
            }
            folderPicker(title: "Output", value: config.outputPath,
                         emptyLabel: "Not set") { path in
                update { $0.withOutputPath(path) }
            }
        } header: {
            Text("Paths")
        } footer: {
            Text("Folders from the project open on your Mac. Input scopes what the task reads; output is where it writes what it produces.")
        }
    }

    @ViewBuilder
    private func folderPicker(title: String, value: String?, emptyLabel: String,
                              onSelect: @escaping (String?) -> Void) -> some View {
        Picker(title, selection: Binding(
            get: { value ?? "" },
            set: { onSelect($0.isEmpty ? nil : $0) }
        )) {
            Text(emptyLabel).tag("")
            // A folder saved on the Mac but absent from the scan (renamed or
            // deleted since) keeps a row, so selecting the picker can't
            // silently reset a setting the user never touched.
            if let value, !(setup?.folders.contains(value) ?? false) {
                Text("\(value) (missing)").tag(value)
            }
            ForEach(setup?.folders ?? [], id: \.self) { folder in
                Text(folder).tag(folder)
            }
        }
    }

    // MARK: — Skill

    private var skillSection: some View {
        Section {
            Picker("Skill", selection: Binding(
                get: { config.skillName ?? "" },
                set: { name in update { $0.withSkillName(name.isEmpty ? nil : name) } }
            )) {
                Text("None").tag("")
                if let saved = config.skillName,
                   !(setup?.skills.contains { $0.name == saved } ?? false) {
                    Text("\(saved) (not installed)").tag(saved)
                }
                ForEach(setup?.skills ?? []) { skill in
                    Text(skill.name).tag(skill.name)
                }
            }
            if let name = config.skillName,
               let description = setup?.skills.first(where: { $0.name == name })?.description,
               !description.isEmpty {
                Text(description)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        } header: {
            Text("Skill")
        } footer: {
            Text(setup?.skills.isEmpty == true
                 ? "No skills found in the project's .claude/skills/ on your Mac."
                 : "Runs the prompt under one of the project's agent skills.")
        }
    }

    // MARK: — Template

    private var templateSection: some View {
        Section {
            Picker("Template", selection: Binding(
                get: { config.templateId ?? "" },
                set: { id in update { $0.withTemplateId(id.isEmpty ? nil : id) } }
            )) {
                Text("The task's own prompt").tag("")
                if let id = config.templateId,
                   !(setup?.templates.contains { $0.id == id } ?? false) {
                    Text("\(id) (missing)").tag(id)
                }
                ForEach(setup?.templates ?? []) { template in
                    Text(template.name).tag(template.id)
                }
            }

            ForEach(setup?.templates ?? []) { template in
                Button {
                    editingTemplate = template
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(template.name)
                                .font(DesignSystem.Typography.bodyFont)
                                .foregroundColor(DesignSystem.Colors.textPrimary)
                            Text(template.body.replacingOccurrences(of: "\n", with: " "))
                                .font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if template.id == config.templateId {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(DesignSystem.Colors.primary)
                        }
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12))
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                }
                .buttonStyle(.plain)
            }

            Button {
                isCreatingTemplate = true
            } label: {
                Label("New Template", systemImage: "plus.circle")
            }
        } header: {
            Text("Template")
        } footer: {
            Text("Templates are markdown files in templates/auto_task/ on your Mac, shared by every task that selects one.")
        }
    }

    // MARK: — States

    private var notConnectedSection: some View {
        emptyState(icon: "wifi.slash", title: "Not connected to your Mac",
                   detail: "Connect to change this task's settings.")
    }

    private var noProjectSection: some View {
        emptyState(icon: "folder.badge.questionmark", title: "No project open on your Mac",
                   detail: "Paths, skills, and templates all come from the open project. Open one on your Mac, then refresh.")
    }

    private var loadingSection: some View {
        Section {
            HStack(spacing: DesignSystem.Spacing.sm) {
                ProgressView().scaleEffect(0.8)
                Text("Loading task setup…")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
    }

    private func emptyState(icon: String, title: String, detail: String) -> some View {
        Section {
            VStack(spacing: DesignSystem.Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 34))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                Text(title)
                    .font(DesignSystem.Typography.calloutFont.weight(.medium))
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                Text(detail)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
            .listRowBackground(Color.clear)
        }
    }

    /// Send a whole updated config — the wire message replaces rather than
    /// patches, so each control rebuilds the config from the current one.
    private func update(_ transform: (AutoTaskConfigInfo) -> AutoTaskConfigInfo) {
        autoTaskStore.setConfig(transform(config))
    }
}

// MARK: - Config field updates

private extension AutoTaskConfigInfo {
    func withInputPath(_ value: String?) -> AutoTaskConfigInfo {
        AutoTaskConfigInfo(taskId: taskId, inputPath: value, outputPath: outputPath,
                           skillName: skillName, templateId: templateId)
    }
    func withOutputPath(_ value: String?) -> AutoTaskConfigInfo {
        AutoTaskConfigInfo(taskId: taskId, inputPath: inputPath, outputPath: value,
                           skillName: skillName, templateId: templateId)
    }
    func withSkillName(_ value: String?) -> AutoTaskConfigInfo {
        AutoTaskConfigInfo(taskId: taskId, inputPath: inputPath, outputPath: outputPath,
                           skillName: value, templateId: templateId)
    }
    func withTemplateId(_ value: String?) -> AutoTaskConfigInfo {
        AutoTaskConfigInfo(taskId: taskId, inputPath: inputPath, outputPath: outputPath,
                           skillName: skillName, templateId: value)
    }
}
