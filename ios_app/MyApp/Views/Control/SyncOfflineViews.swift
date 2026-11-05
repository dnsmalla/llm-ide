import SwiftUI
import SharedProtocol

/// The History tab when the desktop is not reachable: the verified snapshot and the prompt queue.
struct SyncOfflineSections: View {
    @EnvironmentObject var syncStore: SyncStore
    @State private var draft = ""

    var body: some View {
        if let snap = syncStore.snapshot {
            Section {
                Text(freshness(snap)).font(.footnote).foregroundColor(.secondary)
                if syncStore.phase == .removed { Text("This iPhone was removed from sync.").foregroundColor(.red) }
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
            Section { Text(syncStore.refreshing ? "Loading…" : "No snapshot yet. Turn sync on in Settings.").foregroundColor(.secondary) }
        }
        if syncStore.phase == .ready {
            Section("Ask the desktop") {
                TextField("Prompt", text: $draft, axis: .vertical).lineLimit(2...5)
                Button("Queue") { let t = draft; draft = ""; Task { await syncStore.send(t) } }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        if !syncStore.queued.isEmpty {
            Section("Queued prompts") {
                ForEach(syncStore.queued) { q in
                    VStack(alignment: .leading) {
                        Text(q.text)
                        if let a = q.answer { Text(a).font(.footnote).foregroundColor(.secondary) }
                        else if let c = q.code { Text(SyncStore.replyText(c)).font(.footnote).foregroundColor(.secondary) }
                    }
                }
            }
        }
    }
    private func freshness(_ s: SyncSnapshot) -> String {
        switch SyncFreshness(s.manifest, nowMs: Int(Date().timeIntervalSince1970 * 1000)) {
        case .current(let t): return "Desktop last seen \(Date(timeIntervalSince1970: Double(t) / 1000).formatted())"
        case .withheld(let t): return "Desktop offline or storage withholding updates. Last seen \(Date(timeIntervalSince1970: Double(t) / 1000).formatted())"
        }
    }
}

struct SyncQueuedRow: View {
    let q: SyncStore.Queued
    var body: some View { Text(q.answer ?? q.code.map(SyncStore.replyText) ?? q.text) }
}

struct SyncSettingsCard: View {
    @EnvironmentObject var syncStore: SyncStore
    var body: some View {
        Section("Sync") {
            switch syncStore.phase {
            case .off: Text("Add this iPhone from the desktop: Settings → Add a phone or browser.")
            case .needsPassword: Text("Sign in to MEGA again from the sync enrollment sheet.")
            case .ready: Text("On. \(syncStore.queued.filter(\.isPending).count) prompt(s) waiting.")
            case .removed: Text("This iPhone was removed from sync.").foregroundColor(.red)
            }
            if let e = syncStore.lastError { Text(e).font(.footnote).foregroundColor(.secondary) }
            Button("Refresh now") { Task { await syncStore.refresh() } }.disabled(syncStore.phase != .ready)
            Button("Remove sync from this iPhone", role: .destructive) { Task { await syncStore.removeFromPhone() } }
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
