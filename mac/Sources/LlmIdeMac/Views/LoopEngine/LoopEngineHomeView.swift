// Loop Engineering home — the loop-list pane in front of the per-loop
// workspace, mirroring AutoCodeView's left-list/right-detail split
// (AutoCodeView.swift). This view owns which loops exist for the active
// project (create/duplicate/delete/set Primary/run on schedule);
// LoopEngineView owns everything about running and configuring ONE selected
// loop.
//
// A project's built-in checks are INDEPENDENT LOOPS here, not pinned stages
// inside one pipeline: Regression, Test and System Check each get their own
// row, their own process, their own budgets and their own run history, and
// each is run on its own. They are marked `isDefault` (LoopDefinition.
// defaultKey) so they cannot be deleted — the same invariant the pinned
// stages had — while any loop the user adds is fully theirs to edit or
// delete. LoopStageDetector.ensureDefaultLoops is what creates them and what
// migrated a pre-split project's single "Main Loop" into them.

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
            if loop.isDefault {
                Image(systemName: "lock.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(t.textMuted)
                    .help("Built-in loop — editable and can be switched off, but not deleted")
            }
            if loop.isPrimary {
                Image(systemName: "star.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(t.accent)
                    .help("Primary — the loop the phone and the chat command run")
            }
            if !loop.runsOnSchedule {
                Image(systemName: "clock.badge.xmark")
                    .font(.system(size: 9))
                    .foregroundStyle(t.textMuted)
                    .help("Not run by the scheduled Loop auto task")
            }
            Spacer(minLength: 4)
            Menu {
                if !loop.isPrimary {
                    Button("Set as Primary") { setPrimary(loop) }
                }
                Button(loop.runsOnSchedule ? "Don't run on schedule" : "Run on schedule") {
                    setRunsOnSchedule(loop, !loop.runsOnSchedule)
                }
                Button("Duplicate") { duplicateLoop(loop) }
                // A built-in loop is never deletable — `ensureDefaultLoops`
                // would recreate it on the next load, so offering Delete
                // would be a button that appears to do nothing. Switching it
                // off (its stages, or "Don't run on schedule") is the
                // sanctioned escape hatch, exactly as it is for a pinned stage.
                if !loop.isDefault, loops.count > 1 {
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
        // The ensuring loader, not a raw `load`: this is where a project's
        // default loops are created and where a pre-split project is migrated
        // into them — the Loop page is the surface the user is looking at when
        // it happens, and it persists the result (see its doc comment).
        let store = LoopEngineConfigStore.loops(projectRoot: workspaceContext?.projectRoot,
                                                projectId: projectId,
                                                gitRoot: workspaceContext?.gitRoot)
        loops = store.loops
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
        let newLoop = LoopDefinition(name: "New Loop \(loops.count + 1)",
                                     isPrimary: loops.isEmpty, config: config)
        mutateStore { $0.loops.append(newLoop) }
        selectedLoopId = newLoop.id
    }

    private func duplicateLoop(_ loop: LoopDefinition) {
        var copy = loop
        copy.id = UUID().uuidString
        copy.name = "\(loop.name) copy"
        copy.isPrimary = false
        // A copy is an ordinary user loop: it must not claim a built-in's
        // identity, or `ensureDefaultLoops` would treat two loops as the same
        // default. Its STAGES keep their `defaultKey`s, though — those are what
        // the split routes by, so the copy's stages would be moved back out
        // from under it. Clear them too.
        copy.defaultKey = nil
        copy.config.stages = copy.config.stages.map { stage in
            var s = stage
            s.isDefault = false
            s.defaultKey = nil
            return s
        }
        mutateStore { $0.loops.append(copy) }
        selectedLoopId = copy.id
    }

    /// Refuses when `loop` is the last one, or when it is a built-in default —
    /// a project must always have at least one loop, and a default would be
    /// recreated by `ensureDefaultLoops` on the next load anyway. The row's ⋯
    /// menu already hides Delete in both cases; this is the belt-and-suspenders
    /// check.
    private func deleteLoop(_ loop: LoopDefinition) {
        guard loops.count > 1, !loop.isDefault else { return }
        mutateStore { store in
            store.loops.removeAll { $0.id == loop.id }
            // Deleting the Primary loop promotes the next one — a project must
            // always have exactly one Primary once it has any loop at all.
            if loop.isPrimary, var next = store.loops.first {
                next.isPrimary = true
                store.loops[0] = next
            }
        }
        if selectedLoopId == loop.id {
            selectedLoopId = loops.first(where: \.isPrimary)?.id ?? loops.first?.id
        }
    }

    /// Opt `loop` in or out of the scheduled `.loopEngineering` Auto Task.
    /// Each opted-in loop runs as its own independent run when the task
    /// fires — see `LoopDefinition.runsOnSchedule`.
    private func setRunsOnSchedule(_ loop: LoopDefinition, _ enabled: Bool) {
        mutateStore { store in
            guard let index = store.loops.firstIndex(where: { $0.id == loop.id }) else { return }
            store.loops[index].runsOnSchedule = enabled
        }
    }

    /// Read-modify-write of this project's whole loop list — the store persists
    /// the list, never one loop, so every mutation here has to re-read first.
    private func mutateStore(_ body: (inout LoopEngineProjectStore) -> Void) {
        guard let projectId = activeProjectId else { return }
        var store = LoopEngineConfigStore.loops(projectRoot: workspaceContext?.projectRoot,
                                                projectId: projectId,
                                                gitRoot: workspaceContext?.gitRoot)
        body(&store)
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
    }

    /// Moves the ★ to `loop`, clearing it everywhere else — a project has
    /// exactly one Primary loop at a time.
    private func setPrimary(_ loop: LoopDefinition) {
        mutateStore { store in
            store.loops = store.loops.map { entry in
                var copy = entry
                copy.isPrimary = (entry.id == loop.id)
                return copy
            }
        }
    }
}
