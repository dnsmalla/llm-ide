import Foundation
import LlmIdeMacLib

func runSelfHealCoreChecks() {
    print("self-heal: core")

    // Redaction
    let home = "/Users/alice"
    let secret = "token=abc123 key sk-ant-REDACTMEREDACTME0123 mail bob@example.com at /Users/alice/x.swift"
    let red = IncidentRedactor.redact(secret, limit: 2000, home: home)
    expect(!red.contains("abc123"), "redactor masks key=value secrets")
    expect(!red.contains("sk-ant-"), "redactor reuses SecretRedactor's credential shapes")
    expect(!red.contains("bob@example.com") && red.contains("[EMAIL]"), "redactor masks email addresses")
    expect(red.contains("~/x.swift") && !red.contains("/Users/alice"), "redactor replaces the home directory with ~")
    let long = String(repeating: "a", count: 5000)
    let cut = IncidentRedactor.redact(long, limit: 2000, home: home)
    expect(cut.count <= 2000 + 20 && cut.hasSuffix("…[truncated]"), "redactor truncates to the limit with a marker")

    // Signature
    let a = IncidentSignature.normalize("Failed to load 3 files from /Users/a/p/x.json (id 7F3C2A1B-1111-2222-3333-444455556666) \"quoted\"")
    let b = IncidentSignature.normalize("Failed to load 12 files from /tmp/q.json (id 00000000-AAAA-BBBB-CCCC-DDDDEEEEFFFF) \"other\"")
    expect(a == b, "normalize strips numbers, paths, UUIDs and quoted strings")
    expect(IncidentSignature.normalize("hash deadbeef00 here") == "hash <hex> here", "normalize replaces long hex")
    expect(IncidentSignature.normalize("a   b\n\tc") == "a b c", "normalize collapses whitespace")
    expect(IncidentSignature.normalizeEndpoint("/kb/sessions/123/turns?x=1") == "/kb/sessions/:id/turns",
           "endpoint normalization drops the query and id-like segments")
    let s1 = IncidentSignature.make(source: "log", category: "API", message: "HTTP 500 on try 1", stack: nil)
    let s2 = IncidentSignature.make(source: "log", category: "API", message: "HTTP 500 on try 2", stack: nil)
    let s3 = IncidentSignature.make(source: "ui", category: "API", message: "HTTP 500 on try 2", stack: nil)
    expect(s1 == s2 && s1.count == 16, "same normalized message ⇒ same 16-hex signature")
    expect(s1 != s3, "a different source ⇒ a different signature")
    let stack = "Error: boom\n    at foo (node:internal/x:1:2)\n    at bar (/Users/a/llm-ide/extension/routes/x.mjs:40:7)"
    expect(IncidentSignature.topOwnFrame(stack)?.contains("extension/routes/x.mjs") == true,
           "topOwnFrame picks the first frame inside the project")

    // Classifier
    expect(IncidentClassifier.environmentalReason(message: "The Internet connection appears to be offline.") == "offline",
           "offline is environmental")
    expect(IncidentClassifier.environmentalReason(message: "HTTP 401 Unauthorized") == "auth", "401 is environmental")
    expect(IncidentClassifier.environmentalReason(message: "Operation not permitted") == "permission", "EPERM is environmental")
    expect(IncidentClassifier.environmentalReason(message: "write failed: No space left on device") == "disk", "ENOSPC is environmental")
    expect(IncidentClassifier.environmentalReason(message: "Request was cancelled") == "cancelled", "user cancel is environmental")
    expect(IncidentClassifier.environmentalReason(message: "The request timed out.") == "offline", "a URLError-style timeout is environmental")
    expect(IncidentClassifier.environmentalReason(message: "git status timed out after 30s — possible deadlock") == nil,
           "an internal timeout is a code bug, not environmental")
    expect(IncidentClassifier.environmentalReason(message: "operation cancelled: fatal assertion in diff parser") == nil,
           "an internal cancellation wording is a code bug, not environmental")
    expect(IncidentClassifier.environmentalReason(message: "Usage: /model <name>") == "usage", "slash-command usage text is not a bug")
    expect(IncidentClassifier.environmentalReason(message: "Index out of range in ChatEngine.swift") == nil,
           "a code bug is not environmental")
}
