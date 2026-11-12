import SwiftUI
import SharedProtocol

/// The History tab when the desktop is not reachable: the verified snapshot and the prompt queue.
struct SyncOfflineSections: View {
    @EnvironmentObject var syncStore: SyncStore
    @EnvironmentObject var projectsStore: ProjectsStore
    @State private var draft = ""
    /// nil is "Phone chat (no project)" and sends v1. Seeded from the live selection or the remembered one.
    @State private var projectChoice: String?
    @State private var choiceSeeded = false

    var body: some View {
        SourceRootSection()
        if let snap = syncStore.snapshot {
            Section {
                Text(freshness(snap)).font(.footnote).foregroundColor(.secondary)
                if syncStore.phase == .removed { Text("This iPhone was removed from sync.").foregroundColor(.red) }
                if let e = syncStore.lastError { Text(e).font(.footnote).foregroundColor(DesignSystem.Colors.textSecondary) }
            }
            if !snap.chats.isEmpty {
                Section("Chats") { ForEach(snap.chats) { c in NavigationLink(c.title) { SyncChatView(chat: c) } } }
            }
            if !snap.meetings.isEmpty {
                Section("Meetings") { ForEach(snap.meetings) { m in NavigationLink("\(m.title) · \(m.date)") { SyncMeetingView(meeting: m) } } }
            }
            if !snap.plans.isEmpty {
                Section("Plans") { ForEach(snap.plans) { p in NavigationLink(p.title) { SyncPlanView(plan: p) } } }
            }
        } else {
            Section { Text(syncStore.refreshing ? "Loading…" : "No snapshot yet. The desktop sends one within a minute of being on.").foregroundColor(.secondary) }
        }
        if syncStore.phase == .needsPassword {
            Section { Text("Sign in to MEGA again in Settings → Sync.").foregroundColor(.secondary) }
        }
        if syncStore.phase == .ready {
            Section("Ask the desktop") {
                TextField("Prompt", text: $draft, axis: .vertical).lineLimit(2...5)
                if !syncStore.knownProjects.isEmpty {
                    Picker("Project", selection: $projectChoice) {
                        Text("Phone chat (no project)").tag(String?.none)
                        ForEach(syncStore.knownProjects) { p in Text(p.name).tag(String?.some(p.id)) }
                    }
                }
                // The draft is cleared only when the send succeeded, and only if it was not edited meanwhile.
                Button("Queue") { let t = draft; let pid = effectiveProject; Task { if await syncStore.send(t, projectId: pid), draft == t { draft = "" } } }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .onAppear { seedChoice() }
            .onChange(of: syncStore.knownProjects) { _ in seedChoice() }
        }
        if !syncStore.queued.isEmpty {
            Section("Queued prompts") {
                ForEach(syncStore.queued) { q in
                    VStack(alignment: .leading) {
                        Text(q.text)
                        if let n = q.note { Text(n).font(.footnote).foregroundColor(.secondary) }
                        if let a = q.answer { Text(a).font(.footnote).foregroundColor(.secondary) }
                        else if let c = q.code { Text(SyncStore.replyText(c)).font(.footnote).foregroundColor(.secondary) }
                    }
                }
            }
        }
    }
    /// The chosen project, or nil when none is chosen or it is no longer in the list.
    private var effectiveProject: String? {
        projectChoice.flatMap { id in syncStore.knownProjects.contains { $0.id == id } ? id : nil }
    }
    private func seedChoice() {
        guard !choiceSeeded, !syncStore.knownProjects.isEmpty else { return }
        choiceSeeded = true
        let live = projectsStore.selectedId ?? syncStore.lastSelectedProjectId
        projectChoice = live.flatMap { id in syncStore.knownProjects.contains { $0.id == id } ? id : nil }
    }
    private func freshness(_ s: SyncSnapshot) -> String {
        switch SyncFreshness(s.manifest, nowMs: Int(Date().timeIntervalSince1970 * 1000)) {
        case .current(let t): return "Desktop last seen \(Date(timeIntervalSince1970: Double(t) / 1000).formatted())"
        case .withheld(let t): return "Desktop offline or storage withholding updates. Last seen \(Date(timeIntervalSince1970: Double(t) / 1000).formatted())"
        }
    }
}

/// Settings → Sync: status, sign in again after MEGA ended the session, refresh, scan a sync QR, remove.
struct SyncSettingsCard: View {
    @EnvironmentObject var syncStore: SyncStore
    @State private var email = ""
    @State private var password = ""
    @State private var signingIn = false
    @State private var showScanner = false
    @State private var confirmRemove = false

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            Text("SYNC")
                .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textTertiary)
                .padding(.leading, DesignSystem.Spacing.xs)
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                switch syncStore.phase {
                case .off: Text("Add this iPhone from the desktop: Settings → Phone and browser → Offline sync → Add a device for offline sync, then scan the code here.")
                case .needsPassword where syncStore.storeKind == .box:
                    Text("Box ended the sign-in. Connect Box again to the account the desktop syncs to.")
                    Button(signingIn ? "Connecting…" : "Connect Box") {
                        signingIn = true
                        Task { await syncStore.reconnectBox(); signingIn = false }
                    }.disabled(signingIn)
                case .needsPassword:
                    Text("MEGA ended the sign-in. Sign in again to the dedicated sync account.")
                    TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress)
                        .autocapitalization(.none).textFieldStyle(.roundedBorder)
                    SecureField("Password", text: $password).textContentType(.password).textFieldStyle(.roundedBorder)
                    Button(signingIn ? "Signing in…" : "Sign in") {
                        let (e, p) = (email, password)
                        password = ""; signingIn = true
                        Task { await syncStore.signIn(email: e, password: p); signingIn = false }
                    }.disabled(email.isEmpty || password.isEmpty || signingIn)
                case .ready: Text("On. \(syncStore.queued.filter(\.isPending).count) prompt(s) waiting.")
                case .removed: Text("This iPhone was removed from sync.").foregroundColor(DesignSystem.Colors.danger)
                }
                if let e = syncStore.lastError {
                    Text(e).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textSecondary)
                }
                if syncStore.phase == .ready || syncStore.phase == .removed {
                    Button(syncStore.refreshing ? "Refreshing…" : "Refresh now") { Task { await syncStore.refresh() } }
                        .disabled(syncStore.refreshing)
                }
                Button("Scan a sync code") { showScanner = true }
                if syncStore.phase != .off {
                    Button("Remove sync from this iPhone", role: .destructive) { confirmRemove = true }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(DesignSystem.Spacing.md)
            .background(DesignSystem.Colors.surface)
            .cornerRadius(DesignSystem.Layout.cornerRadiusL)
        }
        .onAppear { if email.isEmpty { email = syncStore.megaEmail } }
        .sheet(isPresented: $showScanner) {
            QRScannerSheet { scan in if let pair = scan.sync { syncStore.startEnrollment(pair) } }
        }
        .confirmationDialog("Remove sync from this iPhone?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await syncStore.removeFromPhone() } }
        } message: {
            Text("The snapshot, queued prompts and keys on this iPhone are deleted. Revoke it on the desktop too.")
        }
    }
}

struct SyncChatView: View {
    let chat: SyncChat
    var body: some View {
        List(chat.messages, id: \.seq) { m in
            VStack(alignment: .leading) { Text(m.role).font(.caption).foregroundColor(.secondary); Text(m.content) }
                .accessibilityElement(children: .combine)
        }.navigationTitle(chat.title)
    }
}
struct SyncMeetingView: View {
    let meeting: SyncMeeting
    var body: some View {
        List {
            Section("Meeting") { Text(meeting.title); Text(meeting.date); if !meeting.participants.isEmpty { Text(meeting.participants.joined(separator: ", ")) } }
            Section("Notes") { ForEach(Array(meeting.notes.enumerated()), id: \.offset) { _, n in VStack(alignment: .leading) { Text(n.kind).font(.caption).foregroundColor(.secondary); Text(n.text) } } }
        }.navigationTitle(meeting.title)
    }
}
struct SyncPlanView: View {
    let plan: SyncPlan
    var body: some View {
        List {
            if !plan.goal.isEmpty { Section("Goal") { Text(plan.goal) } }
            Section("Tasks") { ForEach(Array(plan.tasks.enumerated()), id: \.offset) { _, t in VStack(alignment: .leading) { Text(t.title); Text("\(t.status) · \(t.owner)").font(.caption).foregroundColor(.secondary) } } }
        }.navigationTitle(plan.title)
    }
}
