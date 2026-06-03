import SwiftUI

/// Read-only detail pane for the two locked built-in agents:
/// "meeting-assistant" — the in-session question loop
/// "ask-agent"         — the global /code-assist LLM loop
///
/// Neither is deletable or editable through the Library;  settings
/// that affect their behaviour live in Settings → Agent.
struct BuiltinAgentDetailView: View {
    let agentId: String     // "meeting-assistant" | "ask-agent"
    @EnvironmentObject private var theme: ThemeStore

    private var info: AgentInfo { AgentInfo.all[agentId] ?? .placeholder }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().padding(.vertical, 16)
                descriptionSection
                Divider().padding(.vertical, 16)
                capabilitiesSection
                Divider().padding(.vertical, 16)
                lockedNote
                Spacer(minLength: 40)
            }
            .padding(.horizontal, 24)
            .padding(.top, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.current.body)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(info.color.opacity(0.15))
                    .frame(width: 50, height: 50)
                Image(systemName: info.icon)
                    .font(.title2.weight(.medium))
                    .foregroundStyle(info.color)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(info.displayName)
                        .font(.title2.weight(.semibold))
                    lockedBadge
                }
                Text(info.tagline)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 4)
        }
    }

    private var lockedBadge: some View {
        HStack(spacing: 3) {
            Image(systemName: "lock.fill")
                .font(.caption2.weight(.semibold))
            Text("Built-in")
                .font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(theme.current.surface2, in: Capsule())
        .foregroundStyle(theme.current.textMuted)
    }

    // MARK: - Description

    private var descriptionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("About", systemImage: "info.circle")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            Text(info.about)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Capabilities

    private var capabilitiesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Capabilities", systemImage: "sparkles")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            ForEach(info.capabilities, id: \.self) { cap in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.callout)
                        .foregroundStyle(.green)
                        .padding(.top, 1)
                    Text(cap)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Locked note

    private var lockedNote: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield")
                .font(.callout)
                .foregroundStyle(.orange)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text("Core Agent — cannot be removed")
                    .font(.callout.weight(.medium))
                Text("This agent is part of the MeetNotes core and is always available. You can configure its behaviour in **Settings → Agent**.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(theme.current.accent4.opacity(theme.current.isDark ? 0.10 : 0.07),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: - Static catalog

    private struct AgentInfo {
        let displayName: String
        let tagline: String
        let about: String
        let icon: String
        let color: Color
        let capabilities: [String]

        static let placeholder = AgentInfo(
            displayName: "Unknown Agent",
            tagline: "—",
            about: "No description available.",
            icon: "questionmark.circle",
            color: .gray,
            capabilities: []
        )

        static let all: [String: AgentInfo] = [
            "meeting-assistant": AgentInfo(
                displayName: "Meeting Assistant",
                tagline: "Live in-session question loop",
                about: "The Meeting Assistant monitors your live transcription in real time. When it detects a topic, decision, or blocker worth clarifying, it surfaces a concise follow-up question. Questions are scored and gated on a silence window so they only appear when the meeting allows a brief pause.",
                icon: "waveform.badge.magnifyingglass",
                color: .purple,
                capabilities: [
                    "Real-time transcript monitoring with 1.5 s tick loop",
                    "Relevance scoring — questions must clear a 0.7 threshold",
                    "Silence gate (2.5 s) and 90 s per-user cooldown to avoid interrupting",
                    "Persona-aware voice — adapts to your active persona name and suffix",
                    "Feedback loop — \"useful / noise / later\" ratings improve future dispatches",
                    "Auto-dispatch when capture starts (configurable in Settings → Agent)",
                ]
            ),
            "ask-agent": AgentInfo(
                displayName: "Ask Agent",
                tagline: "Global code-assist & knowledge loop",
                about: "The Ask Agent powers every /ask and code-assist request. It runs a multi-turn tool-calling loop: first the global agent tries to answer using its built-in skills; when it needs app-specific knowledge it delegates to the internal agent which can search your knowledge base, create issues, and run code reviews.",
                icon: "brain.head.profile",
                color: .blue,
                capabilities: [
                    "Multi-turn tool-calling loop (up to 10 iterations, 3 min deadline)",
                    "Global skills: ask-internal, ask-subagent, update-file",
                    "Internal KB skills: search-kb, create-gitlab-issue, trigger-review-code",
                    "Plugin subagent delegation via ask-subagent",
                    "Persona overlay — your active persona shapes voice and focus",
                    "Slash-command expansion before the loop runs",
                ]
            ),
        ]
    }
}
