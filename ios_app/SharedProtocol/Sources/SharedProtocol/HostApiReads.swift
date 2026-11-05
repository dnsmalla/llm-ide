import Foundation

// MARK: - Host API v1 `read` (chat.sessions, chat.history, usage.get) on the phone
//
// Read-only. Nothing here sends a write, and opening a chat never changes where `chat.send` goes.
// Behaviour mirrors web/src/read/controller.ts: same pages, caps, stale-reply ticket and in-flight guard.

/// Whether the read screens exist at all. Not optimistic: no capability list means off, and v2 is always off.
public enum HostApiReadGate {
    public static func isOn(apiVersion: Int, capabilities: Set<String>?) -> Bool {
        apiVersion == 1 && capabilities?.contains(HostApiCommand.chatSessions.capability) == true
    }
}

public enum HostApiReadMapping {
    /// `usage.get` → the `UsageState` the existing Usage screen renders. v1 carries no permission mode, no
    /// subscription windows and no limit configuration, so those stay empty rather than guessed.
    public static func usageState(_ r: HostApiUsageGetResult) -> UsageState {
        let prefix = r.providers.count > 1
        let models = r.providers.flatMap { p in
            p.models.map { m -> UsageMeter in
                let name = m.label ?? m.model
                let window = m.window.capitalized
                let detail = m.limit > 0 ? "\(m.used) of \(m.limit) \(m.unit) · \(window)"
                                         : "\(m.used) \(m.unit) · \(window), no cap"
                return UsageMeter(name: prefix ? "\(p.provider) · \(name)" : name, pct: m.pct.map { Double($0) },
                                  state: m.state, detail: detail,
                                  resetsAt: m.resetAt > 0 ? Double(m.resetAt) / 1000 : nil)
            }
        }
        return UsageState(
            provider: r.providers.isEmpty ? nil : r.providers.map(\.provider).joined(separator: ", "),
            status: r.providers.first(where: { $0.status != "ok" })?.status ?? r.providers.first?.status,
            statusReason: nil, activeModel: r.providers.first?.activeModel, models: models,
            subscription: [], subscriptionNote: nil, permissionMode: "", error: nil)
    }
}
