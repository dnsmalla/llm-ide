import SwiftUI
import PhotosUI
import UIKit

/// Focused chat with the llm-ide agent, driven from the iPhone. Messages
/// (typed or dictated) go to llm-ide's agent via the Mac agent bridge and the
/// reply streams back here. App/tab/menu controls live on the remote-desktop
/// view instead, so you watch the Mac react on the live screen.
struct LlmIdeControlView: View {
    @EnvironmentObject var controlService: ControlService
    @Environment(\.dismiss) private var dismiss

    @StateObject private var speech = SpeechRecognizer()
    @State private var inputText: String = ""
    @State private var pendingImageData: Data?      // resized JPEG, ready to send
    @State private var pickedItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @FocusState private var isInputFocused: Bool

    private var isConnected: Bool { controlService.connectionStatus == .connected }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !isConnected { connectionBanner }
                if let err = controlService.errorMessage { errorBanner(err) }
                chatTranscript
                inputBar
            }
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .animation(.easeInOut(duration: 0.2), value: isConnected)
            .animation(.easeInOut(duration: 0.2), value: controlService.errorMessage)
            .navigationTitle("Chat with LLM IDE")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        controlService.clearLlmIdeChat()
                        haptic(.light)
                    } label: { Image(systemName: "trash") }
                    .disabled(controlService.llmIdeMessages.isEmpty)
                }
            }
            .onChange(of: speech.transcript) { newValue in
                if speech.isListening { inputText = newValue }
            }
            .onChange(of: speech.errorMessage) { msg in
                if let msg { controlService.errorMessage = msg }
            }
            .photosPicker(isPresented: $showPhotoPicker, selection: $pickedItem, matching: .images)
            .onChange(of: pickedItem) { item in
                guard let item else { return }
                Task {
                    let data = try? await item.loadTransferable(type: Data.self)
                    let encoded = data.flatMap { UIImage(data: $0) }.flatMap { encodeForUpload($0) }
                    await MainActor.run {
                        if let encoded { pendingImageData = encoded }
                        else { controlService.errorMessage = "Couldn't read that image." }
                        pickedItem = nil
                    }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    if let encoded = encodeForUpload(image) { pendingImageData = encoded }
                }
                .ignoresSafeArea()
            }
            .onDisappear { speech.cancel() }
        }
    }

    private var connectionBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash").font(.system(size: 13))
            Text(controlService.connectionStatus == .connecting
                 ? "Connecting to your Mac…" : "Not connected to your Mac")
                .font(.system(size: DesignSystem.Typography.footnote, weight: .medium))
            Spacer()
        }
        .foregroundColor(.white)
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.vertical, 8)
        .background(DesignSystem.Colors.textTertiary)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundColor(DesignSystem.Colors.danger)
            Text(message)
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button { controlService.errorMessage = nil } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.vertical, 8)
        .background(DesignSystem.Colors.danger.opacity(0.12))
    }

    // MARK: — Chat transcript

    private var chatTranscript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: DesignSystem.Spacing.sm) {
                    if controlService.llmIdeMessages.isEmpty {
                        emptyState
                    }
                    ForEach(controlService.llmIdeMessages) { msg in
                        bubble(msg).id(msg.id)
                    }
                }
                .padding(DesignSystem.Spacing.md)
            }
            .onChange(of: controlService.llmIdeMessages.last?.text) { _ in
                if let last = controlService.llmIdeMessages.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 34))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text("Ask llm-ide anything")
                .font(.system(size: DesignSystem.Typography.callout, weight: .medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Text("Type or tap the mic to dictate.")
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    @ViewBuilder
    private func bubble(_ msg: ChatMessage) -> some View {
        let isUser = msg.role == .user
        let isThinking = !isUser && msg.text.isEmpty
        HStack {
            if isUser { Spacer(minLength: 40) }
            Group {
                if isThinking {
                    HStack(spacing: 8) {
                        ProgressView().scaleEffect(0.8)
                        Text("Thinking…")
                            .font(.system(size: DesignSystem.Typography.body))
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                    }
                } else {
                    VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                        if let data = msg.imageData, let ui = UIImage(data: data) {
                            Image(uiImage: ui)
                                .resizable().scaledToFit()
                                .frame(maxWidth: 200, maxHeight: 200)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        if !msg.text.isEmpty {
                            Text(msg.text)
                                .font(.system(size: DesignSystem.Typography.body))
                                .foregroundColor(isUser ? .white : DesignSystem.Colors.textPrimary)
                        }
                    }
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 10)
            .background(isUser ? DesignSystem.Colors.primary : DesignSystem.Colors.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
                    .stroke(isUser ? Color.clear : DesignSystem.Colors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
            if !isUser { Spacer(minLength: 40) }
        }
    }

    // MARK: — Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            Divider()
            if let data = pendingImageData, let ui = UIImage(data: data) {
                imagePreview(ui)
            }
            HStack(spacing: DesignSystem.Spacing.sm) {
                Menu {
                    Button { showPhotoPicker = true } label: {
                        Label("Photo Library", systemImage: "photo.on.rectangle")
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showCamera = true } label: {
                            Label("Camera", systemImage: "camera")
                        }
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

                TextField(speech.isListening ? "Listening…" : "Message llm-ide", text: $inputText, axis: .vertical)
                    .font(.system(size: DesignSystem.Typography.body))
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused($isInputFocused)
                    .padding(.horizontal, DesignSystem.Spacing.md)
                    .padding(.vertical, 10)
                    .background(DesignSystem.Colors.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL)
                            .stroke(DesignSystem.Colors.border, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusL))
                    .onSubmit(send)

                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundColor(canSend ? DesignSystem.Colors.primary : DesignSystem.Colors.textTertiary)
                }
                .disabled(!canSend)
            }
            .padding(DesignSystem.Spacing.md)
            .background(DesignSystem.Colors.surfaceSecondary)
        }
    }

    private func imagePreview(_ ui: UIImage) -> some View {
        HStack(spacing: DesignSystem.Spacing.sm) {
            Image(uiImage: ui)
                .resizable().scaledToFill()
                .frame(width: 48, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            Text("Image attached")
                .font(.system(size: DesignSystem.Typography.footnote))
                .foregroundColor(DesignSystem.Colors.textSecondary)
            Spacer()
            Button { pendingImageData = nil; haptic(.light) } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        }
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.top, DesignSystem.Spacing.sm)
    }

    private var canSend: Bool {
        (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pendingImageData != nil)
            && isConnected
            && !controlService.llmStreaming   // one question at a time
    }

    // MARK: — Actions

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageData = pendingImageData
        guard !text.isEmpty || imageData != nil else { return }
        if speech.isListening { speech.finish() }
        if let imageData {
            controlService.sendLlmideChat(text, image: (data: imageData, mediaType: "image/jpeg"))
        } else {
            controlService.sendLlmideChat(text)
        }
        inputText = ""
        pendingImageData = nil
        isInputFocused = false
        haptic(.light)
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

    private func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
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
