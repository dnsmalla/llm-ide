import SwiftUI

/// Settings card listing incidents the Self-Heal capture layer recorded,
/// with the on/off toggle and per-run cap. Ignore/Retry here only change
/// `Incident.status` — fixing/applying happens in the Self-Heal loop (Phase 2).
struct SelfHealSettingsSection: View {
    @EnvironmentObject private var theme: ThemeStore
    @AppStorage(SelfHealSettings.enabledKey) private var isEnabled = true
    @AppStorage(SelfHealSettings.maxPerRunKey) private var maxPerRun = 5
    private let store = IncidentStore.shared

    var body: some View {
        SettingsSectionCard(icon: "stethoscope", title: "Self-Heal") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Toggle("Record errors and propose fixes", isOn: $isEnabled)
                Stepper("Incidents per scheduled run: \(maxPerRun)", value: $maxPerRun, in: 1...20)
                Text("The Self-Heal loop runs on the Loop schedule, fixes in an isolated worktree, and never changes this checkout until you apply a proposal.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                Divider()
                let recent = store.incidents.sorted { $0.lastSeen > $1.lastSeen }.prefix(50)
                if recent.isEmpty {
                    Text("No incidents recorded.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
                ForEach(Array(recent)) { incident in
                    row(incident)
                }
            }
        }
    }

    private func row(_ incident: Incident) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(incident.source.rawValue) · \(incident.category) · ×\(incident.count) · \(incident.status.rawValue)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(theme.current.textMuted)
                Text(incident.message)
                    .font(.system(size: 11))
                    .lineLimit(2)
                if let note = incident.note {
                    Text(note)
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            Spacer()
            if incident.status == .new || incident.status == .needsHuman {
                Button("Ignore") {
                    store.update(id: incident.id) { $0.status = .ignored; $0.note = "ignored manually" }
                }
                .controlSize(.small)
            }
            if incident.status == .ignored || incident.status == .needsHuman {
                Button("Retry") {
                    store.update(id: incident.id) { $0.status = .new; $0.attempts = 0; $0.note = nil }
                }
                .controlSize(.small)
            }
        }
    }
}
