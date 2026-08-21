// Loop Engineering home — the loop-list pane in front of the per-loop
// workspace, mirroring AutoCodeView's left-list/right-detail split
// (AutoCodeView.swift). This view owns which loops exist for the active
// project (create/duplicate/delete/set Primary); LoopEngineView (unchanged
// internally, see its own file header) owns everything about running and
// configuring ONE selected loop.

import SwiftUI

struct LoopEngineHomeView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore

    @State private var loops: [LoopDefinition] = []
    @State private var selectedLoopId: String?
    @State private var isPresentingNewLoopWizard = false
    @State private var skillCatalog: [LlmIdeAPIClient.SkillLibraryEntry] = []
    @StateObject private var templateStore = LoopTemplateStore()
    @State private var loopPendingDelete: LoopDefinition?

    private var activeProjectId: String? { projectStore.activeProject?.bundle.id }
    private var workspaceContext: WorkspaceRoot.Context? {
        WorkspaceRoot.context(config: config, projectStore: projectStore)
    }

    var body: some View {
        HStack(spacing: 0) {
            loopListPane
                .frame(width: 220)
            Divider()
            if let selectedLoopId {
                LoopEngineView(api: api, loopId: selectedLoopId)
                    .id(selectedLoopId)
            } else {
                emptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(theme.current.body)
        .navigationTitle("Loop")
        .task(id: activeProjectId) {
            reloadLoops()
        }
        .sheet(isPresented: $isPresentingNewLoopWizard) {
            NewLoopWizardView(
                templateStore: templateStore,
                skillCatalog: skillCatalog,
                gitRoot: workspaceContext?.gitRoot,
                onCreate: createLoop)
        }
        .alert("Delete this loop?", isPresented: Binding(
            get: { loopPendingDelete != nil },
            set: { if !$0 { loopPendingDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { loopPendingDelete = nil }
            Button("Delete", role: .destructive) {
                if let loop = loopPendingDelete { deleteLoop(loop) }
                loopPendingDelete = nil
            }
        } message: {
            if let loop = loopPendingDelete, loop.isPrimary,
               let nextPrimary = loops.first(where: { $0.id != loop.id }) {
                Text("Its stages, budgets, and run history stay on disk under this project's loop.json, but it will no longer appear here. \"\(nextPrimary.name)\" will become the new Primary loop.")
            } else {
                Text("Its stages, budgets, and run history stay on disk under this project's loop.json, but it will no longer appear here.")
            }
        }
    }

    // MARK: - Loop list

    private var loopListPane: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                SectionLabel("LOOPS")
                Spacer()
                Button { isPresentingNewLoopWizard = true } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .help("New loop")
                .accessibilityLabel("New loop")
            }
            .padding(.horizontal, Spacing.md)
            .padding(.top, Spacing.sm)
            .padding(.bottom, 4)

            List(selection: $selectedLoopId) {
                ForEach(loops) { loop in
                    loopRow(loop).tag(Optional(loop.id))
                }
            }
            .listStyle(.sidebar)
        }
        .background(t.surface)
    }

    @ViewBuilder
    private func loopRow(_ loop: LoopDefinition) -> some View {
        let t = theme.current
        HStack(spacing: 6) {
            Circle()
                .fill(isRunning(loop) ? t.success : Color.clear)
                .frame(width: 6, height: 6)
            Text(loop.name)
                .font(Typography.filename)
                .lineLimit(1)
                .truncationMode(.middle)
            if loop.isPrimary {
                Image(systemName: "star.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(t.accent)
                    .help("Primary — the loop the scheduled Auto Task and phone run")
            }
            Spacer(minLength: 4)
            Menu {
                if !loop.isPrimary {
                    Button("Set as Primary") { setPrimary(loop) }
                }
                Button("Duplicate") { duplicateLoop(loop) }
                if loops.count > 1 {
                    Button("Delete", role: .destructive) { loopPendingDelete = loop }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(t.textMuted)
            }
            .buttonStyle(.borderless)
        }
    }

    private func isRunning(_ loop: LoopDefinition) -> Bool {
        guard let gitRoot = workspaceContext?.gitRoot else { return false }
        return LoopEngineRunner.activeLoopId(gitRoot: gitRoot) == loop.id
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.sm) {
            Text("No loops yet")
                .font(Typography.title)
                .foregroundStyle(theme.current.textMuted)
            Button("New Loop") { isPresentingNewLoopWizard = true }
                .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Loading

    private func reloadLoops() {
        guard let projectId = activeProjectId else {
            loops = []
            selectedLoopId = nil
            return
        }
        let store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store?.loops ?? []
        if selectedLoopId == nil || !loops.contains(where: { $0.id == selectedLoopId }) {
            selectedLoopId = loops.first(where: \.isPrimary)?.id ?? loops.first?.id
        }
        Task { await loadSkillsIfNeeded() }
    }

    private func loadSkillsIfNeeded() async {
        guard skillCatalog.isEmpty else { return }
        if let skills = try? await api.skillLibrary() {
            skillCatalog = skills
        }
    }

    // MARK: - Mutations

    /// Creates a new loop from the wizard's finished config, appends it to
    /// this project's loop list, saves immediately (finishing the wizard IS
    /// the confirmation — same reasoning `LoopEngineView.applyNewLoopConfig`
    /// used to document before this task moved that flow up here), and
    /// selects it.
    private func createLoop(_ config: LoopEngineConfig) {
        guard let projectId = activeProjectId else { return }
        let newLoop = LoopDefinition(name: "New Loop \(loops.count + 1)",
                                     isPrimary: loops.isEmpty, config: config)
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops.append(newLoop)
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
        selectedLoopId = newLoop.id
    }

    private func duplicateLoop(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId else { return }
        var copy = loop
        copy.id = UUID().uuidString
        copy.name = "\(loop.name) copy"
        copy.isPrimary = false
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops.append(copy)
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
        selectedLoopId = copy.id
    }

    /// Refuses when `loop` is the last one — a project must always have at
    /// least one loop, matching the invariant that used to be implicit
    /// ("every project has a config"). The row's ⋯ menu already hides
    /// Delete in that case; this is the belt-and-suspenders check.
    private func deleteLoop(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId, loops.count > 1 else { return }
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops.removeAll { $0.id == loop.id }
        // Deleting the Primary loop promotes the next one — a project must
        // always have exactly one Primary once it has any loop at all.
        if loop.isPrimary, var next = store.loops.first {
            next.isPrimary = true
            store.loops[0] = next
        }
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
        if selectedLoopId == loop.id {
            selectedLoopId = loops.first(where: \.isPrimary)?.id ?? loops.first?.id
        }
    }

    /// Moves the ★ to `loop`, clearing it everywhere else — a project has
    /// exactly one Primary loop at a time.
    private func setPrimary(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId else { return }
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops = store.loops.map { entry in
            var copy = entry
            copy.isPrimary = (entry.id == loop.id)
            return copy
        }
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
    }
}
