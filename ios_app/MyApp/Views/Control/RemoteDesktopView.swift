import SwiftUI
import UIKit

/// TeamViewer-like remote desktop: view screen stream, control with touch.
struct RemoteDesktopView: View {
    let deviceName: String
    @EnvironmentObject var controlService: ControlService
    @EnvironmentObject var connectionStore: ConnectionStore

    @State private var isKeyboardActive: Bool = false
    @State private var showPromptPanel: Bool = false
    @State private var promptText: String = ""
    @FocusState private var isPromptFocused: Bool
    @State private var showSettings: Bool = false
    @State private var showLlmIde: Bool = false
    @State private var showLlmIdeCloseConfirm: Bool = false
    @State private var showExplore: Bool = false
    @State private var showAutoTask: Bool = false

    // Floating, draggable key palette (toggled from the top-right)
    @State private var showKeyPalette: Bool = false
    @State private var paletteOffset: CGSize = .zero
    @GestureState private var paletteDrag: CGSize = .zero

    /// llm-ide tabs reachable via the `llmide://` deep-link scheme.
    private let llmIdeTabs: [(label: String, tab: String, icon: String)] = [
        ("Transcript", "transcript", "text.alignleft"),
        ("Plan", "plan", "checklist"),
        ("Review", "review", "doc.text.magnifyingglass"),
        ("History", "history", "clock.arrow.circlepath"),
        ("Settings", "settings", "gear"),
    ]

    // Voice control
    @StateObject private var speech = SpeechRecognizer()

    // Drag mode — next touch presses the mouse button and drags
    @State private var isDragMode: Bool = false
    @State private var dragActive: Bool = false

    // Scroll mode — vertical drags scroll the Mac
    @State private var isScrollMode: Bool = false
    @State private var lastScrollY: CGFloat?

    // Zoom — pinch or buttons; pan with one finger while zoomed
    @State private var zoomScale: CGFloat = 1.0
    @State private var zoomOffset: CGSize = .zero
    @State private var pinchBase: CGFloat?
    @State private var panBase: CGSize?

    // Sticky modifier keys (cleared after the next keypress)
    @State private var activeModifiers: Set<String> = []

    // Double-tap detection (view coordinates)
    @State private var lastTapTime: Date = .distantPast
    @State private var lastTapPoint: CGPoint = .zero

    // Mouse move throttle (view coordinates)
    @State private var lastMovePt: CGPoint = .zero

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black.ignoresSafeArea()

                // Hidden keyboard input — handles typing AND backspace reliably
                HiddenKeyboardInput(onKey: { key in sendKeyWithModifiers(key) },
                                    isFocused: isKeyboardActive)
                    .frame(width: 1, height: 1)
                    .opacity(0)

                if let uiImage = controlService.screenImage {
                    screenView(uiImage: uiImage, viewSize: geo.size)

                    // Zoom controls — right edge, vertically centered
                    HStack {
                        Spacer()
                        zoomControls(viewSize: geo.size)
                    }
                } else {
                    statusView
                }

                // Error banner — always visible on top when the agent reports a problem
                if let error = controlService.errorMessage {
                    VStack {
                        errorBanner(error)
                        Spacer()
                    }
                }

                // Modifier key bar — sits above the keyboard while typing.
                // Hidden when the floating key palette is open (it has the keys).
                if isKeyboardActive && !showKeyPalette {
                    VStack {
                        Spacer()
                        modifierBar
                    }
                }

                // Floating, draggable key palette
                if showKeyPalette {
                    VStack {
                        HStack {
                            Spacer()
                            keyPalette
                                .offset(x: paletteOffset.width + paletteDrag.width,
                                        y: paletteOffset.height + paletteDrag.height)
                            Spacer()
                        }
                        Spacer()
                    }
                    .padding(.top, 8)
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
                }

                // Voice control overlay
                if speech.isListening {
                    VStack {
                        Spacer()
                        voiceOverlay
                    }
                }

                // Floating control bar — hidden while another input surface is up
                if !isKeyboardActive && !showPromptPanel && !speech.isListening {
                    VStack {
                        Spacer()
                        controlBar
                    }
                }

                // Prompt panel — always rendered last so it's on top.
                // It must rise above the keyboard, so it does NOT ignore the
                // keyboard safe area; the Spacer keeps it pinned to the bottom
                // (just above the keyboard once one is shown).
                if showPromptPanel {
                    VStack(spacing: 0) {
                        Spacer()
                        promptPanel
                    }
                }

                // Action toast — confirms llm-ide app/tab/menu actions while the
                // live screen stays visible (so you watch the Mac react).
                if let status = controlService.actionStatus, !showPromptPanel {
                    VStack {
                        Spacer()
                        actionToast(status).padding(.bottom, 90)
                    }
                    .allowsHitTesting(false)
                }
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
        .confirmationDialog("Quit LLM IDE on your Mac?",
                            isPresented: $showLlmIdeCloseConfirm, titleVisibility: .visible) {
            Button("Quit LLM IDE", role: .destructive) {
                controlService.closeLlmIde()
                haptic(.medium)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This quits the app on your Mac. Any in-progress recording will stop.")
        }
        .animation(.easeInOut(duration: 0.2), value: controlService.actionStatus)
        .onAppear { controlService.startViewing() }
        .onDisappear {
            controlService.stopViewing()
            speech.cancel()
        }
        .onChange(of: speech.errorMessage) { msg in
            if let msg { controlService.errorMessage = msg }
        }
    }

    // MARK: — Screen stream

    private func screenView(uiImage: UIImage, viewSize: CGSize) -> some View {
        ZStack {
            // Purely visual layer — all touch handling lives on the overlay below,
            // which never transforms, so touch coordinates are always in plain
            // view space and the zoom mapping is done explicitly in contentPoint().
            Image(uiImage: uiImage)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .scaleEffect(zoomScale)
                .offset(zoomOffset)
                .animation(.easeOut(duration: 0.15), value: zoomScale)
                .allowsHitTesting(false)

            Color.clear
            .contentShape(Rectangle())
            .gesture(
                ExclusiveGesture(
                    LongPressGesture(minimumDuration: 0.5)
                        .onEnded { _ in
                            controlService.sendRemoteInput(action: ["type": "rightClick"])
                            haptic(.medium)
                        },
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let norm = normalize(contentPoint(value.location, viewSize: viewSize),
                                                 viewSize: viewSize,
                                                 imageSize: uiImage.size)
                            if isDragMode && !dragActive {
                                // Press the button where the finger lands
                                controlService.sendRemoteInput(action: [
                                    "type": "down", "x": norm.x, "y": norm.y
                                ])
                                dragActive = true
                                haptic(.heavy)
                                lastMovePt = value.location
                                return
                            }
                            if dragActive {
                                if hypot(value.location.x - lastMovePt.x,
                                         value.location.y - lastMovePt.y) > 3 {
                                    controlService.sendRemoteInput(action: [
                                        "type": "move", "x": norm.x, "y": norm.y
                                    ])
                                    lastMovePt = value.location
                                }
                                return
                            }
                            if isScrollMode {
                                // Vertical drag scrolls the Mac (natural touch direction)
                                if let last = lastScrollY {
                                    let dy = value.location.y - last
                                    if abs(dy) >= 4 {
                                        controlService.sendRemoteInput(action: [
                                            "type": "scroll", "deltaY": Int(dy * 2)
                                        ])
                                        lastScrollY = value.location.y
                                    }
                                } else {
                                    lastScrollY = value.location.y
                                }
                                return
                            }
                            if zoomScale > 1 {
                                // Zoomed: one finger pans the canvas
                                let base = panBase ?? zoomOffset
                                if panBase == nil { panBase = zoomOffset }
                                zoomOffset = clampedOffset(CGSize(
                                    width: base.width + value.translation.width,
                                    height: base.height + value.translation.height
                                ), viewSize: viewSize)
                                return
                            }
                            guard value.translation != .zero else { return }
                            if hypot(value.location.x - lastMovePt.x,
                                     value.location.y - lastMovePt.y) > 3 {
                                controlService.sendRemoteInput(action: [
                                    "type": "move", "x": norm.x, "y": norm.y
                                ])
                                lastMovePt = value.location
                            }
                        }
                        .onEnded { value in
                            let norm = normalize(contentPoint(value.location, viewSize: viewSize),
                                                 viewSize: viewSize,
                                                 imageSize: uiImage.size)
                            lastScrollY = nil
                            panBase = nil
                            if dragActive {
                                controlService.sendRemoteInput(action: [
                                    "type": "up", "x": norm.x, "y": norm.y
                                ])
                                dragActive = false
                                isDragMode = false
                                haptic(.medium)
                                return
                            }
                            let dist = hypot(value.translation.width,
                                             value.translation.height)
                            guard dist < 10 else { return }
                            let now = Date()
                            // Double-tap: same spot within 350 ms
                            if now.timeIntervalSince(lastTapTime) < 0.35
                                && hypot(value.location.x - lastTapPoint.x,
                                         value.location.y - lastTapPoint.y) < 30 {
                                controlService.sendRemoteInput(action: [
                                    "type": "doubleClick", "x": norm.x, "y": norm.y
                                ])
                                lastTapTime = .distantPast
                            } else {
                                controlService.sendRemoteInput(action: [
                                    "type": "click", "x": norm.x, "y": norm.y
                                ])
                                lastTapTime = now
                                lastTapPoint = value.location
                            }
                            haptic(.light)
                        }
                )
            )
            // Pinch to zoom
            .simultaneousGesture(
                MagnificationGesture()
                    .onChanged { value in
                        let base = pinchBase ?? zoomScale
                        if pinchBase == nil { pinchBase = zoomScale }
                        zoomScale = min(max(base * value, 1.0), 4.0)
                        zoomOffset = clampedOffset(zoomOffset, viewSize: viewSize)
                    }
                    .onEnded { _ in
                        pinchBase = nil
                        if zoomScale < 1.05 { resetZoom() }
                    }
            )
        }
    }

    /// Converts a touch in plain view coordinates to the content coordinate it
    /// lands on, undoing the zoom transform (scaleEffect around center + offset).
    private func contentPoint(_ p: CGPoint, viewSize: CGSize) -> CGPoint {
        guard zoomScale > 1 else { return p }
        let cx = viewSize.width / 2
        let cy = viewSize.height / 2
        return CGPoint(
            x: (p.x - zoomOffset.width - cx) / zoomScale + cx,
            y: (p.y - zoomOffset.height - cy) / zoomScale + cy
        )
    }

    // MARK: — Zoom helpers

    private func clampedOffset(_ offset: CGSize, viewSize: CGSize) -> CGSize {
        let maxX = (zoomScale - 1) * viewSize.width / 2
        let maxY = (zoomScale - 1) * viewSize.height / 2
        return CGSize(width: min(max(offset.width, -maxX), maxX),
                      height: min(max(offset.height, -maxY), maxY))
    }

    private func resetZoom() {
        withAnimation(.easeOut(duration: 0.2)) {
            zoomScale = 1.0
            zoomOffset = .zero
        }
    }

    private func zoomIn(viewSize: CGSize) {
        withAnimation(.easeOut(duration: 0.2)) {
            zoomScale = min(zoomScale * 1.5, 4.0)
            zoomOffset = clampedOffset(zoomOffset, viewSize: viewSize)
        }
        haptic(.light)
    }

    private func zoomOut(viewSize: CGSize) {
        withAnimation(.easeOut(duration: 0.2)) {
            let next = zoomScale / 1.5
            if next < 1.1 {
                zoomScale = 1.0
                zoomOffset = .zero
            } else {
                zoomScale = next
                zoomOffset = clampedOffset(zoomOffset, viewSize: viewSize)
            }
        }
        haptic(.light)
    }

    private func zoomControls(viewSize: CGSize) -> some View {
        VStack(spacing: 2) {
            Button { zoomIn(viewSize: viewSize) } label: {
                Image(systemName: "plus.magnifyingglass")
                    .font(.system(size: 16))
                    .foregroundColor(zoomScale >= 4.0 ? .white.opacity(0.3) : .white.opacity(0.9))
                    .frame(width: 40, height: 38)
            }
            .disabled(zoomScale >= 4.0)

            if zoomScale > 1 {
                Button { resetZoom() } label: {
                    Text("\(Int(zoomScale * 100))%")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundColor(DesignSystem.Colors.primary)
                        .frame(width: 40, height: 24)
                }
            }

            Button { zoomOut(viewSize: viewSize) } label: {
                Image(systemName: "minus.magnifyingglass")
                    .font(.system(size: 16))
                    .foregroundColor(zoomScale <= 1.0 ? .white.opacity(0.3) : .white.opacity(0.9))
                    .frame(width: 40, height: 38)
            }
            .disabled(zoomScale <= 1.0)
        }
        .background(.ultraThinMaterial.opacity(0.9), in: RoundedRectangle(cornerRadius: 12))
        .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.12), lineWidth: 1))
        .padding(.trailing, 8)
    }

    // MARK: — Status (no frame yet)

    private var statusView: some View {
        VStack(spacing: 16) {
            switch controlService.connectionStatus {
            case .connecting:
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    .scaleEffect(1.2)
                Text("Connecting to \(deviceName)…")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.9))
            case .connected:
                // Socket is up but no frames yet — usually Screen Recording permission
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    .scaleEffect(1.2)
                Text("Connected — waiting for screen…")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.9))
                Text("If this never loads, grant Screen Recording permission\nto the agent's terminal on your Mac.")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.55))
                    .multilineTextAlignment(.center)
            case .disconnected:
                Image(systemName: "wifi.slash")
                    .font(.system(size: 40))
                    .foregroundColor(.white.opacity(0.6))
                Text("Disconnected")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.7))
                Button {
                    controlService.connectDirect(
                        ip: connectionStore.deviceIP,
                        port: connectionStore.devicePort,
                        pin: connectionStore.devicePIN
                    )
                } label: {
                    Text("Reconnect")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 10)
                        .background(DesignSystem.Colors.primary)
                        .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                }
            }
        }
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
                // Floating key palette toggle
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { showKeyPalette.toggle() }
                    haptic(.light)
                } label: {
                    Image(systemName: showKeyPalette ? "keyboard.fill" : "keyboard")
                        .font(.system(size: DesignSystem.Typography.headline))
                        .foregroundColor(showKeyPalette ? DesignSystem.Colors.primary : .white.opacity(0.9))
                }

                // Live connection status
                HStack(spacing: 5) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Text(statusLabel)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white.opacity(0.7))
                }

                // More menu: llm-ide controls + settings + lock + disconnect
                Menu {
                    Menu {
                        Button { controlService.openLlmIde(); haptic(.light) } label: {
                            Label("Open LLM IDE", systemImage: "power")
                        }
                        Menu {
                            ForEach(llmIdeTabs, id: \.tab) { item in
                                Button {
                                    controlService.openLlmIde(tab: item.tab)
                                    haptic(.light)
                                } label: { Label(item.label, systemImage: item.icon) }
                            }
                        } label: { Label("Go to Tab", systemImage: "square.grid.2x2") }
                        Menu {
                            Button {
                                controlService.clickMenu(app: ControlService.llmIdeAppName,
                                                         path: ["Window", "Quick Switch Project…"])
                                haptic(.light)
                            } label: { Label("Quick Switch Project", systemImage: "rectangle.stack") }
                            Button {
                                controlService.clickMenu(app: ControlService.llmIdeAppName,
                                                         path: ["Window", "Ask the Agent…"])
                                haptic(.light)
                            } label: { Label("Ask the Agent (in-app)", systemImage: "questionmark.bubble") }
                        } label: { Label("App Menu", systemImage: "filemenu.and.selection") }
                        Button(role: .destructive) { showLlmIdeCloseConfirm = true } label: {
                            Label("Close LLM IDE", systemImage: "xmark.circle")
                        }
                    } label: { Label("LLM IDE", systemImage: "brain") }
                    .disabled(controlService.connectionStatus != .connected)
                    Divider()
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "gear")
                    }
                    Button {
                        // Cmd+Ctrl+Q — locks the Mac screen
                        controlService.sendKey("q", modifiers: ["meta", "control"])
                        haptic(.medium)
                    } label: {
                        Label("Lock Mac", systemImage: "lock.fill")
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

    // MARK: — Floating control bar

    private var controlBar: some View {
        HStack(spacing: 0) {
            controlButton(icon: isDragMode ? "hand.draw.fill" : "hand.draw",
                          label: "Drag", active: isDragMode) {
                isDragMode.toggle()
                if isDragMode { isScrollMode = false }
                haptic(.light)
            }
            controlButton(icon: isScrollMode ? "arrow.up.and.down.circle.fill" : "arrow.up.and.down.circle",
                          label: "Scroll", active: isScrollMode) {
                isScrollMode.toggle()
                if isScrollMode { isDragMode = false }
                haptic(.light)
            }
            controlButton(icon: "mic", label: "Voice", active: false) {
                speech.start()
                haptic(.medium)
            }
            controlButton(icon: "keyboard", label: "Type", active: false) {
                isKeyboardActive = true
            }
            controlButton(icon: "text.bubble", label: "AI", active: false) {
                withAnimation(.easeInOut(duration: 0.25)) { showPromptPanel = true }
                isPromptFocused = true
            }
            Menu {
                Section("Quick Launch") {
                    Button { controlService.launchApp(name: "Safari") } label: {
                        Label("Safari", systemImage: "safari")
                    }
                    Button { controlService.launchApp(name: "Terminal") } label: {
                        Label("Terminal", systemImage: "terminal")
                    }
                    Button { controlService.launchApp(name: "Xcode") } label: {
                        Label("Xcode", systemImage: "hammer.fill")
                    }
                    Button { controlService.launchApp(name: "Finder") } label: {
                        Label("Finder", systemImage: "folder")
                    }
                    Button { controlService.launchApp(name: "Notes") } label: {
                        Label("Notes", systemImage: "note.text")
                    }
                }
            } label: {
                controlButtonLabel(icon: "square.grid.2x2", label: "Apps", active: false)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial.opacity(0.9), in: Capsule())
        .background(Color.black.opacity(0.55), in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
        .padding(.bottom, DesignSystem.Spacing.sm)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func controlButton(icon: String, label: String, active: Bool,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            controlButtonLabel(icon: icon, label: label, active: active)
        }
    }

    private func controlButtonLabel(icon: String, label: String, active: Bool) -> some View {
        VStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 19))
            Text(label)
                .font(.system(size: 10, weight: .medium))
        }
        .foregroundColor(active ? DesignSystem.Colors.primary : .white.opacity(0.92))
        .frame(width: 58, height: 46)
        .contentShape(Rectangle())
    }

    // MARK: — Modifier key bar

    private var modifierBar: some View {
        HStack(spacing: DesignSystem.Spacing.xs) {
            modifierKey("⌘", id: "meta")
            modifierKey("⌃", id: "control")
            modifierKey("⌥", id: "alt")
            modifierKey("⇧", id: "shift")

            Divider()
                .frame(height: 22)
                .background(Color.white.opacity(0.2))

            actionKey("esc", key: "escape")
            actionKey("tab", key: "tab")
            actionKey("←", key: "left")
            actionKey("↑", key: "up")
            actionKey("↓", key: "down")
            actionKey("→", key: "right")

            // Paste iPhone clipboard — typed on the Mac as text
            Button {
                guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
                controlService.sendText(text)
                haptic(.medium)
            } label: {
                Image(systemName: "doc.on.clipboard")
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                    .frame(width: 34, height: 34)
                    .background(Color.white.opacity(0.12))
                    .cornerRadius(8)
            }

            // Dismiss keyboard
            Button {
                isKeyboardActive = false
                activeModifiers.removeAll()
            } label: {
                Image(systemName: "keyboard.chevron.compact.down")
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                    .frame(width: 34, height: 34)
                    .background(Color.white.opacity(0.12))
                    .cornerRadius(8)
            }
        }
        .padding(.horizontal, DesignSystem.Spacing.sm)
        .padding(.vertical, 8)
        .background(Color.black.opacity(0.85))
        .cornerRadius(DesignSystem.Layout.cornerRadiusM)
        .padding(.bottom, 6)
    }

    private func modifierKey(_ label: String, id: String) -> some View {
        Button {
            if activeModifiers.contains(id) {
                activeModifiers.remove(id)
            } else {
                activeModifiers.insert(id)
            }
            haptic(.light)
        } label: {
            Text(label)
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(activeModifiers.contains(id) ? .black : .white)
                .frame(width: 38, height: 34)
                .background(activeModifiers.contains(id)
                    ? DesignSystem.Colors.primary
                    : Color.white.opacity(0.12))
                .cornerRadius(8)
        }
    }

    private func actionKey(_ label: String, key: String) -> some View {
        Button {
            sendKeyWithModifiers(key)
            haptic(.light)
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.white)
                .frame(minWidth: 34)
                .frame(height: 34)
                .padding(.horizontal, 4)
                .background(Color.white.opacity(0.12))
                .cornerRadius(8)
        }
    }

    private func sendKeyWithModifiers(_ key: String) {
        controlService.sendKey(key, modifiers: Array(activeModifiers))
        if !activeModifiers.isEmpty { activeModifiers.removeAll() }
    }

    // MARK: — Floating key palette

    /// Drag the palette by its handle; offset accumulates across drags.
    private var paletteDragGesture: some Gesture {
        DragGesture()
            .updating($paletteDrag) { value, state, _ in state = value.translation }
            .onEnded { value in
                paletteOffset.width += value.translation.width
                paletteOffset.height += value.translation.height
            }
    }

    private var keyPalette: some View {
        VStack(spacing: 8) {
            // Drag handle + close — this row is the drag target.
            HStack(spacing: 6) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.45))
                Text("Keys")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white.opacity(0.6))
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { showKeyPalette = false }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundColor(.white.opacity(0.5))
                }
            }
            .padding(.bottom, 2)
            .contentShape(Rectangle())
            .gesture(paletteDragGesture)

            // Modifiers (sticky — applied to the next key press)
            HStack(spacing: 6) {
                modifierKey("⌘", id: "meta")
                modifierKey("⌃", id: "control")
                modifierKey("⌥", id: "alt")
                modifierKey("⇧", id: "shift")
            }
            // Common keys
            HStack(spacing: 6) {
                actionKey("esc", key: "escape")
                actionKey("tab", key: "tab")
                actionKey("⏎", key: "return")
                actionKey("⌫", key: "backspace")
            }
            // Arrows
            HStack(spacing: 6) {
                actionKey("←", key: "left")
                actionKey("↑", key: "up")
                actionKey("↓", key: "down")
                actionKey("→", key: "right")
            }
            // Space · Paste · Type (system keyboard)
            HStack(spacing: 6) {
                actionKey("space", key: "space")
                Button {
                    guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
                    controlService.sendText(text)
                    haptic(.medium)
                } label: {
                    Image(systemName: "doc.on.clipboard")
                        .font(.system(size: 13))
                        .foregroundColor(.white)
                        .frame(width: 38, height: 34)
                        .background(Color.white.opacity(0.12))
                        .cornerRadius(8)
                }
                Button {
                    isKeyboardActive.toggle()
                    haptic(.light)
                } label: {
                    Image(systemName: isKeyboardActive ? "keyboard.chevron.compact.down" : "keyboard")
                        .font(.system(size: 13))
                        .foregroundColor(isKeyboardActive ? DesignSystem.Colors.primary : .white)
                        .frame(width: 38, height: 34)
                        .background(Color.white.opacity(0.12))
                        .cornerRadius(8)
                }
            }
        }
        .padding(12)
        .background(Color.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.white.opacity(0.15), lineWidth: 1))
        .shadow(color: .black.opacity(0.4), radius: 12, y: 6)
        .frame(width: 230)
    }

    // MARK: — Voice control

    private var voiceOverlay: some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                PulsingWaveform()
                Text(speech.transcript.isEmpty ? "Listening…" : speech.transcript)
                    .font(.system(size: DesignSystem.Typography.body))
                    .foregroundColor(speech.transcript.isEmpty ? .white.opacity(0.5) : .white)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Text("Try: \"open Safari\" · \"press enter\" · \"ask AI …\" — or just dictate text")
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.4))
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: DesignSystem.Spacing.md) {
                Button {
                    speech.cancel()
                } label: {
                    Text("Cancel")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.white.opacity(0.8))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.white.opacity(0.12))
                        .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                }
                Button {
                    finishVoice()
                } label: {
                    Text("Send")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(speech.transcript.isEmpty
                            ? DesignSystem.Colors.primary.opacity(0.4)
                            : DesignSystem.Colors.primary)
                        .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                }
                .disabled(speech.transcript.isEmpty)
            }
        }
        .padding(DesignSystem.Spacing.md)
        .background(Color.black.opacity(0.88))
        .cornerRadius(DesignSystem.Layout.cornerRadiusL)
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.bottom, DesignSystem.Spacing.sm)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func finishVoice() {
        let text = speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        speech.finish()
        guard !text.isEmpty else { return }
        handleVoiceCommand(text)
        haptic(.medium)
    }

    /// Small local grammar: "open X" launches apps, "press X" sends keys,
    /// "scroll up/down", "ask AI …" goes to the prompt panel — anything else
    /// is dictated onto the Mac as text.
    private func handleVoiceCommand(_ text: String) {
        let lower = text.lowercased()

        let appAliases: [String: String] = [
            "safari": "Safari", "terminal": "Terminal", "xcode": "Xcode",
            "finder": "Finder", "notes": "Notes", "mail": "Mail",
            "messages": "Messages", "music": "Music", "calendar": "Calendar",
            "photos": "Photos", "preview": "Preview", "calculator": "Calculator",
            "chrome": "Google Chrome", "google chrome": "Google Chrome",
            "vs code": "Visual Studio Code", "code": "Visual Studio Code",
            "system settings": "System Settings", "settings": "System Settings",
        ]
        for prefix in ["open ", "launch ", "start "] where lower.hasPrefix(prefix) {
            let spoken = String(lower.dropFirst(prefix.count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            let app = appAliases[spoken] ?? spoken.capitalized
            controlService.launchApp(name: app)
            return
        }

        if lower.hasPrefix("press ") {
            let spoken = String(lower.dropFirst(6))
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            let keys: [String: String] = [
                "enter": "enter", "return": "enter", "escape": "escape",
                "tab": "tab", "space": "space",
                "delete": "backspace", "backspace": "backspace",
            ]
            if let key = keys[spoken] {
                controlService.sendKey(key)
                return
            }
        }

        if lower.contains("lock") &&
            (lower.contains("mac") || lower.contains("screen") || lower.contains("computer")) {
            controlService.sendKey("q", modifiers: ["meta", "control"])
            return
        }

        if lower.contains("scroll down") {
            controlService.sendRemoteInput(action: ["type": "scroll", "deltaY": -300])
            return
        }
        if lower.contains("scroll up") {
            controlService.sendRemoteInput(action: ["type": "scroll", "deltaY": 300])
            return
        }

        for prefix in ["ask ai ", "ask the ai ", "ask a.i. "] where lower.hasPrefix(prefix) {
            let question = String(text.dropFirst(prefix.count))
            withAnimation(.easeInOut(duration: 0.25)) { showPromptPanel = true }
            controlService.sendPrompt(question)
            return
        }

        // Default: dictate as text
        controlService.sendText(text)
    }

    // MARK: — Prompt Panel (chat)

    private var promptPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Capsule()
                    .fill(Color.white.opacity(0.3))
                    .frame(width: 36, height: 4)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 8)
            .overlay(alignment: .trailing) {
                HStack(spacing: DesignSystem.Spacing.md) {
                    if !controlService.messages.isEmpty {
                        Button {
                            controlService.clearChat()
                        } label: {
                            Image(systemName: "trash")
                                .font(.system(size: 13))
                                .foregroundColor(.white.opacity(0.5))
                        }
                    }
                    Button {
                        withAnimation(.easeInOut(duration: 0.25)) { showPromptPanel = false }
                        isPromptFocused = false
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white.opacity(0.6))
                    }
                }
                .padding(.trailing, DesignSystem.Spacing.md)
                .padding(.top, 8)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                        if controlService.messages.isEmpty {
                            Text("Send a prompt to your AI agent…")
                                .font(.system(size: DesignSystem.Typography.body))
                                .foregroundColor(.white.opacity(0.35))
                                .padding(DesignSystem.Spacing.md)
                        } else {
                            ForEach(controlService.messages) { message in
                                chatBubble(message)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id("output-bottom")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, DesignSystem.Spacing.md)
                    .padding(.vertical, DesignSystem.Spacing.sm)
                }
                .onChange(of: controlService.messages) { _ in
                    withAnimation { proxy.scrollTo("output-bottom", anchor: .bottom) }
                }
            }
            .frame(height: 220)

            Divider().background(Color.white.opacity(0.15))

            HStack(spacing: DesignSystem.Spacing.sm) {
                TextField("Ask your AI agent…", text: $promptText, axis: .vertical)
                    .focused($isPromptFocused)
                    .font(.system(size: DesignSystem.Typography.body))
                    .foregroundColor(.white)
                    .lineLimit(1...4)
                    .padding(.horizontal, DesignSystem.Spacing.sm)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.1))
                    .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                    .tint(DesignSystem.Colors.primary)

                Button {
                    if controlService.llmStreaming {
                        controlService.stopPrompt()
                        return
                    }
                    let text = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    controlService.sendPrompt(text)
                    promptText = ""
                    isPromptFocused = false
                } label: {
                    Image(systemName: controlService.llmStreaming
                          ? "stop.circle.fill" : "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(
                            controlService.llmStreaming
                                ? DesignSystem.Colors.danger
                                : (promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? .white.opacity(0.3)
                                    : DesignSystem.Colors.primary)
                        )
                }
                .disabled(!controlService.llmStreaming
                          && promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, DesignSystem.Spacing.sm)
        }
        .background(Color.black.opacity(0.82))
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: 20, bottomLeadingRadius: 0,
            bottomTrailingRadius: 0, topTrailingRadius: 20
        ))
        .transition(.move(edge: .bottom))
    }

    @ViewBuilder
    private func chatBubble(_ message: ChatMessage) -> some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 40)
                Text(message.text)
                    .font(.system(size: DesignSystem.Typography.body))
                    .foregroundColor(.black)
                    .padding(.horizontal, DesignSystem.Spacing.md)
                    .padding(.vertical, DesignSystem.Spacing.sm)
                    .background(DesignSystem.Colors.primary)
                    .cornerRadius(14)
            }
        } else {
            HStack {
                if message.text.isEmpty && controlService.llmStreaming {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .white.opacity(0.6)))
                        .scaleEffect(0.8)
                        .padding(DesignSystem.Spacing.sm)
                } else {
                    Text(message.text)
                        .font(.system(size: DesignSystem.Typography.body, design: .monospaced))
                        .foregroundColor(.white.opacity(0.92))
                        .padding(.horizontal, DesignSystem.Spacing.md)
                        .padding(.vertical, DesignSystem.Spacing.sm)
                        .background(Color.white.opacity(0.08))
                        .cornerRadius(14)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 40)
            }
        }
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

    /// Maps a touch in view coordinates to a normalized (0–1) position on the
    /// streamed frame, using the actual decoded image size so any aspect ratio
    /// and letterboxing are handled correctly.
    private func normalize(_ point: CGPoint, viewSize: CGSize,
                           imageSize: CGSize) -> (x: Double, y: Double) {
        guard imageSize.width > 0, imageSize.height > 0,
              viewSize.width > 0, viewSize.height > 0 else { return (0, 0) }
        let imgAspect = imageSize.width / imageSize.height
        let viewAspect = viewSize.width / viewSize.height
        let displayWidth: CGFloat
        let displayHeight: CGFloat
        if viewAspect > imgAspect {
            displayHeight = viewSize.height
            displayWidth = viewSize.height * imgAspect
        } else {
            displayWidth = viewSize.width
            displayHeight = viewSize.width / imgAspect
        }
        let xPad = (viewSize.width - displayWidth) / 2
        let yPad = (viewSize.height - displayHeight) / 2
        let normX = max(0, min(1, (point.x - xPad) / displayWidth))
        let normY = max(0, min(1, (point.y - yPad) / displayHeight))
        return (Double(normX), Double(normY))
    }
}

// MARK: — Pulsing waveform (iOS 16-compatible listening indicator)

private struct PulsingWaveform: View {
    @State private var pulsing = false

    var body: some View {
        Image(systemName: "waveform")
            .font(.system(size: 18))
            .foregroundColor(DesignSystem.Colors.danger)
            .opacity(pulsing ? 1.0 : 0.35)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true),
                       value: pulsing)
            .onAppear { pulsing = true }
    }
}

// MARK: — Hidden keyboard input (backspace-capable)

/// UIViewRepresentable wrapping a hidden UITextField.
/// Intercepts every keypress via the UITextFieldDelegate BEFORE iOS applies it,
/// giving us reliable backspace detection without a sentinel-character hack.
private struct HiddenKeyboardInput: UIViewRepresentable {
    var onKey: (String) -> Void
    var isFocused: Bool

    func makeUIView(context: Context) -> UITextField {
        let tf = UITextField()
        tf.delegate = context.coordinator
        tf.autocorrectionType = .no
        tf.autocapitalizationType = .none
        tf.spellCheckingType = .no
        tf.smartDashesType = .no
        tf.smartQuotesType = .no
        tf.keyboardType = .default
        tf.alpha = 0
        return tf
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        context.coordinator.onKey = onKey
        // Drive focus from SwiftUI state without disturbing layout passes.
        DispatchQueue.main.async {
            if isFocused && !uiView.isFirstResponder {
                uiView.becomeFirstResponder()
            } else if !isFocused && uiView.isFirstResponder {
                uiView.resignFirstResponder()
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onKey: onKey) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var onKey: (String) -> Void
        init(onKey: @escaping (String) -> Void) { self.onKey = onKey }

        func textField(_ tf: UITextField,
                       shouldChangeCharactersIn range: NSRange,
                       replacementString string: String) -> Bool {
            if string.isEmpty {
                onKey("backspace")
            } else {
                for ch in string {
                    onKey(ch == "\n" ? "enter" : String(ch))
                }
            }
            return false  // Never let iOS mutate the field
        }

        // Software-keyboard Return button
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            onKey("enter")
            return false
        }
    }
}
