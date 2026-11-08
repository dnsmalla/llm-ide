import SwiftUI
import UIKit
import PDFKit
import UniformTypeIdentifiers
import SharedProtocol

/// Companion chat with the LLM-IDE agent from the iPhone. Messages (typed,
/// dictated, or with attachments) go to the paired desktop over Host API v1 (`chat.send`) and the
/// local `:3456` backend; streamed replies land in this transcript.
struct LlmIdeControlView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var llmIdeStore: LlmIdeChatStore
    @EnvironmentObject var projectsStore: ProjectsStore
    @Environment(\.dismiss) private var dismiss
    /// True when hosted by the tab shell (no own stack, no "Done").
    var embedded: Bool = false

    @StateObject private var speech = SpeechRecognizer()
    @State private var inputText: String = ""
    @State private var pendingFiles: [ChatFileText] = []                        // text extracted on-device
    /// True while a dictation session is live or finishing. The recognizer's final transcript lands after
    /// `finish()` has already cleared `isListening`, so the transcript handler gates on this instead.
    @State private var dictating = false
    /// Guards the trash action — it also wipes the desktop's shared transcript.
    @State private var showClearConfirm = false
    @State private var showFilePicker = false
    @FocusState private var isInputFocused: Bool

    private var isConnected: Bool { connection.connectionStatus == .connected }

    var body: some View {
        OptionalNavigationStack(embedded: embedded) {
            VStack(spacing: 0) {
                if !isConnected && !embedded {
                    StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
                }
                if let err = connection.errorMessage {
                    StatusBanner(.error(message: err) { connection.errorMessage = nil })
                }
                // The paired desktop's projects, each with this account's role. Hidden until there is
                // either a live host to ask or a list already loaded for an offline read.
                if isConnected || projectsStore.state.loaded {
                    ProjectPickerBar(isBusy: llmIdeStore.isStreaming, onSelect: selectProject)
                }
                chatTranscript
                pinnedToolApproval
                if let notice = HostApiChatNotices.composer(connected: isConnected, capabilities: connection.hostCapabilities) {
                    Text(notice)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, DesignSystem.Spacing.md)
                }
                inputBar
            }
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .animation(.easeInOut(duration: 0.2), value: isConnected)
            .animation(.easeInOut(duration: 0.2), value: connection.errorMessage)
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !embedded {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        // This also clears the desktop's shared transcript
                        // (`chat.history.clear`) and cannot be undone, so it
                        // sits behind a menu AND a confirmation.
                        Button(role: .destructive) {
                            showClearConfirm = true
                        } label: { Label("Clear chat history", systemImage: "trash") }
                            .disabled(llmIdeStore.llmIdeMessages.isEmpty || !connection.supports(HostApiCommand.chatHistoryClear.capability))
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Chat options")
                }
                if llmIdeStore.isStreaming {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(role: .destructive) {
                            llmIdeStore.cancelStreaming()
                            haptic(.medium)
                        } label: {
                            Image(systemName: "stop.fill")
                        }
                        .accessibilityLabel("Stop the reply")
                    }
                }
            }
            .onChange(of: speech.transcript) { newValue in
                if dictating, !newValue.isEmpty {
                    inputText = newValue
                    // The result that arrives after stop is the final one: stop following so typing is not overwritten.
                    if !speech.isListening { dictating = false }
                }
            }
            .onChange(of: speech.errorMessage) { msg in
                if let msg { connection.errorMessage = msg }
            }
            .onAppear {
                llmIdeStore.loadSharedHistory()
            }
            .onChange(of: connection.connectionStatus) { status in
                if status == .connected { llmIdeStore.loadSharedHistory() }
            }
            // The first project is selected once `projects.list` lands, and the user can pick another:
            // either way the transcript is the one for the newly selected project.
            .onChange(of: projectsStore.state.selectedId) { _ in llmIdeStore.loadSharedHistory() }
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
            .onDisappear { speech.cancel() }
        }
    }

    // MARK: — Chat transcript

    private var chatTranscript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: DesignSystem.Spacing.sm) {
                    if llmIdeStore.llmIdeMessages.isEmpty {
                        EmptyChatState(
                            icon: "bubble.left.and.text.bubble.right",
                            title: "Ask llm-agent anything",
                            subtitle: "Type or tap the mic to dictate."
                        )
                    }
                    ForEach(llmIdeStore.llmIdeMessages) { msg in
                        ChatBubble(message: msg,
                                       isStreaming: llmIdeStore.isStreaming && msg.id == llmIdeStore.llmIdeMessages.last?.id)
                                .id(msg.id)
                    }
                    approvalSlot
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: llmIdeStore.pendingToolApproval?.requestId) { id in
                guard let id else { return }
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(id, anchor: .bottom) }
            }
            .onChange(of: llmIdeStore.pendingApproval?.requestId) { id in
                guard let id else { return }
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(id, anchor: .bottom) }
            }
            .onChange(of: llmIdeStore.llmIdeMessages.last?.text) { _ in
                if let last = llmIdeStore.llmIdeMessages.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .confirmationDialog("Clear this chat?",
                                isPresented: $showClearConfirm,
                                titleVisibility: .visible) {
                Button("Clear on this iPhone and the desktop", role: .destructive) {
                    llmIdeStore.clearLlmIdeChat()
                    haptic(.light)
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This deletes the shared llm-ide transcript on your desktop too. It can't be undone.")
            }
        }
    }

    /// The agent's own question, answerable by tapping — under the transcript
    /// because that is where it was asked, and the turn is parked until it is
    /// answered. Hoisted out of `chatTranscript` because inline it put that
    /// body past the type-checker's budget ("unable to type-check this
    /// expression in reasonable time").
    @ViewBuilder
    private var approvalSlot: some View {
        if let request = llmIdeStore.pendingApproval {
            ApprovalQuestionCard(request: request) { selection in
                llmIdeStore.submitApproval(selection: selection)
                haptic(.light)
            }
            .id(request.requestId)
            .transition(.opacity)
        } else if let notice = llmIdeStore.approvalNotice, !notice.isEmpty {
            Text(notice)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// A tool/edit permission prompt is blocking and time-sensitive, so it is pinned above the
    /// composer (its buttons can never scroll away) rather than sitting inside the transcript.
    @ViewBuilder
    private var pinnedToolApproval: some View {
        if let tool = llmIdeStore.pendingToolApproval {
            ToolApprovalCard(request: tool, enabled: connection.connectionStatus == .connected) { allow in
                llmIdeStore.submitToolApproval(allow: allow)
                haptic(allow ? .medium : .light)
            }
            .id(tool.requestId)
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.bottom, DesignSystem.Spacing.xs)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: — Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            Divider()
            if !pendingFiles.isEmpty {
                attachmentChips
            }
            ChatInputBar(
                text: $inputText,
                placeholder: speech.isListening ? "Listening…" : "Message llm-agent",
                canSend: canSend,
                isFocused: $isInputFocused,
                onSend: send
            ) {
                Menu {
                    // No Photo Library / Camera here: `chat.send` carries text attachments only.
                    Button { showFilePicker = true } label: {
                        Label("Files…", systemImage: "doc.text")
                    }
                    .disabled(!connection.supports(HostApiCommand.chatSend.capability))
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 18))
                        .foregroundColor(DesignSystem.Colors.primary)
                        .frame(width: 40, height: 40)
                        .background(DesignSystem.Colors.surfaceSecondary)
                        .clipShape(Circle())
                }
                .accessibilityLabel("Attach a photo or file")
                .disabled(!isConnected)

                Button {
                    toggleVoice()
                    haptic(.medium)
                } label: {
                    Image(systemName: speech.isListening ? "mic.fill" : "mic")
                        .font(.system(size: 18))
                        .foregroundColor(speech.isListening ? DesignSystem.Colors.danger : DesignSystem.Colors.primary)
                        .frame(width: 40, height: 40)
                        .background(DesignSystem.Colors.surfaceSecondary)
                        .clipShape(Circle())
                }
                .accessibilityLabel(speech.isListening ? "Stop dictating" : "Dictate a message")
            }
        }
    }

    /// Horizontal strip of image + file thumbnails above the input bar.
    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                ForEach(Array(pendingFiles.enumerated()), id: \.offset) { idx, file in
                    fileChip(file, index: idx)
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, DesignSystem.Spacing.sm)
        }
    }

    private func fileChip(_ file: ChatFileText, index: Int) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text.fill")
                .font(.system(size: 16))
                .foregroundColor(DesignSystem.Colors.primary)
            Text(file.name)
                .font(DesignSystem.Typography.footnoteFont)
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .lineLimit(1)
            Button { removeFile(at: index); haptic(.light) } label: {
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

    private var canSend: Bool {
        (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingFiles.isEmpty)
            && isConnected
            && connection.supports(HostApiCommand.chatSend.capability)
            && !llmIdeStore.isStreaming   // one question at a time
    }

    // MARK: — Actions

    private func send() {
        guard canSend else { return }
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = pendingFiles
        guard !text.isEmpty || !files.isEmpty else { return }
        dictating = false   // a late final transcript must not repopulate the composer after send
        if speech.isListening { speech.finish() }
        // Refused by the host's limits (a too-large file): keep the composer so the user can remove it.
        guard llmIdeStore.sendLlmideChat(text, files: files) else { return }
        inputText = ""
        pendingFiles = []
        isInputFocused = false
        haptic(.light)
    }

    private func selectProject(_ id: String) {
        guard projectsStore.select(id) else { return }
        haptic(.light)
        // The store's `selectedId` change reloads the transcript (see `onChange`).
    }

    private func removeFile(at index: Int) {
        guard pendingFiles.indices.contains(index) else { return }
        pendingFiles.remove(at: index)
    }

    private func toggleVoice() {
        if speech.isListening {
            speech.finish()
            inputText = speech.transcript
        } else {
            isInputFocused = false
            dictating = true
            speech.start()
        }
    }
}

/// Extracts text on-device from a user-picked file (PDF via PDFKit, plain text
/// via `String(contentsOf:)`). The extracted text — not the binary — is sent in
/// the chat frame, keeping the WebSocket message well under the 8 MiB bridge cap.
enum FileTextExtractor {
    /// Returns `(name, text)` if something extractable was read, else nil.
    /// Text is capped at 50k characters to keep the prompt sane.
    static func extract(from url: URL) -> (name: String, text: String)? {
        let name = url.lastPathComponent
        let ext = url.pathExtension.lowercased()
        // `.fileImporter` hands back a security-scoped URL; claim access while
        // the read happens, then release it.
        let didStart = url.startAccessingSecurityScopedResource()
        defer { if didStart { url.stopAccessingSecurityScopedResource() } }

        if ext == "pdf", let doc = PDFDocument(url: url),
           let text = doc.string, !text.isEmpty {
            return (name, String(text.prefix(50_000)))
        }
        if ["md", "txt", "markdown"].contains(ext),
           let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty {
            return (name, String(text.prefix(50_000)))
        }
        return nil
    }
}
