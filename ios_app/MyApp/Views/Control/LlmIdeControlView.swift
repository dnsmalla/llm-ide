import SwiftUI
import PhotosUI
import UIKit
import PDFKit
import UniformTypeIdentifiers
import SharedProtocol

/// Focused chat with the llm-ide agent, driven from the iPhone. Messages
/// (typed or dictated) go to llm-ide's agent via the Mac agent bridge and the
/// reply streams back here. App/tab/menu controls live on the remote-desktop
/// view instead, so you watch the Mac react on the live screen.
struct LlmIdeControlView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var llmIdeStore: LlmIdeChatStore
    @Environment(\.dismiss) private var dismiss

    @StateObject private var speech = SpeechRecognizer()
    @State private var inputText: String = ""
    @State private var pendingImages: [(data: Data, mediaType: String)] = []   // resized JPEGs, ready to send
    @State private var pendingFiles: [ChatFileText] = []                        // text extracted on-device
    @State private var pickedItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var showFilePicker = false
    @FocusState private var isInputFocused: Bool

    /// Max images per send; the bridge caps a frame at 8 MiB so this keeps us
    /// well under after resize/base64.
    private let maxImages = 4

    private var isConnected: Bool { connection.connectionStatus == .connected }

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
            .navigationTitle("Chat with LLM IDE")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        llmIdeStore.clearLlmIdeChat()
                        haptic(.light)
                    } label: { Image(systemName: "trash") }
                    .disabled(llmIdeStore.llmIdeMessages.isEmpty)
                }
            }
            .onChange(of: speech.transcript) { newValue in
                if speech.isListening { inputText = newValue }
            }
            .onChange(of: speech.errorMessage) { msg in
                if let msg { connection.errorMessage = msg }
            }
            .photosPicker(isPresented: $showPhotoPicker, selection: $pickedItems,
                          maxSelectionCount: maxImages, matching: .images)
            .onChange(of: pickedItems) { items in
                guard !items.isEmpty else { return }
                Task {
                    var loaded: [Data] = []
                    for item in items {
                        if let data = try? await item.loadTransferable(type: Data.self) {
                            loaded.append(data)
                        }
                    }
                    await MainActor.run {
                        var added = 0
                        for data in loaded {
                            guard let ui = UIImage(data: data), let encoded = encodeForUpload(ui) else { continue }
                            appendImage((data: encoded, mediaType: "image/jpeg")); added += 1
                        }
                        if added == 0 { connection.errorMessage = "Couldn't read that image." }
                        pickedItems = []
                    }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    if let encoded = encodeForUpload(image) {
                        appendImage((data: encoded, mediaType: "image/jpeg"))
                    }
                }
                .ignoresSafeArea()
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
                            title: "Ask llm-ide anything",
                            subtitle: "Type or tap the mic to dictate."
                        )
                    }
                    ForEach(llmIdeStore.llmIdeMessages) { msg in
                        ChatBubble(message: msg).id(msg.id)
                    }
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: llmIdeStore.llmIdeMessages.last?.text) { _ in
                if let last = llmIdeStore.llmIdeMessages.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: — Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            Divider()
            if !pendingImages.isEmpty || !pendingFiles.isEmpty {
                attachmentChips
            }
            ChatInputBar(
                text: $inputText,
                placeholder: speech.isListening ? "Listening…" : "Message llm-ide",
                canSend: canSend,
                isFocused: $isInputFocused,
                onSend: send
            ) {
                Menu {
                    Button { showPhotoPicker = true } label: {
                        Label("Photo Library", systemImage: "photo.on.rectangle")
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showCamera = true } label: {
                            Label("Camera", systemImage: "camera")
                        }
                    }
                    Button { showFilePicker = true } label: {
                        Label("Files…", systemImage: "doc.text")
                    }
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 18))
                        .foregroundColor(DesignSystem.Colors.primary)
                        .frame(width: 40, height: 40)
                        .background(DesignSystem.Colors.surfaceSecondary)
                        .clipShape(Circle())
                }
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
            }
        }
    }

    /// Horizontal strip of image + file thumbnails above the input bar.
    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                ForEach(Array(pendingImages.enumerated()), id: \.offset) { idx, img in
                    if let ui = UIImage(data: img.data) {
                        imageChip(ui, index: idx)
                    }
                }
                ForEach(Array(pendingFiles.enumerated()), id: \.offset) { idx, file in
                    fileChip(file, index: idx)
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, DesignSystem.Spacing.sm)
        }
    }

    private func imageChip(_ ui: UIImage, index: Int) -> some View {
        HStack(spacing: 6) {
            Image(uiImage: ui)
                .resizable().scaledToFill()
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            Button { removeImage(at: index); haptic(.light) } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
        .padding(4)
        .background(DesignSystem.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func fileChip(_ file: ChatFileText, index: Int) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text.fill")
                .font(.system(size: 16))
                .foregroundColor(DesignSystem.Colors.primary)
            Text(file.name)
                .font(.system(size: DesignSystem.Typography.footnote))
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
            || !pendingImages.isEmpty
            || !pendingFiles.isEmpty)
            && isConnected
            && !llmIdeStore.isStreaming   // one question at a time
    }

    // MARK: — Actions

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
        let files = pendingFiles
        guard !text.isEmpty || !images.isEmpty || !files.isEmpty else { return }
        if speech.isListening { speech.finish() }
        llmIdeStore.sendLlmideChat(text, images: images, files: files)
        inputText = ""
        pendingImages = []
        pendingFiles = []
        isInputFocused = false
        haptic(.light)
    }

    private func appendImage(_ img: (data: Data, mediaType: String)) {
        if pendingImages.count >= maxImages {
            connection.errorMessage = "Up to \(maxImages) images at a time."
            return
        }
        pendingImages.append(img)
    }

    private func removeImage(at index: Int) {
        guard pendingImages.indices.contains(index) else { return }
        pendingImages.remove(at: index)
    }

    private func removeFile(at index: Int) {
        guard pendingFiles.indices.contains(index) else { return }
        pendingFiles.remove(at: index)
    }

    /// Downscale to a sane max dimension and JPEG-encode, keeping the upload
    /// small (and within the server's per-image cap).
    private func encodeForUpload(_ image: UIImage, maxDimension: CGFloat = 1280) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, maxDimension / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: 0.7)
    }

    private func toggleVoice() {
        if speech.isListening {
            speech.finish()
            inputText = speech.transcript
        } else {
            isInputFocused = false
            speech.start()
        }
    }
}

/// Thin wrapper over UIImagePickerController for taking a photo with the camera.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
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
