# iOS↔Mac Native Link — Phase 4: Rich Chat Input

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Context (post-pivot):** The iPhone is a native companion client for the Mac app's explorer chat — NOT a remote desktop. Old Phase 4 (Mac screen capture) and Phase 5 (input injection) are CANCELLED. This is the new Phase 4.

**Goal:** From the iPhone, send **text (incl. voice transcribed to text on-device), images, and files (PDF / `.md` / `.txt`)** into the explorer chat; the Mac proxies to `:3456` (`/kb/agent/ask`) and the agent's reply streams back. "Text + image + file send to Mac" must work end-to-end.

**Architecture:** `LlmIdeChat` is extended from a single `image` to `images: [ChatImage]` (multi) + `files: [ChatFileText]` where **files carry extracted TEXT, not binary** — extracted on-device (PDFKit for PDF, `String(contentsOf:)` for `.md`/`.txt`). This sidesteps the iPhone→Mac WebSocket 1 MiB frame cap (raised to 8 MiB for multi-image headroom anyway) and needs no PDF library in the backend. The Mac folds `files` text into the agent prompt (exactly as `history` is folded today) and passes `images[]` through — the backend's `/kb/agent/ask` already accepts an `image` array (`parseAskImages`) and a text prompt, so **no backend code change** is required.

**Tech Stack:** Swift (macOS 14 / iOS 16), SharedProtocol SPM, PDFKit (iOS, system framework), XCTest.

**Continues from:** Phase 3 (commit `04e66cb` on `main`). The chat channel (`LlmIdeChat`/`Output`/`askAgent`/`handleChat`) exists; voice→text (`SpeechRecognizer`) is already wired into `LlmIdeControlView`.

## Global Constraints

(Verbatim values every task inherits.)
- `LlmIdeChat` new shape: `{type="llmide_chat", commandId, text, history:[ChatTurn], images:[ChatImage], files:[ChatFileText]}`. The old single `image: ChatImage?` is REMOVED (migrate both Mac + iOS). `images` defaults to `[]`; `files` defaults to `[]` so a text-only chat still encodes them.
- `ChatFileText = {name: String, text: String}` (extracted text; NOT base64 binary).
- WebSocket `maximumMessageSize` raised from `1_048_576` to `8_388_608` (8 MiB) — matches the `:3456` HTTP body cap; acceptable on a PIN-paired LAN socket.
- Images: each resized on-device to ≤1280 px JPEG 0.7 (existing `encodeForUpload`); cap at 4 (matches the backend `parseAskImages` cap).
- Voice → text on-device only (`SpeechRecognizer`, `requiresOnDeviceRecognition = true`); no audio crosses the wire.
- Backend (`extension/`) gets NO code change.
- Mac target: `@MainActor`; `swift-tools-version: 6.0`, `swiftLanguageModes: [.v5]` unchanged.
- Conventional Commits; one concern per commit; do not push.

## File Structure

**SharedProtocol (`ios_app/SharedProtocol`)**
- Modify `Sources/SharedProtocol/MobileProtocol.swift` — add `ChatFileText`; change `LlmIdeChat.image` → `images:[ChatImage]` + `files:[ChatFileText]`.
- Modify `Tests/SharedProtocolTests/ConnectionMessagesTests.swift` — update existing `LlmIdeChat` tests + add file/multi-image cases.

**Mac**
- Modify `mac/Sources/LlmIdeMac/Services/MobileWebSocketServer.swift:41` — `maximumMessageSize = 8_388_608`.
- Modify `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Agent.swift` — `askAgent` takes `images: [ChatImage]` (was single `image`), sends `image:` as a JSON array.
- Modify `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` — `handleChat` folds `chat.files` text into the message + passes `chat.images`.

**iOS**
- Modify `ios_app/MyApp/Services/ControlService.swift` — `sendLlmideChat` builds the new `LlmIdeChat` (images[] + files[]).
- Modify `ios_app/MyApp/Views/Control/LlmIdeControlView.swift` — add a "Files" entry to the paperclip menu (`.fileImporter` for PDF + plain-text); on-device text extraction; multi-image; file/image chips.

---

## Task 1: SharedProtocol — extend `LlmIdeChat` (TDD)

**Files:**
- Modify `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/ConnectionMessagesTests.swift`

**Interfaces:**
- Produces: `ChatFileText{name:String, text:String}`; `LlmIdeChat` now `images:[ChatImage]` + `files:[ChatFileText]` (no `image`).

- [ ] **Step 1: Update tests** — fix the two existing `LlmIdeChat` tests to the new shape and add a files/multi-image case. Replace their `image:` arg with `images:`/`files:`:

```swift
    func testLlmIdeChatRoundTrips() throws {
        let chat = LlmIdeChat(commandId: "abc", text: "hello",
                              history: [ChatTurn(role: "user", content: "hi")],
                              images: [ChatImage(mediaType: "image/png", data: "B64")],
                              files: [ChatFileText(name: "notes.md", text: "# hi")])
        let decoded = try roundTrip(chat)
        XCTAssertEqual(decoded, chat)
        XCTAssertEqual(decoded.type, "llmide_chat")
        XCTAssertEqual(decoded.images.count, 1)
        XCTAssertEqual(decoded.files.first?.name, "notes.md")
    }

    func testLlmIdeChatTextOnlyRoundTrips() throws {
        let chat = LlmIdeChat(commandId: "x", text: "q", history: [], images: [], files: [])
        let decoded = try roundTrip(chat)
        XCTAssertEqual(decoded, chat)
        XCTAssertTrue(decoded.images.isEmpty)
        XCTAssertTrue(decoded.files.isEmpty)
    }
```
(Remove/replace the old `testLlmIdeChatNoImageRoundTrips` if it referenced the removed `image:` field.)

- [ ] **Step 2: Run → FAIL** (`cannot find 'ChatFileText'` / `image` removed).
- [ ] **Step 3: Implement** — add `ChatFileText` and rewrite `LlmIdeChat`:

```swift
public struct ChatFileText: Codable, Equatable {
    public let name: String
    public let text: String
    public init(name: String, text: String) { self.name = name; self.text = text }
}

/// Client → server: ask the llm-ide agent a question. Images are base64; files
/// carry text extracted on-device (not binary) to stay under the WS frame cap.
public struct LlmIdeChat: Codable, Equatable {
    public let type = "llmide_chat"
    public let commandId: String
    public let text: String
    public let history: [ChatTurn]
    public let images: [ChatImage]
    public let files: [ChatFileText]
    public init(commandId: String, text: String, history: [ChatTurn],
                images: [ChatImage] = [], files: [ChatFileText] = []) {
        self.commandId = commandId; self.text = text; self.history = history
        self.images = images; self.files = files
    }
}
```
(Update the file's existing explicit `CodingKeys` for `LlmIdeChat` to `type, commandId, text, history, images, files`.)

- [ ] **Step 4: Run → PASS** (`cd ios_app/SharedProtocol && swift test`; expect the prior 12, updated).
- [ ] **Step 5: Commit** `feat(shared-protocol): LlmIdeChat carries multiple images + file text`.

---

## Task 2: Mac — raise WS cap + forward images[]/files

**Files:**
- Modify `mac/Sources/LlmIdeMac/Services/MobileWebSocketServer.swift` (line 41)
- Modify `mac/Sources/LlmIdeAPIClient+Agent.swift`? → actually `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Agent.swift`
- Modify `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` (`handleChat`)

**Interfaces:**
- Produces: `askAgent(message:history:images:)` (images array); `handleChat` folds file text into the message.

- [ ] **Step 1: Raise the WS cap** — `MobileWebSocketServer.swift:41`:
```swift
opts.maximumMessageSize = 8_388_608   // 8 MiB — matches the :3456 body cap; paired-LAN only
```

- [ ] **Step 2: `askAgent` → images array** — in `LlmIdeAPIClient+Agent.swift`, change the signature + body:
```swift
func askAgent(message: String, history: [AgentAskMessage] = [],
              images: [(mediaType: String, data: String)] = []) async throws -> String {
    struct WireMsg: Encodable { let role: String; let content: String }
    struct WireImage: Encodable { let mediaType: String; let data: String }
    struct Req: Encodable { let message: String; let history: [WireMsg]; let image: [WireImage] }
    struct Resp: Decodable { let reply: String }
    let wireHistory = history.map { WireMsg(role: $0.role.rawValue, content: $0.content) }
    let wireImages = images.map { WireImage(mediaType: $0.mediaType, data: $0.data) }
    let r: Resp = try await post("/kb/agent/ask",
                                 body: Req(message: message, history: wireHistory, image: wireImages),
                                 authenticated: true)
    return r.reply
}
```
(The backend's `parseAskImages` accepts the `image` field as single-or-array, so an array works unchanged.)

- [ ] **Step 3: `handleChat` folds files + passes images** — in `MobileControlManager.swift`, update `handleChat`:
```swift
private func handleChat(_ chat: LlmIdeChat) async {
    guard let api else {
        await server?.send(CommandError(commandId: chat.commandId, message: "Backend not configured")); return
    }
    let history = chat.history.map { LlmIdeAPIClient.AgentAskMessage(role: .init(rawValue: $0.role) ?? .user, content: $0.content) }
    let images = chat.images.map { (mediaType: $0.mediaType, data: $0.data) }
    // Fold extracted file text into the prompt (mirrors how history is folded server-side).
    let message = Self.messageWithFiles(chat.text, files: chat.files)
    do {
        let reply = try await api.askAgent(message: message, history: history, images: images)
        await server?.send(Output(commandId: chat.commandId, payload: OutputPayload(stream: reply, done: true)))
    } catch {
        append(.stderr, "askAgent failed: \(error.localizedDescription)"); lastError = error.localizedDescription
        await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
    }
}

private static func messageWithFiles(_ text: String, files: [ChatFileText]) -> String {
    guard !files.isEmpty else { return text }
    let blocks = files.map { "--- File: \($0.name) ---\n\($0.text)" }.joined(separator: "\n\n")
    return "\(blocks)\n\n\(text)"
}
```
(Adapt to the real `server`/`append`/`lastError` names in the file. `import SharedProtocol` is present.)

- [ ] **Step 4: Verify** — `cd mac && swift build` → BUILD SUCCEEDED, 0 warnings.
- [ ] **Step 5: Commit** `feat(mac): forward multi-image + file text in chat (8 MiB WS cap)`.

---

## Task 3: iOS — file picker + on-device text extraction + multi-image

**Files:**
- Modify `ios_app/MyApp/Services/ControlService.swift` (`sendLlmideChat`)
- Modify `ios_app/MyApp/Views/Control/LlmIdeControlView.swift` (paperclip menu, extraction, chips)

**Interfaces:**
- Produces: `sendLlmideChat(_:images:files:)`; on-device PDF/`.md`/`.txt` text extraction; multi-image picker.

- [ ] **Step 1: `sendLlmideChat` new signature** — `ControlService.swift`:
```swift
func sendLlmideChat(_ text: String,
                    images: [(data: Data, mediaType: String)] = [],
                    files: [ChatFileText] = []) {
    guard targetDevice != nil, connectionStatus == .connected else { return }
    let history = llmIdeMessages.suffix(10).compactMap { m -> ChatTurn? in
        guard !m.text.isEmpty else { return nil }
        return ChatTurn(role: m.role == .assistant ? "assistant" : "user", content: m.text)
    }
    llmIdeMessages.append(ChatMessage(role: .user, text: text))
    llmIdeMessages.append(ChatMessage(role: .assistant, text: ""))
    llmStreaming = true
    let id = UUID().uuidString
    llmIdeCommandIds.insert(id)
    let chatImages = images.map { ChatImage(mediaType: $0.mediaType, data: $0.data.base64EncodedString()) }
    let chat = LlmIdeChat(commandId: id, text: text, history: history, images: chatImages, files: files)
    if let data = try? JSONEncoder().encode(chat), let str = String(data: data, encoding: .utf8) {
        sendTextFrame(str)
    } else {
        errorMessage = "Failed to encode chat message"; disconnect(clearDirect: true)
    }
}
```
(Adapt to the real `ChatMessage`/`disconnect` signatures. Drop the old `image:` single param.)

- [ ] **Step 2: On-device file text extraction** — add a helper (in `LlmIdeControlView.swift` or a small new `FileTextExtractor.swift`):
```swift
import PDFKit

enum FileTextExtractor {
    /// Extracts text from a PDF/.md/.txt file URL. Returns nil if nothing extractable.
    static func extract(from url: URL) -> (name: String, text: String)? {
        let name = url.lastPathComponent
        let ext = url.pathExtension.lowercased()
        if ext == "pdf", let doc = PDFDocument(url: url), let text = doc.string, !text.isEmpty {
            return (name, String(text.prefix(50_000)))   // cap to keep the prompt sane
        }
        if ["md", "txt", "markdown"].contains(ext),
           let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty {
            return (name, String(text.prefix(50_000)))
        }
        return nil
    }
}
```
(`.fileImporter` returns a security-scoped URL; if access needs `startAccessingSecurityScopedResource()`, add it around the read.)

- [ ] **Step 3: Wire the paperclip menu + multi-image** — in `LlmIdeControlView.swift`:
- Add `@State private var showFilePicker = false` and `@State private var pendingFiles: [ChatFileText] = []` (+ a `pendingImages: [(data, mediaType)]` array if migrating from single `pendingImageData`).
- Add a "Files…" `Button` to the paperclip `Menu` → sets `showFilePicker = true`.
- Add `.fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.pdf, .plainText, .text]) { result in … }` → on success, call `FileTextExtractor.extract(from:)` → append to `pendingFiles`; show a file chip (mirror `imagePreview`).
- Update the photo picker to allow multiple (cap 4) → append to `pendingImages`; keep the existing ≤1280px resize.
- `send()` calls `controlService.sendLlmideChat(inputText, images: pendingImages, files: pendingFiles)`, then clears both + `inputText`.

- [ ] **Step 4: Verify** — `cd ios_app && xcodebuild -project MyApp.xcodeproj -scheme MyApp -destination 'generic/platform=iOS Simulator' -configuration Debug build CODE_SIGNING_ALLOWED=NO` → `** BUILD SUCCEEDED **`. (If `import PDFKit` needs the framework, it's a system framework on iOS 16 — no dep.)
- [ ] **Step 5: Commit** `feat(ios): attach files (on-device text) + multi-image to chat`.

---

## Task 4: Verify + docs

- [ ] **Step 1: Full gate** — `swift test` (SharedProtocol, updated count), `cd mac && swift build`, iOS `xcodebuild` — all green.
- [ ] **Step 2: Manual check** (documented; needs paired phone + backend login): from the iOS chat sheet, (a) type + send → reply; (b) attach a `.md`/`.txt` → reply references the file content; (c) attach a text PDF → reply references it; (d) mic → transcribes to text → send; (e) 2 images → reply. Confirm the Mac log shows the chat dispatch and no `CommandError` unless the backend is down.
- [ ] **Step 3: Docs** — append a "Rich input" note to `docs/mobile/quick-start.md` (text, voice→text, images, PDF/`.md`/`.txt` attachments).
- [ ] **Step 4: Commit** `docs: note Phase 4 rich chat input`.

---

## Phase 4 Done — Definition of Done

- [ ] SharedProtocol: `LlmIdeChat` carries `images[]` + `files[]` (`ChatFileText`); tests green.
- [ ] Mac: WS cap 8 MiB; `askAgent` takes `images[]`; `handleChat` folds file text into the prompt. `swift build` green.
- [ ] iOS: file picker (PDF/`.md`/`.txt`) with on-device text extraction; multi-image; `sendLlmideChat` new shape. iOS sim build green.
- [ ] Backend (`extension/`): NO change.
- [ ] End-to-end: text + voice→text + image(s) + file → Mac → `:3456` → reply.

## Follow-on

- Native iOS **explorer-chat** view (Mac exposes explorer-chat history) + native **auto-task** view (Mac exposes auto-task list/state/actions). Then polish (color palette, port-busy guard). Scanned/image-only PDFs (no text layer) are a known limitation — future OCR if needed.
