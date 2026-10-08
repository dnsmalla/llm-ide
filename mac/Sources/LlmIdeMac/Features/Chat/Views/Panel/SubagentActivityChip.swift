import SwiftUI

/// The composer's "N agents" chip, after Claude Code's footer: a grey capsule
/// with a dot — muted "0 agents" when the turn delegated nothing, a spinner and
/// "N running" while subagents work. Click for the popover listing each one
/// with its state, elapsed time and what ran it (provider · model (tier)).
///
/// Reads the CURRENT turn only (the last assistant message), so a new turn
/// starts back at zero rather than carrying the previous turn's count.
struct SubagentActivityChip: View {
    let activity: SubagentActivity
    var compact: Bool = false

    @EnvironmentObject var theme: ThemeStore
    @State private var showPopover = false

    var body: some View {
        Button { showPopover.toggle() } label: { capsule }
            .buttonStyle(.plain)
            .help(helpText)
            .accessibilityLabel(accessibilityText)
            .accessibilityHint("Shows the subagents this turn delegated to")
            .popover(isPresented: $showPopover, arrowEdge: .top) {
                SubagentActivityPopover(activity: activity)
                    .environmentObject(theme)
            }
            .fixedSize()
    }

    private var isRunning: Bool { activity.runningCount > 0 }

    private var capsule: some View {
        HStack(spacing: 5) {
            if isRunning {
                ProgressView()
                    .controlSize(.mini)
                    .scaleEffect(0.7)
                    .frame(width: 8, height: 8)
            } else {
                Circle()
                    .fill(activity.isEmpty ? theme.current.textMuted.opacity(0.5) : theme.current.success)
                    .frame(width: 6, height: 6)
            }
            if !compact {
                Text(activity.chipLabel)
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, compact ? 6 : 8)
        .padding(.vertical, 4)
        .background(theme.current.surface)
        .overlay(Capsule().strokeBorder(theme.current.border, lineWidth: 1))
        .clipShape(Capsule())
        .foregroundStyle(isRunning ? theme.current.text : theme.current.textMuted)
        .opacity(activity.isEmpty ? 0.75 : 1)
    }

    private var helpText: String {
        activity.isEmpty
            ? "No subagents used in this turn"
            : "Subagents this turn: \(activity.chipLabel) — click for details"
    }

    private var accessibilityText: String {
        if isRunning { return "Subagents: \(activity.runningCount) running of \(activity.total)" }
        return "Subagents: \(activity.chipLabel)"
    }
}

/// The chip's popover: one row per subagent call in the turn.
private struct SubagentActivityPopover: View {
    let activity: SubagentActivity
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Subagents · this turn")
                .font(.system(size: 11, weight: .semibold))
            Divider()
            if activity.isEmpty {
                Text("No subagents used in this turn.")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
            } else {
                // Elapsed ticks once a second while anything runs.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(activity.runs) { run in
                            row(run, now: context.date)
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(minWidth: 260, alignment: .leading)
    }

    private func row(_ run: SubagentActivity.Run, now: Date) -> some View {
        let elapsed = run.elapsed(now: now).map(SubagentActivity.elapsedLabel)
        let route = SubagentActivity.routeLabel(provider: run.provider, model: run.model, tier: run.tier)
        return HStack(alignment: .top, spacing: 8) {
            stateIcon(run.state)
                .frame(width: 14, height: 14)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(run.name ?? "subagent")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(theme.current.text)
                    Spacer(minLength: 8)
                    Text([stateLabel(run.state), elapsed].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 10))
                        .monospacedDigit()
                        .foregroundStyle(stateColor(run.state))
                }
                if let route {
                    Text(route)
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([run.name ?? "subagent", stateLabel(run.state), elapsed, route]
            .compactMap { $0 }.joined(separator: ", "))
    }

    @ViewBuilder
    private func stateIcon(_ state: SubagentActivity.State) -> some View {
        switch state {
        case .running:
            ProgressView().controlSize(.mini).scaleEffect(0.7)
        case .done:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 11)).foregroundStyle(theme.current.success)
        case .error:
            Image(systemName: "xmark.octagon.fill").font(.system(size: 11)).foregroundStyle(theme.current.danger)
        case .stopped:
            Image(systemName: "stop.circle").font(.system(size: 11)).foregroundStyle(theme.current.textMuted)
        }
    }

    private func stateLabel(_ state: SubagentActivity.State) -> String {
        switch state {
        case .running: return "Running"
        case .done: return "Done"
        case .error: return "Failed"
        case .stopped: return "Stopped"
        }
    }

    private func stateColor(_ state: SubagentActivity.State) -> Color {
        switch state {
        case .running: return theme.current.text
        case .done: return theme.current.textMuted
        case .error: return theme.current.danger
        case .stopped: return theme.current.textMuted
        }
    }
}
