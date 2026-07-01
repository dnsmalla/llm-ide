import SwiftUI

/// "Model & Limits" — a Claude-style usage control surface on the Auto Tasks
/// page. The default view mirrors Claude's Settings → Usage: one clean row per
/// model (name + "Resets in…" on the left, a progress bar and "X% used" on the
/// right). Each row expands to an inline editor for the cap (limit/unit/window/
/// threshold + enable/reorder). Backed by GET/PUT /kb/usage/limits +
/// GET /kb/usage/summary; the backend is the source of truth, so these caps
/// govern ALL model usage, not just Auto Tasks runs.
struct ModelLimitsPanel: View {
    let api: LlmIdeAPIClient?
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var theme: ThemeStore

    private static let providerOptions: [(id: String, label: String)] = [
        ("anthropic", "Claude"), ("openai", "OpenAI"), ("google", "Gemini"), ("custom", "Custom"),
    ]

    @State private var providerKey: String = "anthropic"
    @State private var limits: [LlmIdeAPIClient.ModelLimit] = []
    @State private var usage: LlmIdeAPIClient.ProviderUsage?
    @State private var rateLimits: LlmIdeAPIClient.RateLimits?
    @State private var loading = false
    @State private var saving = false
    @State private var dirty = false
    @State private var status: (ok: Bool, msg: String)?
    @State private var expanded: Set<String> = []
    @State private var lastUpdated: Date?
    @State private var didInitProvider = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if api == nil {
                centered("Sign in to manage model usage limits.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.xl) {
                        providerPicker
                        autoSwitchBanner
                        usageSection
                        rateLimitSection
                        footerNote
                    }
                    .padding(.horizontal, 28)
                    .padding(.vertical, 24)
                    .frame(maxWidth: 820, alignment: .leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 0)
            bottomBar
        }
        .background(theme.current.body)
        .task {
            if !didInitProvider {
                providerKey = (AICliTool(rawValue: config.activeCLI) ?? .claudeCode).provider
                didInitProvider = true
            }
            await load()
            // Live auto-refresh while the panel is on screen. Pauses while the
            // user is mid-edit (dirty) or saving so a poll never clobbers
            // unsaved changes. .task auto-cancels when the view disappears.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { break }
                if !dirty && !saving { await load() }
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "gauge.with.dots.needle.67percent")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(theme.current.accent)
            Text("Model & Limits")
                .font(Typography.title)
                .foregroundStyle(theme.current.text)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(theme.current.surface)
    }

    // MARK: - Provider picker (our multi-provider twist on Claude's plan badge)

    private var providerPicker: some View {
        Picker("", selection: $providerKey) {
            ForEach(Self.providerOptions, id: \.id) { Text($0.label).tag($0.id) }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .frame(maxWidth: 420)
        .onChange(of: providerKey) { _, _ in
            dirty = false; status = nil; expanded = []
            Task { await load() }
        }
    }

    // MARK: - Usage section (Claude-style rows)

    @ViewBuilder
    private var usageSection: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            HStack(spacing: Spacing.sm) {
                Text("Your usage limits")
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                Text(providerLabel)
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(theme.current.surface).clipShape(Capsule())
            }

            if loading && limits.isEmpty {
                ProgressView().controlSize(.small).padding(.vertical, 12)
            } else if limits.isEmpty {
                Text("No models in this provider's chain yet. Add a model in Settings → Model Providers.")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
            } else {
                VStack(spacing: 0) {
                    ForEach(limits.indices, id: \.self) { i in
                        modelRow(index: i)
                        if i < limits.count - 1 { Divider().padding(.vertical, 2) }
                    }
                }
            }
        }
    }

    // One model: the clean Claude-style summary line + an expandable editor.
    @ViewBuilder
    private func modelRow(index i: Int) -> some View {
        let m = limits[i]
        let stat = usage?.models.first { $0.model == m.model }
        let isOpen = expanded.contains(m.model)
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .top, spacing: Spacing.lg) {
                // Left: name + reset subtitle.
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(m.label ?? m.model)
                            .font(Typography.bodyStrong)
                            .foregroundStyle(m.enabled ? theme.current.text : theme.current.textMuted)
                        if !m.enabled { tag("off", theme.current.textMuted) }
                        if m.custom == true { tag("custom", theme.current.accent2) }
                    }
                    Text(resetSubtitle(stat))
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
                .frame(width: 200, alignment: .leading)

                // Middle: the bar.
                meterBar(stat: stat)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 4)

                // Right: "X% used" / consumption + edit toggle.
                HStack(spacing: Spacing.md) {
                    Text(usageTrailing(stat))
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 78, alignment: .trailing)
                    Button {
                        if isOpen { expanded.remove(m.model) } else { expanded.insert(m.model) }
                    } label: {
                        Image(systemName: isOpen ? "chevron.up" : "slider.horizontal.3")
                            .foregroundStyle(theme.current.textMuted)
                    }
                    .buttonStyle(.borderless)
                    .help("Edit limit")
                }
            }
            .contentShape(Rectangle())

            if isOpen { editor(index: i) }
        }
        .padding(.vertical, Spacing.md)
    }

    // MARK: - Meter bar

    @ViewBuilder
    private func meterBar(stat: LlmIdeAPIClient.UsageModelStat?) -> some View {
        let pct = stat?.pct
        let color = stat.map { statColor($0.state) } ?? theme.current.accent
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(theme.current.border.opacity(0.5))
                Capsule().fill(color)
                    .frame(width: max(pct != nil ? 6 : 0,
                                      geo.size.width * CGFloat(min(1.0, (pct ?? 0) / 100.0))))
            }
        }
        .frame(height: 8)
    }

    // MARK: - Inline editor (expanded)

    @ViewBuilder
    private func editor(index i: Int) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.md) {
                Toggle("Enabled", isOn: Binding(
                    get: { limits[i].enabled },
                    set: { limits[i].enabled = $0; dirty = true }
                ))
                .toggleStyle(.checkbox)
                .font(Typography.caption)

                Spacer()

                Button { move(i, by: -1) } label: { Image(systemName: "chevron.up") }
                    .buttonStyle(.borderless).disabled(i == 0).help("Higher priority")
                Button { move(i, by: 1) } label: { Image(systemName: "chevron.down") }
                    .buttonStyle(.borderless).disabled(i == limits.count - 1).help("Lower priority")
            }

            HStack(spacing: Spacing.md) {
                HStack(spacing: 4) {
                    Text("Limit").font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    TextField("0", value: Binding(
                        get: { limits[i].limitValue },
                        set: { limits[i].limitValue = max(0, $0); dirty = true }
                    ), format: .number)
                    .textFieldStyle(.roundedBorder).frame(width: 90)
                }
                Picker("", selection: Binding(
                    get: { limits[i].unit }, set: { limits[i].unit = $0; dirty = true }
                )) { Text("Runs").tag("runs"); Text("Tokens").tag("tokens") }
                    .labelsHidden().pickerStyle(.menu).fixedSize()
                Picker("", selection: Binding(
                    get: { limits[i].windowKind }, set: { limits[i].windowKind = $0; dirty = true }
                )) { Text("Daily").tag("daily"); Text("Monthly").tag("monthly") }
                    .labelsHidden().pickerStyle(.menu).fixedSize()
                HStack(spacing: 4) {
                    Text("Switch at").font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    Stepper("\(limits[i].thresholdPct)%", value: Binding(
                        get: { limits[i].thresholdPct },
                        set: { limits[i].thresholdPct = min(100, max(1, $0)); dirty = true }
                    ), in: 1...100, step: 5).font(Typography.caption)
                }
                Spacer()
            }
            if limits[i].limitValue == 0 {
                Text("No cap — unlimited; the chain won't pause on this model.")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
            }
        }
        .padding(Spacing.md)
        .background(theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }

    // MARK: - Auto-switch banner

    @ViewBuilder
    private var autoSwitchBanner: some View {
        if let active = usage?.active, active.status != "ok" || active.model != nil {
            let color = statusColor(active.status)
            HStack(spacing: Spacing.sm) {
                Image(systemName: bannerIcon(active.status)).foregroundStyle(color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(activeTitle(active)).font(Typography.bodyStrong).foregroundStyle(theme.current.text)
                    if let reason = active.reason, !reason.isEmpty {
                        Text(reason).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    }
                }
                Spacer()
            }
            .padding(Spacing.md)
            .background(color.opacity(0.10))
            .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(color.opacity(0.35), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
        }
    }

    // MARK: - API rate-limit card (Anthropic headers — API-key mode only)

    @ViewBuilder
    private var rateLimitSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Text("API rate limit").font(Typography.title).foregroundStyle(theme.current.text)
                Text(providerLabel).font(Typography.captionStrong).foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(theme.current.surface).clipShape(Capsule())
                Spacer()
                if let cap = rateLimits?.capturedAt {
                    Text("updated \(relativeReset(cap))")
                        .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                }
            }
            if let rl = rateLimits {
                VStack(spacing: Spacing.sm) {
                    rateRow("Requests", rl.requests)
                    rateRow("Tokens", rl.tokens)
                }
                .padding(Spacing.md)
                .background(theme.current.surface)
                .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(theme.current.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
            } else {
                Text("No API rate-limit data yet — it appears after an API-key call to this provider. Not available in subscription / CLI mode (providers expose no API for subscription usage).")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func rateRow(_ label: String, _ bucket: LlmIdeAPIClient.RateLimitBucket?) -> some View {
        let limit = bucket?.limit ?? 0
        let remaining = bucket?.remaining ?? 0
        // Fraction of the window still available; color by remaining headroom.
        let frac = limit > 0 ? max(0, min(1, remaining / limit)) : 0
        let color: Color = frac > 0.5 ? theme.current.accent3 : (frac > 0.15 ? theme.current.accent4 : theme.current.danger)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(Typography.caption).foregroundStyle(theme.current.text)
                Spacer()
                Text(limit > 0 ? "\(Int(remaining)) / \(Int(limit)) left" : "—")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                if let reset = bucket?.reset {
                    Text("· resets \(relativeReset(reset))")
                        .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.current.border.opacity(0.5))
                    Capsule().fill(color).frame(width: geo.size.width * CGFloat(frac))
                }
            }
            .frame(height: 6)
        }
    }

    // MARK: - Footer + bottom bar

    private var footerNote: some View {
        Label("When all models are exhausted: Pause until reset.", systemImage: "pause.circle")
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
    }

    private var bottomBar: some View {
        HStack(spacing: Spacing.sm) {
            if let s = status {
                Text(s.msg).font(Typography.caption)
                    .foregroundStyle(s.ok ? theme.current.accent3 : theme.current.danger)
            } else if api != nil {
                Text("Last updated: \(lastUpdated.map(relative) ?? "—")")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).disabled(loading).help("Refresh usage")
            }
            Spacer()
            Button(saving ? "Saving…" : "Save") { Task { await save() } }
                .buttonStyle(.borderedProminent)
                .disabled(saving || !dirty || api == nil)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 10)
        .background(theme.current.surface)
    }

    // MARK: - Formatting helpers

    private var providerLabel: String {
        Self.providerOptions.first { $0.id == providerKey }?.label ?? providerKey
    }

    private func resetSubtitle(_ stat: LlmIdeAPIClient.UsageModelStat?) -> String {
        guard let stat else { return " " }
        let window = stat.windowKind == "monthly" ? "Monthly" : "Daily"
        if let r = stat.resetAt { return "\(window) · resets \(relativeReset(r))" }
        return window
    }

    private func usageTrailing(_ stat: LlmIdeAPIClient.UsageModelStat?) -> String {
        guard let stat else { return "—" }
        if let pct = stat.pct { return "\(Int(pct))% used" }
        return "\(Int(stat.used)) \(stat.unit)"   // uncapped: show raw consumption
    }

    private func activeTitle(_ a: LlmIdeAPIClient.UsageResolution) -> String {
        switch a.status {
        case "paused": return "Paused — all models at their limit"
        case "unconfigured": return "No fallback chain configured"
        default:
            let name = limits.first { $0.model == a.model }?.label ?? a.model ?? "—"
            return "Active model: \(name)"
        }
    }

    private func centered(_ text: String) -> some View {
        VStack { Spacer(); Text(text).font(Typography.body).foregroundStyle(theme.current.textMuted); Spacer() }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tag(_ text: String, _ color: Color) -> some View {
        Text(text).font(Typography.captionStrong).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.12)).clipShape(Capsule())
    }

    private func statColor(_ state: String) -> Color {
        switch state {
        case "exhausted": return theme.current.danger
        case "warning":   return theme.current.accent4
        default:          return theme.current.accent
        }
    }
    private func statusColor(_ status: String) -> Color {
        switch status {
        case "paused": return theme.current.danger
        case "degraded": return theme.current.accent4
        case "unconfigured": return theme.current.textMuted
        default: return theme.current.accent3
        }
    }
    private func bannerIcon(_ status: String) -> String {
        switch status {
        case "paused": return "pause.circle.fill"
        case "degraded": return "exclamationmark.triangle.fill"
        case "unconfigured": return "questionmark.circle"
        default: return "checkmark.circle.fill"
        }
    }

    private func move(_ i: Int, by delta: Int) {
        let j = i + delta
        guard limits.indices.contains(i), limits.indices.contains(j) else { return }
        limits.swapAt(i, j); dirty = true
    }

    private func relative(_ date: Date) -> String {
        let rel = RelativeDateTimeFormatter(); rel.unitsStyle = .full
        return rel.localizedString(for: date, relativeTo: Date())
    }
    private func relativeReset(_ iso: String) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "soon" }
        let rel = RelativeDateTimeFormatter(); rel.unitsStyle = .short
        return rel.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Data

    private func load() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            async let limitsResp = api.usageLimits(provider: providerKey)
            async let summaryResp = api.usageSummary(provider: providerKey)
            async let rateResp = api.usageRateLimits(provider: providerKey)
            let (l, s, rl) = try await (limitsResp, summaryResp, rateResp)
            limits = l.chains[providerKey] ?? []
            usage = s.providers[providerKey]
            rateLimits = rl
            lastUpdated = Date()
            dirty = false
            status = nil
        } catch {
            status = (false, "Couldn't load usage: \(error.localizedDescription)")
        }
    }

    private func save() async {
        guard let api else { return }
        saving = true
        defer { saving = false }
        let ordered = limits.enumerated().map { idx, m -> LlmIdeAPIClient.ModelLimit in
            var copy = m; copy.priority = idx; return copy
        }
        do {
            let updated = try await api.saveUsageLimits([providerKey: ordered])
            limits = updated.chains[providerKey] ?? ordered
            dirty = false
            status = (true, "Saved ✓")
            if let s = try? await api.usageSummary(provider: providerKey) {
                usage = s.providers[providerKey]
                lastUpdated = Date()
            }
        } catch {
            status = (false, "Save failed: \(error.localizedDescription)")
        }
    }
}
