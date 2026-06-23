import SwiftUI

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
    @Environment(AppEnvironment.self) private var env

    /// Persisted per-section like `SettingsSectionCard`, so it survives launches.
    @AppStorage("settings.section.Connections.expanded") private var isExpanded = false

    @State private var showingEmailSheet = false
    @State private var fetching = false
    /// Short human-readable line shown under the Email card after a fetch.
    @State private var lastEmailResult: String?
    /// True when `lastEmailResult` describes an error (drives the colour).
    @State private var lastEmailWasError = false
    /// Meetings "Advanced" (poll interval) disclosure, collapsed by default.
    @State private var showMeetingAdvanced = false
    /// Handle for a manual "Fetch now" import so we can cancel it if the view
    /// disappears mid-import (the `.task` auto-fetch already auto-cancels).
    @State private var importTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            header
            if isExpanded {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    SettingsHint("Connect the sources that feed your Library.")
                    meetingsCard
                    emailCard

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
                }
                // Light auto-fetch when the section is opened (no global timer).
                // Only runs when a source is configured + enabled. `.task`
                // auto-cancels when the view disappears.
                .task {
                    if config.emailSource?.enabled == true { await runImport() }
                }
                .onDisappear { importTask?.cancel() }
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

    // MARK: - Email add-on

    private var emailCard: some View {
        let configured = config.emailSource != nil
        let enabled = config.emailSource?.enabled == true
        return InputSourceCard(
            icon: "envelope",
            title: "Email",
            subtitle: "Fetch messages and turn them into notes",
            badgeText: !configured ? "Not set up" : (enabled ? "Connected" : "Paused"),
            badgeTone: !configured ? .accent : (enabled ? .positive : .neutral)
        ) {
            if let s = config.emailSource {
                Text(s.user.isEmpty ? (s.displayName.isEmpty ? "Configured" : s.displayName) : s.user)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
            }

            HStack(spacing: Spacing.sm) {
                Button(configured ? "Edit…" : "Configure…") {
                    showingEmailSheet = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                if enabled {
                    Button(fetching ? "Fetching…" : "Fetch now") {
                        importTask = Task { await runImport() }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(fetching)
                    if fetching {
                        ProgressView().controlSize(.mini).scaleEffect(0.8)
                    }
                }
            }
            .padding(.top, Spacing.xs)

            if let line = lastEmailResult {
                Text(line)
                    .font(Typography.caption)
                    .foregroundStyle(lastEmailWasError ? theme.current.danger : theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Helpers

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
}
