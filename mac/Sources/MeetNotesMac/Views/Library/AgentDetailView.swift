import SwiftUI

/// Library detail pane for a single persona. This view OWNS the
/// full edit + manage surface for the persona registry — there's no
/// separate Settings card. Library is where users browse + manage
/// agents; Settings → App stays for app-wide settings only.
///
/// Routes:
///   - LibrarySelection.agent(personaId)        → edit that persona
///   - LibrarySelection.agent("default") AND no
///     personas exist yet                      → "Create your first" CTA
struct AgentDetailView: View {
    let api: MeetNotesAPIClient
    let personaId: String
    @Environment(ShellState.self) private var shell
    @EnvironmentObject private var theme: ThemeStore

    @State private var personas: [MeetNotesAPIClient.AgentPersonaRow] = []
    @State private var activeId: String?
    @State private var loaded = false

    // Draft (what the user is editing) — flushed to server on Save.
    @State private var draftName: String = ""
    @State private var draftSuffix: String = ""
    @State private var draftAutoDispatch: Bool = false

    @State private var busy = false
    @State private var status: String?
    @State private var stats: MeetNotesAPIClient.AgentFeedbackStats?

    private var current: MeetNotesAPIClient.AgentPersonaRow? {
        personas.first { $0.id == personaId }
    }
    private var isActive: Bool { activeId == personaId }
    private var isBootstrap: Bool { !loaded ? false : (personas.isEmpty && personaId == "default") }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                if isBootstrap {
                    bootstrapCTA
                } else if !loaded {
                    ProgressView().controlSize(.small)
                } else if current != nil {
                    editor
                    Divider()
                    feedbackCard
                } else {
                    Text("This persona no longer exists — it may have been deleted in another window.")
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(theme.current.body)
        .task(id: personaId) { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .agentPersonaChanged)) { _ in
            Task { await load() }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkle")
                .font(.system(size: 28))
                .foregroundStyle(.purple)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(displayTitle)
                        .font(.title2.bold())
                    if isActive {
                        Text("⭐ Active")
                            .font(.caption.bold())
                            .foregroundStyle(theme.current.accent4)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(theme.current.accent4.opacity(
                                theme.current.isDark ? 0.15 : 0.12),
                                in: RoundedRectangle(cornerRadius: 4))
                    }
                }
                Text("Persona that introduces itself in meetings and asks follow-up questions. Configured here — applies everywhere the agent speaks.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    private var displayTitle: String {
        if let n = current?.name, !n.isEmpty { return n }
        if isBootstrap { return "Meeting agent" }
        return "(unnamed)"
    }

    // MARK: - Bootstrap CTA

    private var bootstrapCTA: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("No personas yet.")
                .font(.headline)
            Text("Create your first persona — give the meeting agent a name and a voice. You can keep multiple personas later (e.g. \"Triage Bot\" vs \"Design Reviewer\") and switch which one is active.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await createDefault() }
            } label: {
                Label("Create default persona", systemImage: "plus.circle.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
        }
    }

    // MARK: - Editor

    @ViewBuilder
    private var editor: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Name").font(.callout).foregroundStyle(.secondary)
                TextField("Agent", text: $draftName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(busy)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Voice / focus").font(.callout).foregroundStyle(.secondary)
                TextEditor(text: $draftSuffix)
                    .font(.body)
                    .frame(minHeight: 80, maxHeight: 140)
                    .padding(4)
                    .background(theme.current.surface2)
                    .cornerRadius(6)
                    .overlay(RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(theme.current.border, lineWidth: 1))
                    .disabled(busy)
            }
            Toggle(isOn: $draftAutoDispatch) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Auto-dispatch when capture starts").font(.callout)
                    Text("Fires this persona automatically when recording begins — when it's the active one.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            .disabled(busy)

            HStack {
                Button(busy ? "Saving…" : "Save") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)

                Button("Revert") { populateDraft() }
                    .disabled(busy)

                Spacer()

                if !isActive {
                    Button {
                        Task { await setActive() }
                    } label: {
                        Label("Set as active", systemImage: "star.fill")
                    }
                    .disabled(busy)
                }

                Button(role: .destructive) {
                    Task { await delete() }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(busy || personas.count <= 1)
                .help(personas.count <= 1 ? "Can't delete the only persona" : "Delete this persona")
            }
            if let s = status {
                Text(s).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Feedback

    @ViewBuilder
    private var feedbackCard: some View {
        if let s = stats, s.total > 0 {
            VStack(alignment: .leading, spacing: 6) {
                Text("Feedback — last \(s.sinceDays)d")
                    .font(.headline)
                HStack(spacing: 16) {
                    feedbackChip(label: "Useful", count: s.byVerdict.useful, color: .green)
                    feedbackChip(label: "Noise",  count: s.byVerdict.noise,  color: .orange)
                    feedbackChip(label: "Later",  count: s.byVerdict.later,  color: .blue)
                    if let rate = s.usefulRate {
                        Spacer()
                        Text("\(Int((rate * 100).rounded()))% useful").font(.title3.bold())
                    }
                }
                Text("Over \(s.total) question\(s.total == 1 ? "" : "s"). Aggregated across all personas — the API doesn't yet partition feedback per persona.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func feedbackChip(label: String, count: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(count)").font(.title3.bold()).foregroundStyle(color)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    // MARK: - Data + actions

    private func load() async {
        do {
            let list = try await api.listAgentPersonas()
            self.personas = list.personas
            self.activeId = list.active
            populateDraft()
            self.status = nil
        } catch {
            self.status = error.localizedDescription
        }
        async let s = try? api.getAgentFeedbackStats()
        self.stats = await s
        loaded = true
    }

    private func populateDraft() {
        guard let p = current else { return }
        draftName = p.name ?? ""
        draftSuffix = p.promptSuffix ?? ""
        draftAutoDispatch = p.autoDispatch
    }

    private func createDefault() async {
        busy = true; status = nil
        defer { busy = false }
        do {
            _ = try await api.createAgentPersona(
                name: "Meeting agent",
                promptSuffix: "",
                autoDispatch: false,
            )
            NotificationCenter.default.post(name: .agentPersonaChanged, object: nil)
            await load()
        } catch {
            status = error.localizedDescription
        }
    }

    private func save() async {
        guard current != nil else { return }
        busy = true; status = nil
        defer { busy = false }
        do {
            _ = try await api.updateAgentPersona(
                id: personaId,
                name: draftName,
                promptSuffix: draftSuffix,
                autoDispatch: draftAutoDispatch,
            )
            status = "Saved."
            NotificationCenter.default.post(name: .agentPersonaChanged, object: nil)
        } catch {
            status = error.localizedDescription
        }
    }

    private func setActive() async {
        busy = true; status = nil
        defer { busy = false }
        do {
            _ = try await api.setActiveAgentPersona(id: personaId)
            NotificationCenter.default.post(name: .agentPersonaChanged, object: nil)
            await load()
        } catch {
            status = error.localizedDescription
        }
    }

    private func delete() async {
        busy = true; status = nil
        defer { busy = false }
        do {
            _ = try await api.deleteAgentPersona(id: personaId)
            NotificationCenter.default.post(name: .agentPersonaChanged, object: nil)
            // Hop back to the sidebar root so we're not staring at a
            // detail pane whose record no longer exists.
            shell.librarySelection = nil
        } catch {
            status = error.localizedDescription
        }
    }
}
