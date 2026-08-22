import SwiftUI

/// Pure visibility rule for `ConnectionsSettingsSection`, split out so it is
/// unit-testable without a view.
///
/// Meetings and Email are **fixed defaults** — they are not catalog
/// connectors, are never selectable, and can never be hidden (hard spec
/// constraint, `docs/superpowers/specs/2026-08-22-connector-catalog-design.md`).
/// Everything else appears only while the user has it selected, in catalog
/// order. Ids the catalog no longer knows are dropped.
enum ConnectionsSelection {
    /// Always shown, always first, never selection-driven.
    static let fixedOrder = ["meetings", "email"]
    /// Catalog connectors, in the catalog's own order.
    static let catalogOrder = ["gdrive", "gcal", "miro", "box", "slack"]
    /// Cards that have a bespoke, hand-written card in the section; every
    /// other visible id renders through the generic placeholder card.
    static let bespokeCardIds: Set<String> = ["meetings", "email", "box", "slack"]

    static func visibleCardIds(selected: Set<String>) -> [String] {
        fixedOrder + catalogOrder.filter { selected.contains($0) }
    }
}

/// Settings → **Connections**: the inputs hub. Connect the sources that feed
/// the Library — Meetings (auto-capture) and Email — plus planned sources
/// shown as "coming soon". This is the only place input capture is
/// *configured*.
///
/// It used to be a standalone activity-bar section ("Sources"), but that
/// collided with the Library's own "Sources" section (the files those inputs
/// produce). It now lives here and is reachable directly or via the
/// "Connect a source…" deep-link in the Library's Sources section
/// (`.scrollSettingsToCard` with anchor "connections").
///
/// Unlike most settings sections this does NOT wrap its body in
/// `SettingsSectionCard` — that would card-wrap the content, and the input
/// rows are already `InputSourceCard`s. We use a matching collapsible header
/// but let those cards be the surfaces, avoiding a card-in-card look.
struct ConnectionsSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var sourceLinks: SourceLinkStore
    @Environment(AppEnvironment.self) private var env

    /// Persisted per-section like `SettingsSectionCard`, so it survives launches.
    @AppStorage("settings.section.Connections.expanded") private var isExpanded = false

    @State private var showingEmailSheet = false
    @State private var showSlackSheet = false
    @State private var showBoxSheet = false
    @State private var fetching = false
    /// Short human-readable line shown under the Email card after a fetch.
    @State private var lastEmailResult: String?
    /// True when `lastEmailResult` describes an error (drives the colour).
    @State private var lastEmailWasError = false
    /// Short human-readable line shown under the Slack card after a fetch.
    @State private var lastSlackResult: String?
    /// True when `lastSlackResult` describes an error (drives the colour).
    @State private var lastSlackWasError = false
    @State private var fetchingSlack = false
    /// Short human-readable line shown under the Box card after a re-sync.
    @State private var lastBoxResult: String?
    /// True when `lastBoxResult` describes an error (drives the colour).
    @State private var lastBoxWasError = false
    @State private var syncingBox = false
    /// Meetings "Advanced" (poll interval) disclosure, collapsed by default.
    @State private var showMeetingAdvanced = false
    /// Handle for a manual "Fetch now" import so we can cancel it if the view
    /// disappears mid-import (the `.task` auto-fetch already auto-cancels).
    @State private var importTask: Task<Void, Never>?
    @State private var slackImportTask: Task<Void, Never>?
    @State private var boxSyncTask: Task<Void, Never>?
    /// Catalog connectors this user has selected in the Library. Drives which
    /// connector cards this section shows (Meetings/Email are never gated).
    @State private var selectedConnectorIds: Set<String> = []
    /// Only true once the selection has actually been read from the server.
    /// While false the section renders exactly as it did before the catalog
    /// existed (Slack + Box visible), so a failed request can never hide a
    /// connector the user has already configured.
    @State private var connectorsLoaded = false
    /// Catalog metadata (name/description/icon) for the placeholder cards.
    @State private var catalogEntries: [ConnectorCatalogEntry] = []

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            header
            if isExpanded {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    SettingsHint("Connect the sources that feed your Library.")
                    // Meetings and Email are fixed defaults — never gated.
                    meetingsCard
                    emailCard
                    // Slack and Box are pre-selected server-side; the
                    // `!connectorsLoaded` guard inside `showsConnectorCard`
                    // keeps configured connectors visible even if the
                    // selection request fails.
                    if showsConnectorCard("slack") { slackCard }
                    if showsConnectorCard("box") { boxCard }
                    ForEach(pendingConnectorIds, id: \.self) { id in
                        if let entry = connectorEntry(id) {
                            pendingPipelineCard(entry)
                        }
                    }

                    Text("More inputs")
                        .font(Typography.section)
                        .foregroundStyle(theme.current.textMuted)
                        .padding(.top, Spacing.xs)

                    ForEach(InputSourceRegistry.planned) { src in
                        InputSourceCard(icon: src.icon, title: src.title,
                                        subtitle: src.subtitle,
                                        badgeText: "Coming soon", badgeTone: .neutral,
                                        isAvailable: false)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
                .sheet(isPresented: $showingEmailSheet) {
                    EmailSourceSheet(api: api)
                        .environmentObject(theme)
                        .environmentObject(config)
                        .environmentObject(sourceLinks)
                }
                .sheet(isPresented: $showSlackSheet) {
                    SlackSourceSheet(api: api)
                        .environmentObject(theme)
                        .environmentObject(config)
                        .environmentObject(sourceLinks)
                }
                .sheet(isPresented: $showBoxSheet) {
                    BoxSourceSheet(api: api)
                        .environmentObject(theme)
                        .environmentObject(config)
                }
                // Light auto-fetch when the section is opened (no global timer).
                // Only runs when a source is configured + enabled. `.task`
                // auto-cancels when the view disappears.
                .task {
                    await sourceLinks.refresh(api: api)
                    await loadConnectorSelection()
                    if config.emailSource?.enabled == true { await runImport() }
                    if config.slackSource?.enabled == true { await runSlackImport() }
                }
                .onDisappear {
                    importTask?.cancel()
                    slackImportTask?.cancel()
                    boxSyncTask?.cancel()
                }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isExpanded)
        // Deep-link from the Library Sources section lands here expanded.
        .onReceive(NotificationCenter.default.publisher(for: .scrollSettingsToCard)) { note in
            if note.object as? String == "connections" { isExpanded = true }
        }
    }

    private var header: some View {
        Button { isExpanded.toggle() } label: {
            HStack(spacing: Spacing.sm) {
                Image(systemName: "tray.and.arrow.down")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.accent2)
                SectionLabel("Connections", size: 12)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Collapse Connections" : "Expand Connections")
    }

    // MARK: - Meetings add-on

    /// The single home for meeting capture config: the auto-capture toggle
    /// plus the poll interval. Drives `config.autoCaptureOnMeeting` /
    /// `pollIntervalMs` — the same properties the capture runtime reads.
    private var meetingsCard: some View {
        InputSourceCard(
            icon: "waveform",
            title: "Meetings",
            subtitle: "Google Meet · Teams · Zoom",
            badgeText: config.autoCaptureOnMeeting ? "On" : "Off",
            badgeTone: config.autoCaptureOnMeeting ? .positive : .neutral
        ) {
            Toggle(isOn: $config.autoCaptureOnMeeting) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-capture when a meeting app is frontmost")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.text)
                    Text("Starts recording automatically once Zoom or Teams becomes the active app.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .toggleStyle(.switch)

            DisclosureGroup(isExpanded: $showMeetingAdvanced) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Poll interval")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("\(config.pollIntervalMs) ms — how often the scraper reads each meeting app's caption panel. Applies on next launch.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Stepper("\(config.pollIntervalMs)",
                            value: $config.pollIntervalMs,
                            in: 100...2000, step: 50)
                        .labelsHidden()
                        .controlSize(.small)
                }
                .padding(.top, Spacing.xs)
            } label: {
                Text("Advanced")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            .padding(.top, Spacing.xs)
        }
    }

    // MARK: - Email / Slack / Box add-ons
    //
    // The three cards below are identical apart from labels and which state
    // vars back busy/result — factored into sourceCardBody so a fix to the
    // shared shape (button layout, spinner placement, result-line styling)
    // can't land in one card and miss the other two.

    private var emailCard: some View {
        let configured = config.emailSource != nil
        let enabled = config.emailSource?.enabled == true
        let badge = linkBadge(.email, configured: configured, enabled: enabled)
        let subtitle = config.emailSource.map { s in
            s.user.isEmpty ? (s.displayName.isEmpty ? "Configured" : s.displayName) : s.user
        }
        return InputSourceCard(
            icon: "envelope",
            title: "Email",
            subtitle: "Fetch messages and turn them into notes",
            badgeText: badge.text,
            badgeTone: badge.tone
        ) {
            sourceCardBody(
                subtitle: subtitle, configured: configured, enabled: enabled,
                onConfigure: { showingEmailSheet = true },
                secondaryLabel: "Fetch now", secondaryBusyLabel: "Fetching…", busy: fetching,
                onSecondaryAction: { importTask = Task { await runImport() } },
                resultLine: lastEmailResult, resultIsError: lastEmailWasError
            )
        }
    }

    private var slackCard: some View {
        let configured = config.slackSource != nil
        let enabled = config.slackSource?.enabled == true
        let badge = linkBadge(.slack, configured: configured, enabled: enabled)
        let subtitle = config.slackSource.map { s in s.displayName.isEmpty ? "Configured" : s.displayName }
        return InputSourceCard(
            icon: "number",
            title: "Slack",
            subtitle: "Fetch messages and turn them into notes",
            badgeText: badge.text,
            badgeTone: badge.tone
        ) {
            sourceCardBody(
                subtitle: subtitle, configured: configured, enabled: enabled,
                onConfigure: { showSlackSheet = true },
                secondaryLabel: "Fetch now", secondaryBusyLabel: "Fetching…", busy: fetchingSlack,
                onSecondaryAction: { slackImportTask = Task { await runSlackImport() } },
                resultLine: lastSlackResult, resultIsError: lastSlackWasError
            )
        }
    }

    private var boxCard: some View {
        let configured = config.boxSource != nil
        let enabled = config.boxSource?.enabled == true
        let badge = linkBadge(.box, configured: configured, enabled: enabled)
        let subtitle = config.boxSource.map { s in
            s.displayName.isEmpty ? (s.folderName.isEmpty ? "Configured" : s.folderName) : s.displayName
        }
        return InputSourceCard(
            icon: "doc.text",
            title: "Box",
            subtitle: "Index documents from a Box folder",
            badgeText: badge.text,
            badgeTone: badge.tone
        ) {
            sourceCardBody(
                subtitle: subtitle, configured: configured, enabled: enabled,
                onConfigure: { showBoxSheet = true },
                secondaryLabel: "Re-sync", secondaryBusyLabel: "Syncing…", busy: syncingBox,
                onSecondaryAction: { boxSyncTask = Task { await runBoxSync() } },
                resultLine: lastBoxResult, resultIsError: lastBoxWasError
            )
        }
    }

    /// Shared body for the three cards above: an optional subtitle line, a
    /// Configure/Edit button, an optional secondary action (Fetch now /
    /// Re-sync) shown once enabled, and an optional result line.
    @ViewBuilder
    private func sourceCardBody(
        subtitle: String?,
        configured: Bool,
        enabled: Bool,
        onConfigure: @escaping () -> Void,
        secondaryLabel: String,
        secondaryBusyLabel: String,
        busy: Bool,
        onSecondaryAction: @escaping () -> Void,
        resultLine: String?,
        resultIsError: Bool
    ) -> some View {
        if let subtitle {
            Text(subtitle)
                .font(Typography.body)
                .foregroundStyle(theme.current.text)
        }

        HStack(spacing: Spacing.sm) {
            Button(configured ? "Edit…" : "Configure…", action: onConfigure)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

            if enabled {
                Button(busy ? secondaryBusyLabel : secondaryLabel, action: onSecondaryAction)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(busy)
                if busy {
                    ProgressView().controlSize(.mini).scaleEffect(0.8)
                }
            }
        }
        .padding(.top, Spacing.xs)

        if let line = resultLine {
            Text(line)
                .font(Typography.caption)
                .foregroundStyle(resultIsError ? theme.current.danger : theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Connector selection

    /// Read this user's connector selection (plus catalog metadata for the
    /// placeholder cards). `connectorsLoaded` only flips on a successful read
    /// so a network failure leaves the pre-catalog rendering in place.
    private func loadConnectorSelection() async {
        guard let list = try? await api.listConnectors() else { return }
        selectedConnectorIds = Set(list.map(\.id))
        connectorsLoaded = true
        if let catalog = try? await api.fetchConnectorCatalog() {
            catalogEntries = catalog
        }
    }

    /// Whether the card for a catalog connector should render.
    private func showsConnectorCard(_ id: String) -> Bool {
        guard connectorsLoaded else { return true }
        return ConnectionsSelection.visibleCardIds(selected: selectedConnectorIds).contains(id)
    }

    /// Selected connectors without a bespoke card — rendered as placeholders.
    private var pendingConnectorIds: [String] {
        guard connectorsLoaded else { return [] }
        return ConnectionsSelection.visibleCardIds(selected: selectedConnectorIds)
            .filter { !ConnectionsSelection.bespokeCardIds.contains($0) }
    }

    private func connectorEntry(_ id: String) -> ConnectorCatalogEntry? {
        catalogEntries.first { $0.id == id }
    }

    /// Placeholder card for a selected connector whose fetch pipeline lands in
    /// a later phase — visible so the selection is real, honest that nothing
    /// fetches yet.
    private func pendingPipelineCard(_ entry: ConnectorCatalogEntry) -> some View {
        InputSourceCard(
            icon: entry.icon,
            title: entry.name,
            subtitle: entry.description,
            badgeText: "Coming soon",
            badgeTone: .neutral,
            isAvailable: false
        ) {
            Text("Pipeline lands in an upcoming update — your selection is saved.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Helpers

    /// Vault-aware card badge: reflects whether the source's secret is in the
    /// vault, not just whether local config exists.
    private func linkBadge(_ kind: SourceLinkStore.SourceKind, configured: Bool, enabled: Bool) -> (text: String, tone: SourceBadgeTone) {
        if sourceLinks.lastRefreshFailed { return ("—", .neutral) }
        switch sourceLinks.linkState(kind, configured: configured) {
        case .notConfigured:     return ("Not set up", .accent)
        case .credentialsNeeded: return ("Credentials needed", .accent)
        case .linked:            return enabled ? ("Connected ✓", .positive) : ("Paused", .neutral)
        }
    }

    /// Run the email import flow and reflect the outcome on the card.
    private func runImport() async {
        guard !fetching else { return }
        fetching = true
        defer { fetching = false }

        let service = SourceIngestService(
            api: api,
            config: config,
            root: env.notesConfig.currentFolder,
            notesOutputFolder: env.notesOutputFolder,
            indexer: env.indexer)
        switch await service.importNewEmails() {
        case .imported(let n, let moreAvailable, let oversize):
            lastEmailWasError = false
            lastEmailResult = "Imported \(n) new email\(n == 1 ? "" : "s")."
                + (moreAvailable > 0 ? " \(moreAvailable) more pending — Fetch again to continue." : "")
                + (oversize > 0 ? " \(oversize) skipped (too large)." : "")
        case .none:
            lastEmailWasError = false
            lastEmailResult = "No new emails."
        case .noSource:
            lastEmailWasError = false
            lastEmailResult = nil
        case .failure(let msg, _):
            lastEmailWasError = true
            lastEmailResult = "Fetch failed: \(msg)"
        }
    }

    /// Run the Slack import flow and reflect the outcome on the card.
    private func runSlackImport() async {
        guard !fetchingSlack else { return }
        fetchingSlack = true
        defer { fetchingSlack = false }

        let service = SourceIngestService(
            api: api,
            config: config,
            root: env.notesConfig.currentFolder,
            notesOutputFolder: env.notesOutputFolder,
            indexer: env.indexer)
        switch await service.importSource(id: "slack") {
        case .imported(let n, let more, _):
            lastSlackWasError = false
            lastSlackResult = "Imported \(n) Slack message\(n == 1 ? "" : "s")."
                + (more > 0 ? " \(more) more pending — Fetch again." : "")
        case .none:
            lastSlackWasError = false
            lastSlackResult = "No new messages."
        case .noSource:
            lastSlackWasError = false
            lastSlackResult = nil
        case .failure(let msg, _):
            lastSlackWasError = true
            lastSlackResult = "Fetch failed: \(msg)"
        }
    }

    /// Run a wholesale Box re-index and reflect the outcome on the card.
    private func runBoxSync() async {
        guard !syncingBox, let s = config.boxSource else { return }
        syncingBox = true
        defer { syncingBox = false }
        do {
            let r = try await api.connectBox(clientId: s.clientId, subjectType: s.subjectType, subjectId: s.subjectId, folderId: s.folderId)
            lastBoxWasError = false
            // `indexed` is chunk-rows; `files` is the document count. Report
            // documents (falling back to the chunk count for older servers)
            // and flag when a cap truncated the walk.
            let fileCount = r.files ?? r.indexed
            lastBoxResult = "Indexed \(fileCount) document\(fileCount == 1 ? "" : "s") (\(r.indexed) chunk\(r.indexed == 1 ? "" : "s"))."
                + (r.skipped > 0 ? " \(r.skipped) skipped." : "")
                + ((r.truncated ?? false) ? " Folder was large — some files were not indexed (cap reached)." : "")
        } catch {
            lastBoxWasError = true
            lastBoxResult = "Sync failed: \(error.localizedDescription)"
        }
    }
}
