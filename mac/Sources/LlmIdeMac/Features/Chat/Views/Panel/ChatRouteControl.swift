import SwiftUI

/// The session router's small per-chat control (K1 Phase 6b, docs/spec/session-router.md section 9):
/// the chat's pinned provider and model, its billable-token limit, a meter, the cold-switch warning, a
/// one-click raise at the limit, and the chat's switch history. One chip in the chat header; everything
/// else lives in its popover. Drawn only when the router is on and the chat runs on the Agent engine.
struct ChatRouteControl: View {
    let engine: ChatEngine
    let api: LlmIdeAPIClient
    /// Claude model ids offered for pinning (the composer's own Claude list).
    let claudeModels: [String]

    @EnvironmentObject var theme: ThemeStore
    @State private var open = false
    @State private var limitText = ""
    @State private var choices: [Choice] = []
    @State private var loadingChoices = false

    struct Choice: Identifiable, Hashable {
        let provider: String
        let model: String
        let group: String
        var id: String { "\(provider)|\(model)" }
    }

    private var route: ChatRouteModel { engine.route }

    static func isOffered(engine: ChatEngine) -> Bool {
        ChatRouteLogic.isOffered(
            routerPref: engine.route.routerPref,
            serverEnabled: engine.route.server?.enabled,
            chatRunsOnAgentEngine: engine.usesAgentV2Engine)
    }

    private var tint: Color {
        switch route.level {
        case .reached: return theme.current.danger
        case .warn: return theme.current.warning
        default: return theme.current.textMuted
        }
    }

    var body: some View {
        Button {
            limitText = route.tokenLimit.map { String($0) } ?? ""
            open.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 10, weight: .medium))
                Text(route.pinnedLabel ?? "Route").font(.system(size: 10)).lineLimit(1).truncationMode(.middle)
                if route.tokenLimit != nil || route.billableUsed > 0 {
                    Text(route.meter).font(.system(size: 10, design: .monospaced)).lineLimit(1)
                }
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(route.level == .none || route.level == .ok ? 0.08 : 0.14)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("This chat's model and token limit")
        .accessibilityLabel("This chat's model and token limit")
        .popover(isPresented: $open, arrowEdge: .top) { popover }
    }

    // MARK: - Popover

    private var popover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("This chat's model").font(.system(size: 11, weight: .semibold))
            modelPicker
            Text(ChatRouteLogic.coldSwitchWarning(estimatedTokens: estimatedPrefill))
                .font(.system(size: 10)).foregroundStyle(theme.current.textMuted)
            if let pending = route.pendingLabel {
                Text("Applies to your next message: \(pending)")
                    .font(.system(size: 10)).foregroundStyle(theme.current.warning)
            }
            Divider()
            Text("Token limit").font(.system(size: 11, weight: .semibold))
            limitRow
            meterBlock
            if route.atCap {
                Button("Raise the limit") { Task { await route.raiseLimit() } }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    .help("Raises the limit by half again (at least 50k above what is used)")
            }
            if let error = route.errorText {
                Text(error).font(.system(size: 10)).foregroundStyle(theme.current.danger)
            }
            historyBlock
        }
        .padding(12)
        .frame(width: 330)
        .task { await loadChoices(); await route.loadHistory() }
    }

    private var estimatedPrefill: Int {
        let ctx = engine.lastContextUsage?.totalTokens ?? 0
        return ctx > 0 ? min(ctx, 1_500) : 1_500
    }

    private var modelPicker: some View {
        let selection = Binding<String>(
            get: {
                guard let s = route.settings, s.isPinned else { return "" }
                return "\(s.provider ?? "")|\(s.model ?? "")"
            },
            set: { new in
                if new.isEmpty { Task { await route.pin(provider: nil, model: nil) }; return }
                if let c = choices.first(where: { $0.id == new }) {
                    Task { await route.pin(provider: c.provider, model: c.model) }
                }
            })
        return Picker("", selection: selection) {
            Text("Not pinned (the composer's model)").tag("")
            ForEach(groups, id: \.0) { group, items in
                Section(group) { ForEach(items) { Text($0.model).tag($0.id) } }
            }
        }
        .labelsHidden()
        .disabled(loadingChoices && choices.isEmpty)
    }

    private var groups: [(String, [Choice])] {
        var order: [String] = []
        var map: [String: [Choice]] = [:]
        for c in choices { if map[c.group] == nil { order.append(c.group) }; map[c.group, default: []].append(c) }
        // A pinned model that is not in the lists (a retired id) must still be selectable as shown.
        if let s = route.settings, s.isPinned, let p = s.provider, let m = s.model, !choices.contains(where: { $0.id == "\(p)|\(m)" }) {
            order.append("Current"); map["Current"] = [Choice(provider: p, model: m, group: "Current")]
        }
        return order.map { ($0, map[$0] ?? []) }
    }

    private var limitRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                TextField("none, 200k, 1.5m", text: $limitText)
                    .textFieldStyle(.roundedBorder).font(.system(size: 11, design: .monospaced))
                    .onSubmit(applyLimit)
                Button("Set", action: applyLimit).controlSize(.small)
            }
            HStack(spacing: 6) {
                ForEach(ChatRouteLogic.presets, id: \.self) { p in
                    Button(ChatRouteLogic.compact(p)) { limitText = String(p); applyLimit() }.controlSize(.small)
                }
                Button("None") { limitText = ""; applyLimit() }.controlSize(.small)
            }
        }
    }

    private func applyLimit() {
        guard let parsed = ChatRouteLogic.parseLimit(limitText) else {
            route.errorText = "Enter a whole number of tokens, such as 200k, or none."
            return
        }
        Task { await route.setLimit(parsed) }
    }

    private var meterBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(route.meter).font(.system(size: 11, design: .monospaced)).foregroundStyle(tint)
            Text("Counted: input + output + cache writes. Cached reads are shown, not counted. \(ChatRouteLogic.approximationNote)")
                .font(.system(size: 10)).foregroundStyle(theme.current.textMuted)
            if route.tokenLimit != nil, !route.capEnforced {
                Text("The limit is saved but not enforced: the server runs without the cap switch.")
                    .font(.system(size: 10)).foregroundStyle(theme.current.warning)
            }
        }
    }

    @ViewBuilder private var historyBlock: some View {
        if !route.history.isEmpty || route.historyDegraded {
            Divider()
            Text("Switch history").font(.system(size: 11, weight: .semibold))
            if route.historyDegraded {
                Text("History is unavailable right now. Routing is not affected.")
                    .font(.system(size: 10)).foregroundStyle(theme.current.textMuted)
            }
            ForEach(route.history.prefix(8)) { e in
                Text(Self.line(e)).font(.system(size: 10)).foregroundStyle(theme.current.textMuted).lineLimit(2)
            }
        }
    }

    /// One history row in words. Public to the module so the lab can pin the wording.
    static func line(_ e: LlmIdeAPIClient.ChatRouteEvent) -> String {
        let when = e.at.prefix(16).replacingOccurrences(of: "T", with: " ")
        switch e.kind {
        case "switch": return "\(when)  \(e.fromModel ?? "start") to \(e.toModel ?? "?") (\(e.reason ?? "user"))"
        case "cap_reached": return "\(when)  reached the token limit"
        case "cap_changed": return "\(when)  token limit changed"
        case "handoff_built": return "\(when)  handoff note built (\(e.handoffChars ?? 0) characters)"
        default: return "\(when)  \(e.kind)"
        }
    }

    // MARK: - Choices

    private func loadChoices() async {
        var out: [Choice] = claudeModels.map { Choice(provider: "anthropic", model: $0, group: "Claude") }
        loadingChoices = true
        defer { loadingChoices = false }
        if let catalog = try? await api.fetchProviderCatalog() {
            for provider in catalog.providers {
                for connection in provider.connections where connection.enabled {
                    if let list = try? await api.fetchCatalogModels(id: connection.id) {
                        out += list.models.prefix(60).map { Choice(provider: connection.provider, model: $0.id, group: connection.name) }
                    }
                }
            }
        }
        choices = out
    }
}
