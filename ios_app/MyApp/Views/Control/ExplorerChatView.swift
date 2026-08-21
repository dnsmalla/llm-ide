import SwiftUI
import UniformTypeIdentifiers
import SharedProtocol

/// Native iOS view for the Mac-side explorer-chat sessions: browse/create/load
/// persistent sessions, read their transcript, and send new turns (with optional
/// file attachments). Proxied through the paired Mac WebSocket; the Mac runs
/// code-assist with its own agent settings and workspace context.
struct ExplorerChatView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var explorerStore: ExplorerChatStore
    @Environment(\.dismiss) private var dismiss

    @State private var inputText: String = ""
    @State private var pendingFiles: [ChatFileText] = []
    @State private var pendingRefs: [ExploreWorkspaceRef] = []
    @State private var pendingSkills: [ExploreSkillRef] = []
    @State private var showSessionPicker: Bool = false
    @State private var showFilePicker: Bool = false
    @State private var showMacSearch: Bool = false
    @State private var showMacSkills: Bool = false
    @State private var renameSessionId: String?
    @State private var renameTitle: String = ""
    @FocusState private var isInputFocused: Bool

    private var isConnected: Bool { connection.connectionStatus == .connected }
    private var hasSession: Bool { explorerStore.exploreCurrent != nil }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !isConnected {
                    StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
                }
                if let err = connection.errorMessage {
                    StatusBanner(.error(message: err) { connection.errorMessage = nil })
                }
                chatTranscript
                inputBar
            }
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .animation(.easeInOut(duration: 0.2), value: isConnected)
            .animation(.easeInOut(duration: 0.2), value: connection.errorMessage)
            .navigationTitle(explorerStore.exploreCurrent?.title ?? "Explorer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSessionPicker = true
                        explorerStore.exploreListSessions()
                    } label: { Image(systemName: "sidebar.left") }
                }
                if explorerStore.isStreaming {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(role: .destructive) {
                            explorerStore.cancelStreaming()
                            haptic(.medium)
                        } label: {
                            Image(systemName: "stop.fill")
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showSessionPicker) {
            sessionPicker
                .environmentObject(connection)
                .environmentObject(explorerStore)
        }
        .sheet(isPresented: $showMacSearch) {
            macWorkspaceSearchSheet
                .environmentObject(explorerStore)
        }
        .sheet(isPresented: $showMacSkills) {
            macSkillSearchSheet
                .environmentObject(explorerStore)
        }
        .onAppear { explorerStore.prepareSessionIfNeeded() }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected { explorerStore.prepareSessionIfNeeded() }
        }
        .alert("Rename session", isPresented: Binding(
            get: { renameSessionId != nil },
            set: { if !$0 { renameSessionId = nil } }
        )) {
            TextField("Title", text: $renameTitle)
            Button("Save") {
                if let id = renameSessionId {
                    explorerStore.exploreRenameSession(id, title: renameTitle)
                }
                renameSessionId = nil
            }
            Button("Cancel", role: .cancel) { renameSessionId = nil }
        }
        .fileImporter(isPresented: $showFilePicker,
                      allowedContentTypes: [.pdf, .plainText, .text]) { result in
            switch result {
            case .success(let url):
                if let extracted = FileTextExtractor.extract(from: url) {
                    pendingFiles.append(ChatFileText(name: extracted.name, text: extracted.text))
                } else {
                    connection.errorMessage = "Couldn't read text from that file."
                }
            case .failure(let err):
                connection.errorMessage = err.localizedDescription
            }
        }
    }

    // MARK: — Session picker (sheet)

    private var sessionPicker: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        explorerStore.exploreNewSession()
                        showSessionPicker = false
                    } label: {
                        Label("New chat", systemImage: "plus.circle.fill")
                            .foregroundColor(DesignSystem.Colors.primary)
                    }
                }
                Section(explorerStore.exploreSessions.isEmpty ? "No sessions yet" : "Recent") {
                    ForEach(explorerStore.exploreSessions, id: \.id) { session in
                        sessionRow(session)
                    }
                    .onDelete { indexSet in
                        for idx in indexSet {
                            explorerStore.exploreDeleteSession(explorerStore.exploreSessions[idx].id)
                        }
                    }
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { showSessionPicker = false }
                }
            }
            .onAppear { explorerStore.refreshIfConnected() }
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: ExploreSessionSummary) -> some View {
        Button {
            explorerStore.exploreLoadSession(session.id)
            showSessionPicker = false
        } label: {
            HStack(spacing: DesignSystem.Spacing.sm) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 15))
                    .foregroundColor(DesignSystem.Colors.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title.isEmpty ? "Untitled" : session.title)
                        .font(.system(size: DesignSystem.Typography.body))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                        .lineLimit(1)
                    Text(Date(epochSeconds: session.lastUsedAt).relativeTimeShort())
                        .font(.system(size: DesignSystem.Typography.footnote))
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
                Spacer(minLength: 0)
                if explorerStore.exploreCurrent?.id == session.id {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(DesignSystem.Colors.primary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                renameSessionId = session.id
                renameTitle = session.title.isEmpty ? "" : session.title
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }
    }

    // MARK: — Chat transcript

    private var chatTranscript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: DesignSystem.Spacing.sm) {
                    if let current = explorerStore.exploreCurrent {
                        if current.history.isEmpty {
                            EmptyChatState(
                                icon: "bubble.left.and.text.bubble.right",
                                title: "Ask anything about this session",
                                subtitle: "Type a question, tap / for Mac skills, @ for Mac files, or attach iPhone files."
                            )
                        }
                        ForEach(current.history) { msg in
                            ChatBubble(message: msg).id(msg.id)
                        }
                    } else if explorerStore.isPreparingSession {
                        VStack(spacing: DesignSystem.Spacing.sm) {
                            ProgressView()
                            Text("Starting session on your Mac…")
                                .font(.system(size: DesignSystem.Typography.callout, weight: .medium))
                                .foregroundColor(DesignSystem.Colors.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                    } else {
                        noSessionState
                    }
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: explorerStore.exploreCurrent?.history.last?.text) { _ in
                if let last = explorerStore.exploreCurrent?.history.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    /// Left inline — distinct from `EmptyChatState`: different icon, different
    /// copy, and a "Browse sessions" action button. Only appears in the explorer
    /// surface, so factoring it out would add parameters for one caller.
    private var noSessionState: some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: "sidebar.left")
                .font(.system(size: 34))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text("No session selected")
                .font(.system(size: DesignSystem.Typography.callout, weight: .medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Text("Pick or create a session to begin.")
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Button {
                showSessionPicker = true
                explorerStore.exploreListSessions()
            } label: {
                Label("Browse sessions", systemImage: "list.bullet")
                    .font(.system(size: DesignSystem.Typography.body, weight: .medium))
                    .foregroundColor(DesignSystem.Colors.primary)
                    .padding(.horizontal, DesignSystem.Spacing.md)
                    .padding(.vertical, DesignSystem.Spacing.sm)
                    .background(DesignSystem.Colors.primaryLight)
                    .clipShape(Capsule())
            }
            .padding(.top, DesignSystem.Spacing.xs)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    // MARK: — Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            if !pendingSkills.isEmpty || !pendingRefs.isEmpty || !pendingFiles.isEmpty { attachmentChips }
            Divider()
            ChatInputBar(
                text: $inputText,
                placeholder: inputPlaceholder,
                canSend: canSend,
                isFocused: $isInputFocused,
                onSend: send
            ) {
                HStack(spacing: DesignSystem.Spacing.xs) {
                    Button { showMacSkills = true } label: {
                        Image(systemName: "slash.circle")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(DesignSystem.Colors.primary)
                            .frame(width: 40, height: 40)
                            .background(DesignSystem.Colors.surfaceSecondary)
                            .clipShape(Circle())
                    }
                    .disabled(!isConnected)
                    Button {
                        showMacSearch = true
                    } label: {
                        Image(systemName: "at")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(DesignSystem.Colors.primary)
                            .frame(width: 40, height: 40)
                            .background(DesignSystem.Colors.surfaceSecondary)
                            .clipShape(Circle())
                    }
                    .disabled(!isConnected)
                    Button { showFilePicker = true } label: {
                        Image(systemName: "paperclip")
                            .font(.system(size: 18))
                            .foregroundColor(DesignSystem.Colors.primary)
                            .frame(width: 40, height: 40)
                            .background(DesignSystem.Colors.surfaceSecondary)
                            .clipShape(Circle())
                    }
                }
            }
        }
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                ForEach(pendingSkills) { skill in
                    skillChip(skill)
                }
                ForEach(pendingRefs) { ref in
                    refChip(ref)
                }
                ForEach(Array(pendingFiles.enumerated()), id: \.offset) { idx, file in
                    fileChip(idx: idx, file: file)
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, DesignSystem.Spacing.sm)
        }
    }

    private func skillChip(_ skill: ExploreSkillRef) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 16))
                .foregroundColor(DesignSystem.Colors.primary)
            Text(skill.displayLabel)
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .lineLimit(1)
            Button {
                pendingSkills.removeAll { $0.id == skill.id }
                haptic(.light)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(DesignSystem.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func refChip(_ ref: ExploreWorkspaceRef) -> some View {
        HStack(spacing: 6) {
            Image(systemName: ref.kind == "folder" ? "folder.fill" : "doc.text.fill")
                .font(.system(size: 16))
                .foregroundColor(DesignSystem.Colors.primary)
            Text(ref.displayLabel)
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .lineLimit(1)
            Button {
                pendingRefs.removeAll { $0.id == ref.id }
                haptic(.light)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(DesignSystem.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func fileChip(idx: Int, file: ChatFileText) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text.fill")
                .font(.system(size: 16))
                .foregroundColor(DesignSystem.Colors.primary)
            Text(file.name)
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .lineLimit(1)
            Button {
                // Bounds-checked: the chips are keyed by array OFFSET, so a
                // stale index after a prior removal used to trap on
                // `Index out of range` (the llm-ide chat already guards this
                // exact call — `LlmIdeControlView.removeFile(at:)`).
                guard pendingFiles.indices.contains(idx) else { return }
                pendingFiles.remove(at: idx)
                haptic(.light)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            .accessibilityLabel("Remove attachment \(file.name)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(DesignSystem.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: — Mac workspace search (@file / @folder)

    private var macSkillSearchSheet: some View {
        MacSkillSearchSheet(
            pendingSkills: $pendingSkills,
            onDismiss: { showMacSkills = false }
        )
    }

    private var macWorkspaceSearchSheet: some View {
        MacWorkspaceSearchSheet(
            pendingRefs: $pendingRefs,
            onDismiss: { showMacSearch = false }
        )
    }

    private var canSend: Bool {
        let hasBody = !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingFiles.isEmpty || !pendingRefs.isEmpty || !pendingSkills.isEmpty
        return hasBody && isConnected && !explorerStore.isStreaming
    }

    private var inputPlaceholder: String {
        if explorerStore.isPreparingSession { return "Starting session…" }
        if hasSession { return "Message explorer" }
        return isConnected ? "Message explorer" : "Connect to your Mac first"
    }

    // MARK: — Actions

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = pendingFiles
        let refs = pendingRefs
        let skills = pendingSkills
        guard (!text.isEmpty || !files.isEmpty || !refs.isEmpty || !skills.isEmpty) else { return }
        let prompt: String
        if text.isEmpty, !skills.isEmpty {
            prompt = "Run the selected Mac skill(s)."
        } else if text.isEmpty, !refs.isEmpty, files.isEmpty {
            prompt = "Explore the referenced Mac workspace paths."
        } else if text.isEmpty, !files.isEmpty {
            prompt = "Review the attached file(s)."
        } else {
            prompt = text
        }
        guard let id = explorerStore.exploreCurrent?.id else {
            explorerStore.queueSendWhenReady(text: prompt, files: files, refs: refs, skills: skills)
            inputText = ""
            pendingFiles = []
            pendingRefs = []
            pendingSkills = []
            isInputFocused = false
            haptic(.light)
            return
        }
        explorerStore.sendExploreChat(prompt, sessionId: id, files: files, refs: refs, skills: skills)
        inputText = ""
        pendingFiles = []
        pendingRefs = []
        pendingSkills = []
        isInputFocused = false
        haptic(.light)
    }
}
