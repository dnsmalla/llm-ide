import Foundation

/// Single source of truth for secret/token redaction in surfaced text on the
/// Mac side — the Swift counterpart of the extension's `core/redact-secrets.mjs`.
///
/// Provider APIs and `git` sometimes echo a credential back into an error body
/// (e.g. "remote: Bad credentials for ghp_…", "invalid x-api-key: sk-ant-…").
/// `RepoManager.redact` already scrubs the *known* token it injected, but a
/// credential the caller never held — pulled from a remote URL, another env
/// var, or a provider response — would otherwise pass through. Run such text
/// through `SecretRedactor.redact` so any recognized credential shape can't leak
/// into an error message or log.
///
/// The pattern set mirrors `SECRET_PATTERNS` in `core/redact-secrets.mjs`;
/// keep the two in sync.
enum SecretRedactor {
    private static let marker = "[REDACTED]"

    /// Credential shapes, mirroring the extension's `SECRET_PATTERNS`. Anchored
    /// with `\b` where the prefix is fixed-length so we don't over-match; left
    /// open ({10,}/{20,}) where the body length varies.
    private static let patterns: [NSRegularExpression] = {
        // (source, caseInsensitive) — caseInsensitive mirrors the JS `/gi` flag.
        let sources: [(String, Bool)] = [
            (#"\bghp_[A-Za-z0-9]{36}\b"#, false),         // GitHub personal access token (classic)
            (#"\bgithub_pat_[A-Za-z0-9_]{82}\b"#, false), // GitHub fine-grained PAT
            (#"\bxox[abp]-[A-Za-z0-9-]{10,}\b"#, true),   // Slack token
            (#"\bAIza[0-9A-Za-z\-_]{35}\b"#, false),      // Google API key
            (#"\bAKIA[0-9A-Z]{16}\b"#, false),            // AWS access key id
            (#"\bsk-ant-[A-Za-z0-9-]{10,}\b"#, false),    // Anthropic API key
            (#"Bearer\s+[A-Za-z0-9._-]{20,}"#, true),     // Authorization: Bearer <jwt/opaque>
            (#"apiKey=[A-Za-z0-9_-]+"#, true),            // apiKey=<value> in query strings
        ]
        return sources.compactMap { src, ci in
            try? NSRegularExpression(pattern: src, options: ci ? [.caseInsensitive] : [])
        }
    }()

    /// Replace every recognized secret shape in `text` with `[REDACTED]`.
    /// Length is NOT capped here — callers that need a bound apply their own.
    static func redact(_ text: String) -> String {
        var out = text
        for re in patterns {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            out = re.stringByReplacingMatches(in: out, options: [], range: range, withTemplate: marker)
        }
        return out
    }
}
