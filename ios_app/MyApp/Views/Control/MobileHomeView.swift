import SwiftUI
import UIKit

/// Host shell for a paired Mac: the navigation toolbar (Chat/Explore/Auto
/// buttons + live status dot + More menu) and the three sheet-presented
/// surfaces (LlmIdeControlView / ExplorerChatView / AutoTaskView), plus the
/// shared error banner and action toast.
///
/// The previous remote-desktop body — screen stream, touch→mouse/scroll/drag
/// mapping, zoom controls, modifier/key palette, voice overlay, and the
/// on-device "AI" prompt panel — was removed when the iPhone pivoted from a
/// remote-desktop client to a native chat client. Chat/Explore/Auto are the
/// live surfaces; everything they need lives behind those sheets.
struct MobileHomeView: View {
    let deviceName: String
    @EnvironmentObject var controlService: ControlService
    @EnvironmentObject var connectionStore: ConnectionStore

    @State private var showSettings: Bool = false
    @State private var showLlmIde: Bool = false
    @State private var showExplore: Bool = false
    @State private var showAutoTask: Bool = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Error banner — always visible on top when the agent reports a problem.
            if let error = controlService.errorMessage {
                VStack {
                    errorBanner(error)
                    Spacer()
                }
            }

            // Action toast — confirms one-shot Mac actions (e.g. auto-task acks)
            // while remaining non-blocking.
            if let status = controlService.actionStatus {
                VStack {
                    Spacer()
                    actionToast(status).padding(.bottom, 90)
                }
                .allowsHitTesting(false)
            }
        }
        .navigationTitle(deviceName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .toolbarBackground(Color.black, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .navigationDestination(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showLlmIde) {
            LlmIdeControlView()
                .environmentObject(controlService)
        }
        .sheet(isPresented: $showExplore) {
            ExplorerChatView()
                .environmentObject(controlService)
        }
        .sheet(isPresented: $showAutoTask) {
            AutoTaskView()
                .environmentObject(controlService)
        }
        .animation(.easeInOut(duration: 0.2), value: controlService.actionStatus)
    }

    // MARK: — Error banner

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: DesignSystem.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundColor(DesignSystem.Colors.danger)
            Text(message)
                .font(.system(size: 13))
                .foregroundColor(.white)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button {
                controlService.errorMessage = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.7))
            }
        }
        .padding(DesignSystem.Spacing.md)
        .background(Color(red: 0.25, green: 0.07, blue: 0.09).opacity(0.95))
        .overlay(
            RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
                .stroke(DesignSystem.Colors.danger.opacity(0.5), lineWidth: 1)
        )
        .cornerRadius(DesignSystem.Layout.cornerRadiusM)
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.top, DesignSystem.Spacing.sm)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: — Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { showLlmIde = true } label: {
                HStack(spacing: 5) {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                    Text("Chat").font(.system(size: 13, weight: .semibold))
                }
                .foregroundColor(.white.opacity(0.95))
            }
        }
        ToolbarItem(placement: .topBarLeading) {
            Button { showExplore = true } label: {
                HStack(spacing: 5) {
                    Image(systemName: "sidebar.left")
                    Text("Explore").font(.system(size: 13, weight: .semibold))
                }
                .foregroundColor(.white.opacity(0.95))
            }
        }
        ToolbarItem(placement: .topBarLeading) {
            Button { showAutoTask = true } label: {
                HStack(spacing: 5) {
                    Image(systemName: "bolt.fill")
                    Text("Auto").font(.system(size: 13, weight: .semibold))
                }
                .foregroundColor(.white.opacity(0.95))
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: DesignSystem.Spacing.md) {
                // Live connection status
                HStack(spacing: 5) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Text(statusLabel)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white.opacity(0.7))
                }

                // More menu: settings + disconnect
                Menu {
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "gear")
                    }
                    Divider()
                    Button("Disconnect", role: .destructive) {
                        controlService.stopViewing()
                        controlService.disconnect()
                        connectionStore.clear()
                    }
                } label: {
                    Image(systemName: "ellipsis.circle.fill")
                        .font(.system(size: DesignSystem.Typography.headline))
                        .foregroundColor(.white.opacity(0.9))
                }
            }
        }
    }

    // MARK: — Action toast

    private func actionToast(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(DesignSystem.Colors.success)
            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.white)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial.opacity(0.9), in: Capsule())
        .background(Color.black.opacity(0.6), in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: — Helpers

    private var statusColor: Color {
        switch controlService.connectionStatus {
        case .connected:    return .green
        case .connecting:   return .orange
        case .disconnected: return .red
        }
    }

    private var statusLabel: String {
        switch controlService.connectionStatus {
        case .connected:    return "Live"
        case .connecting:   return "Connecting"
        case .disconnected: return "Offline"
        }
    }

    private func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
}
