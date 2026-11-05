import SwiftUI
import SharedProtocol

/// The History tab when the desktop is not reachable: the verified snapshot and the prompt queue.
struct SyncOfflineSections: View {
    @EnvironmentObject var syncStore: SyncStore

    var body: some View {
        if let snap = syncStore.snapshot {
            Section {
                Text(freshness(snap)).font(.footnote).foregroundColor(.secondary)
                if syncStore.phase == .removed { Text("This iPhone was removed from sync.").foregroundColor(.red) }
            }
            if !snap.chats.isEmpty {
                Section("Chats") { ForEach(snap.chats) { c in Text(c.title) } }
            }
            if !snap.meetings.isEmpty {
                Section("Meetings") { ForEach(snap.meetings) { m in Text("\(m.title) · \(m.date)") } }
            }
            if !snap.plans.isEmpty {
                Section("Plans") { ForEach(snap.plans) { p in Text(p.title) } }
            }
        } else {
            Section { Text(syncStore.refreshing ? "Loading…" : "No snapshot yet. Turn sync on in Settings.").foregroundColor(.secondary) }
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
