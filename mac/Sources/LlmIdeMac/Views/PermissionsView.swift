import SwiftUI

/// Onboarding screen for the three macOS permissions we may need.
/// AX is required; the other two are optional.  Polished card layout
/// with SF Symbols, status pills, and full labels (no truncation).
struct PermissionsView: View {
    @EnvironmentObject var theme: ThemeStore
    @StateObject private var permissions = PermissionsService()
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Persistent close affordance — always visible at the top-
            // right, anchored above the scroll area so it never falls
            // below the viewport when the sheet is short.
            scrollableContent

            Button {
                onDismiss?()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(theme.current.textMuted)
                    .padding(8)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .help("Close")
        }
        .background(theme.current.body)
        .onAppear { permissions.startPolling() }
        .onDisappear { permissions.stopPolling() }
    }

    @ViewBuilder
    private var scrollableContent: some View {
        // ScrollView guarantees the content (especially the Done button)
        // is always reachable even when the host sheet is sized smaller
        // than our intrinsic content height.
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                header
                VStack(spacing: Spacing.md) {
                    permissionRow(
                        icon: "accessibility",
                        iconColor: theme.current.accent2,
                        title: "Accessibility",
                        detail: "Read live captions from Zoom and Teams desktop apps.",
                        note: "Required for caption capture.",
                        state: permissions.accessibility,
                        pane: .accessibility,
                        primary: { permissions.promptAccessibility() }
                    )
                    permissionRow(
                        icon: "rectangle.on.rectangle",
                        iconColor: theme.current.accent3,
                        title: "Screen Recording",
                        detail: "Optional fallback that captures audio from a single meeting app when its in-app captions are not exposed.",
                        note: "Optional — only needed if AX scraping fails.",
                        state: permissions.screenRecording,
                        pane: .screenRecording,
                        primary: nil
                    )
                    permissionRow(
                        icon: "mic.fill",
                        iconColor: theme.current.accent4,
                        title: "Microphone",
                        detail: "Last-resort fallback when both in-app captions and system audio are unavailable.",
                        note: "Optional — disabled by default (mic mode is noisy).",
                        state: permissions.microphone,
                        pane: .microphone,
                        primary: { permissions.promptMicrophone() }
                    )
                }
                footerHint
                HStack {
                    Spacer()
                    Button("Done") { onDismiss?() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.defaultAction)
                }
                .padding(.top, Spacing.sm)
            }
            .padding(Spacing.xl)
            // Leave a little room at the top so the floating ✕ button
            // doesn't visually crowd the title.
            .padding(.top, Spacing.sm)
        }
    }

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(theme.current.accent)
                Text("Permissions")
                    .font(Typography.display)
                    .foregroundStyle(theme.current.text)
            }
            Text("LLM IDE captures meeting captions locally on your Mac. Grant these permissions in System Settings, then quit and relaunch the app.")
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var footerHint: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "info.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(theme.current.accent2)
            Text("After enabling Accessibility, **quit and relaunch** LLM IDE — macOS caches the trust state per-process, so the running app will keep saying \"needed\" until restart.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.current.surface2.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }

    @ViewBuilder
    private func permissionRow(
        icon: String,
        iconColor: Color,
        title: String,
        detail: String,
        note: String,
        state: PermissionsService.State,
        pane: PermissionsService.SettingsPane,
        primary: (() -> Void)?
    ) -> some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(iconColor)
                .frame(width: 32, height: 32)
                .background(iconColor.opacity(theme.current.isDark ? 0.15 : 0.10))
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))

            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: Spacing.sm) {
                    Text(title)
                        .font(Typography.bodyStrong)
                        .foregroundStyle(theme.current.text)
                    statusPill(state)
                }
                Text(detail)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                Text(note)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted.opacity(0.75))
                    .italic()
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: Spacing.xs) {
                if let primary, state != .granted {
                    Button("Request") { primary() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                Button {
                    permissions.openSystemSettings(pane: pane)
                } label: {
                    Text("Open Settings")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .card()
    }

    @ViewBuilder
    private func statusPill(_ state: PermissionsService.State) -> some View {
        let (label, fg, bg): (String, Color, Color) = {
            switch state {
            case .granted: return ("granted",
                                   theme.current.accent3,
                                   theme.current.accent3.opacity(theme.current.isDark ? 0.20 : 0.12))
            case .denied:  return ("needed",
                                   theme.current.danger,
                                   theme.current.danger.opacity(theme.current.isDark ? 0.20 : 0.12))
            case .unknown: return ("unknown",
                                   theme.current.textMuted,
                                   theme.current.textMuted.opacity(theme.current.isDark ? 0.18 : 0.10))
            }
        }()
        Text(label)
            .font(Typography.captionStrong)
            .foregroundStyle(fg)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, 2)
            .background(bg)
            .clipShape(Capsule())
    }
}
