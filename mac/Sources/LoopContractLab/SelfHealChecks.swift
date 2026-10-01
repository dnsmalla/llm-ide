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

    // Incident store
    MainActor.assumeIsolated {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("selfheal-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("incidents.json")
        func draft(_ msg: String, at date: Date = Date()) -> Incident {
            Incident(id: IncidentSignature.make(source: "log", category: "t", message: msg, stack: nil),
                     source: .log, category: "t", message: msg, stack: nil, firstSeen: date, lastSeen: date)
        }

        let store = IncidentStore(fileURL: file)
        for _ in 0..<1000 { store.upsert(draft("storm")) }
        expect(store.incidents.count == 1 && store.incidents[0].count == 1000, "an error storm stays one incident")
        store.flush()
        let reloaded = IncidentStore(fileURL: file)
        expect(reloaded.incidents.first?.count == 1000, "flush persists and a new store reloads it")

        // Debounce timing: saveDelay short enough to observe within a RunLoop spin,
        // long enough that 1,000 synchronous upserts land inside one debounce window.
        let stormStore = IncidentStore(fileURL: dir.appendingPathComponent("storm.json"), saveDelay: .milliseconds(50))
        for _ in 0..<1000 { stormStore.upsert(draft("storm")) }
        expect(stormStore.incidents.count == 1 && stormStore.incidents[0].count == 1000, "a debounced storm stays one incident")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        expect(stormStore.saveCount == 1, "an error storm is saved once, not once per event")
        for _ in 0..<1000 { stormStore.upsert(draft("storm")) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        expect(stormStore.saveCount == 2, "the next burst is debounced again")

        let p = draft("proposed one")
        store.upsert(p)
        store.update(id: p.id) { $0.status = .proposed }
        store.upsert(draft("proposed one"))
        expect(store.incidents.first { $0.id == p.id }?.status == .proposed, "a proposed incident recurring stays proposed")
        store.update(id: p.id) { $0.status = .fixed }
        store.upsert(draft("proposed one"))
        let reopened = store.incidents.first { $0.id == p.id }
        expect(reopened?.status == .new && reopened?.attempts == 1, "a fixed incident recurring reopens with an attempt")

        let capStore = IncidentStore(fileURL: dir.appendingPathComponent("cap.json"))
        let old = draft("keep me fixing", at: Date(timeIntervalSince1970: 0))
        capStore.upsert(old)
        capStore.update(id: old.id) { $0.status = .fixing }
        for i in 0..<IncidentStore.cap + 5 {
            capStore.upsert(draft("filler \(String(repeating: "x", count: i + 1))", at: Date(timeIntervalSince1970: Double(i + 1))))
        }
        expect(capStore.incidents.count == IncidentStore.cap, "the store is capped")
        expect(capStore.incidents.contains { $0.id == old.id }, "eviction never drops a fixing incident")

        try? "{not json".write(to: dir.appendingPathComponent("bad.json"), atomically: true, encoding: .utf8)
        let recovered = IncidentStore(fileURL: dir.appendingPathComponent("bad.json"))
        let archived = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.contains { $0.hasPrefix("bad.json.corrupt-") } == true
        expect(recovered.incidents.isEmpty && archived, "a corrupt file is archived and the store starts empty")

        let triage = IncidentStore(fileURL: dir.appendingPathComponent("t.json"))
        let few = draft("few"); triage.upsert(few)
        let many = draft("many"); for _ in 0..<3 { triage.upsert(many) }
        let done = draft("done"); triage.upsert(done); triage.update(id: done.id) { $0.status = .ignored }
        expect(triage.candidatesForTriage().map(\.id) == [many.id, few.id], "triage candidates are new incidents, most frequent first")
        try? FileManager.default.removeItem(at: dir)
    }

    // AppSourceRoot: the plist value is the mac/ dir; the git root is its parent.
    let existing: Set<String> = ["/r/llm-ide/mac/Package.swift", "/r/llm-ide/.git"]
    expect(AppSourceRoot.gitRoot(plistValue: "/r/llm-ide/mac", fileExists: existing.contains)?.path == "/r/llm-ide",
           "source root resolves to the parent of the mac/ dir")
    expect(AppSourceRoot.gitRoot(plistValue: nil, fileExists: existing.contains) == nil, "a release build has no source root")
    expect(AppSourceRoot.gitRoot(plistValue: "/r/other/mac", fileExists: existing.contains) == nil,
           "a plist value without Package.swift is rejected")

    // SelfHealSettings
    let suite = "selfheal-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: suite)!
    expect(SelfHealSettings.isEnabled(d) && SelfHealSettings.maxPerRun(d) == 5, "settings default to on and 5 per run")
    d.set(99, forKey: SelfHealSettings.maxPerRunKey)
    expect(SelfHealSettings.maxPerRun(d) == 20, "maxPerRun is clamped to 20")
    d.removePersistentDomain(forName: suite)

    // Recorder
    MainActor.assumeIsolated {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("rec-\(UUID().uuidString).json")
        let store = IncidentStore(fileURL: file)
        IncidentRecorder.record(source: .log, category: "API", message: "token=abc boom 1", stack: nil,
                                at: Date(), into: store, eligible: true)
        expect(store.incidents.count == 1 && !store.incidents[0].message.contains("abc"),
               "the recorder redacts before storing")
        IncidentRecorder.record(source: .log, category: "API", message: "other", stack: nil,
                                at: Date(), into: store, eligible: false)
        expect(store.incidents.count == 1, "nothing is recorded when ineligible")
        let token = IncidentRecorder.beginSuppression()
        let during = Date()
        IncidentRecorder.record(source: .log, category: "API", message: "during self-heal", stack: nil,
                                at: during, into: store, eligible: true)
        IncidentRecorder.endSuppression(token)
        expect(store.incidents.count == 1, "nothing is recorded while a Self-Heal run is active")
        IncidentRecorder.record(source: .log, category: "API", message: "late log line from the run", stack: nil,
                                at: during, into: store, eligible: true)
        expect(store.incidents.count == 1, "a log line timestamped inside a suppression window is dropped later too")

        let staleToken = IncidentRecorder.beginSuppression()
        IncidentRecorder.record(source: .log, category: "API", message: "after an unended window expires",
                                stack: nil, at: Date().addingTimeInterval(5 * 3600), into: store, eligible: true)
        expect(store.incidents.count == 2, "an unended suppression window expires after 4 hours")
        IncidentRecorder.endSuppression(staleToken)
        try? FileManager.default.removeItem(at: file)
    }
}
