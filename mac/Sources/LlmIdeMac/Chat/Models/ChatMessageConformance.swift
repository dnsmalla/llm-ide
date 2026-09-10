import Foundation

/// The narrow public surface `chat-contract-lab` needs to pin `ChatMessage`'s
/// persisted schema.
///
/// `ChatMessage` and its nested types stay internal: they are the app's own
/// model, and this toolchain has no XCTest, so a separate executable target is
/// the only place assertions can run (see `ChatStreamBuffer`). Exposing two
/// functions is cheaper than making the whole model public.
///
/// What this guards is a real migration hazard: `ToolStep` is written into
/// `~/Library/Application Support/llm-ide/sessions/<uuid>.json`, so a field
/// added today must not stop yesterday's file from loading.
public enum ChatMessageConformance {
    /// Whether a persisted `ToolStep` payload decodes at all.
    public static func decodesToolStep(_ data: Data) -> Bool {
        (try? JSONDecoder().decode(ChatMessage.ToolStep.self, from: data)) != nil
    }

    /// Which of the v2-only fields survived decoding, sorted. Empty for a step
    /// written before they existed — the point being that they decode as `nil`
    /// rather than as empty strings.
    public static func toolStepFields(forJSON data: Data) -> [String]? {
        guard let step = try? JSONDecoder().decode(ChatMessage.ToolStep.self, from: data) else { return nil }
        var names: [String] = []
        if step.args != nil { names.append("args") }
        if step.resultText != nil { names.append("resultText") }
        if step.isError != nil { names.append("isError") }
        return names.sorted()
    }
}
