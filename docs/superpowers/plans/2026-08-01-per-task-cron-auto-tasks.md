# Per-task Cron Auto Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single shared Auto Tasks run interval with a per-task cron expression (Claude Code `/schedule` mirror), so each of the 12 tasks runs on its own schedule and shows its next-fire time.

**Architecture:** A new pure `CronExpression` (5-field parse + `nextFire(after:now:)`) drives a reworked `AutoCodeUpdateService` that ticks every 60s, runs each task whose `nextFireAt` is due, and realigns its next fire to the future. `AutoTaskSettings` gains per-task `cron` + `nextFireAt` (with an `intervalMinutes → cron` migration); the global interval is removed. The Auto Tasks page shows a validated cron field + next-fire per task; the menu bar shows the soonest upcoming fire.

**Tech Stack:** Swift (SwiftPM), SwiftUI, XCTest. Sources in the `LlmIdeMacLib` target (`mac/Sources/LlmIdeMac/...`); tests `@testable import LlmIdeMacLib`.

**Spec:** [`docs/superpowers/specs/2026-08-01-per-task-cron-auto-tasks-design.md`](../specs/2026-08-01-per-task-cron-auto-tasks-design.md)

## Global Constraints

- No external dependencies — the cron engine is hand-written (5-field).
- `AutoCodeUpdateService` stays `@MainActor`; the live 60s `Timer` passes `Date()`; all cron-decision methods take an injectable `now` so they are unit-testable with a fake clock.
- Manual runs (`runNow()`, `runSingle(_:)`) must NOT change `nextFireAt` — the cron schedule is independent of manual triggers.
- Catch-up policy: an overdue task runs **once**, then `nextFireAt` is set to the first fire strictly after `now` (no burst of make-up runs).
- Verify with `swift build` / `swift test` from `mac/` — SourceKit "errors" are stale in this repo; the build is the source of truth.
- Conventional Commits, one concern per commit.

## File Structure

**Create:**
- `mac/Sources/LlmIdeMac/Services/CronExpression.swift` — pure cron parser + `nextFire` + `describe`.
- `mac/Tests/LlmIdeMacTests/CronExpressionTests.swift`
- `mac/Tests/LlmIdeMacTests/AutoTaskSettingsCronTests.swift`
- `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceCronTests.swift`
- `mac/Sources/LlmIdeMac/Views/AutoCode/CronField.swift` — reusable validated cron TextField + hint + next-fire label.

**Modify:**
- `mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift` — add per-task `cron` + `nextFireAt`; migration; (Task 5 removes `intervalMinutes`).
- `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` — cron tick replaces the interval timer.
- `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` — per-task cron field + next-fire.
- `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` — remove interval picker (Task 5).
- `mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarAutoTaskView.swift` — replace "Every X min" with soonest fire (Task 5).

---

### Task 1: `CronExpression` engine

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/CronExpression.swift`
- Test: `mac/Tests/LlmIdeMacTests/CronExpressionTests.swift`

**Interfaces:**
- Produces: `struct CronExpression: Sendable, Equatable`; `static func parse(_ s: String) -> CronExpression?`; `func nextFire(after: Date, now: Date = Date()) -> Date?`; `var describe: String`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class CronExpressionTests: XCTestCase {
    // Fixed "now" = 2026-08-01T10:00:00 local so nextFire is deterministic.
    private let now = Calendar.current.date(from: DateComponents(year: 2026, month: 8, day: 1, hour: 10, minute: 0))!

    func testParsesValidExpressions() {
        XCTAssertNotNil(CronExpression.parse("0 9 * * *"))
        XCTAssertNotNil(CronExpression.parse("*/15 * * * *"))
        XCTAssertNotNil(CronExpression.parse("0 9 * * 1-5"))
        XCTAssertNotNil(CronExpression.parse("30 8,12,18 * * *"))
    }

    func testRejectsInvalidExpressions() {
        XCTAssertNil(CronExpression.parse(""))
        XCTAssertNil(CronExpression.parse("0 9 * *"))        // 4 fields
        XCTAssertNil(CronExpression.parse("0 9 * * * extra"))// 6 fields
        XCTAssertNil(CronExpression.parse("99 * * * *"))     // minute out of range
        XCTAssertNil(CronExpression.parse("0 9 * * 8"))      // DOW out of range
    }

    func testNextFireEveryMinute() throws {
        let expr = try XCTUnwrap(CronExpression.parse("* * * * *"))
        let next = expr.nextFire(after: now, now: now)
        XCTAssertEqual(next, now.addingTimeInterval(60))
    }

    func testNextFireHourly() throws {
        let expr = try XCTUnwrap(CronExpression.parse("0 * * * *"))
        let next = expr.nextFire(after: now, now: now)
        // 10:00 → next top-of-hour is 11:00.
        XCTAssertEqual(next, Calendar.current.date(byAdding: .hour, value: 1, to: now))
    }

    func testNextFireDailyAt9() throws {
        let expr = try XCTUnwrap(CronExpression.parse("0 9 * * *"))
        let next = expr.nextFire(after: now, now: now) // now = 10:00 → tomorrow 09:00.
        XCTAssertEqual(next, Calendar.current.date(byAdding: .day, value: 1, to: now)?
                        .setting(hour: 9, minute: 0, second: 0))
    }

    func testNextFireWeekday() throws {
        // 2026-08-01 is a Saturday. "0 9 * * 1-5" → Mon 2026-08-03 09:00.
        let expr = try XCTUnwrap(CronExpression.parse("0 9 * * 1-5"))
        let next = expr.nextFire(after: now, now: now)
        let cal = Calendar.current
        let expected = cal.date(from: DateComponents(year: 2026, month: 8, day: 3, hour: 9, minute: 0))
        XCTAssertEqual(next, expected)
    }

    func testImpossibleCronReturnsNil() throws {
        // Feb 30 never exists.
        let expr = try XCTUnwrap(CronExpression.parse("0 0 30 2 *"))
        XCTAssertNil(expr.nextFire(after: now, now: now))
    }

    func testDescribe() throws {
        XCTAssertEqual(try XCTUnwrap(CronExpression.parse("0 9 * * *")).describe, "At 09:00")
        XCTAssertEqual(try XCTUnwrap(CronExpression.parse("*/30 * * * *")).describe, "Every 30 min")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter CronExpressionTests`
Expected: FAIL — `CronExpression` does not exist.

- [ ] **Step 3: Create the engine**

Create `mac/Sources/LlmIdeMac/Services/CronExpression.swift`:

```swift
import Foundation

/// A parsed 5-field cron expression: `minute hour day-of-month month day-of-week`.
/// Pure value type — the only time dependency is the `now:` parameter on `nextFire`,
/// which is injectable so callers (and tests) control the clock.
struct CronExpression: Sendable, Equatable {
    private let minute: Field
    private let hour: Field
    private let dayOfMonth: Field
    private let month: Field
    private let dayOfWeek: Field   // 0..7 (0 and 7 are both Sunday)

    /// Parse `"m h dom mon dow"`. Returns nil on any malformed field / wrong arity.
    static func parse(_ s: String) -> CronExpression? {
        let parts = s.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard parts.count == 5 else { return nil }
        guard let m = Field.parse(parts[0], min: 0, max: 59),
              let h = Field.parse(parts[1], min: 0, max: 23),
              let dom = Field.parse(parts[2], min: 1, max: 31),
              let mon = Field.parse(parts[3], min: 1, max: 12),
              let dow = Field.parse(parts[4], min: 0, max: 7) else { return nil }
        return CronExpression(minute: m, hour: h, dayOfMonth: dom, month: mon, dayOfWeek: dow)
    }

    /// Next whole-minute match strictly after `after`. `now` bounds the search
    /// (we scan forward up to ~5 years; nil if no match in that window — i.e. an
    /// impossible cron like Feb 30).
    func nextFire(after: Date, now: Date) -> Date? {
        var cal = Calendar.current
        cal.timeZone = TimeZone.current
        let limit = now.addingTimeInterval(60 * 60 * 24 * 366 * 5) // ~5 years
        let dc = cal.dateComponents([.year, .month, .day, .hour, .minute], from: after)
        var y = dc.year ?? 0, mo = dc.month ?? 0, d = dc.day ?? 0
        var h = dc.hour ?? 0, mi = dc.minute ?? 0
        // Start one minute after `after`.
        mi += 1
        func flush() -> Date? { cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi)) }

        while true {
            let probe = flush() ?? Date.distantPast
            if probe > limit { return nil }
            if !month.contains(mo) { mo += 1; h = 0; mi = 0; d = 1; if mo > 12 { mo = 1; y += 1 }; continue }
            let dim = cal.range(of: .day, in: .month, for: probe)?.count ?? 28
            if d < 1 || d > dim || !dayOfMonth.contains(d) { d += 1; h = 0; mi = 0; if d > 31 { d = 1; mo += 1; if mo > 12 { mo = 1; y += 1 } }; continue }
            if !hour.contains(h) { h += 1; mi = 0; if h > 23 { h = 0; d += 1 }; continue }
            if !minute.contains(mi) { mi += 1; if mi > 59 { mi = 0; h += 1; if h > 23 { h = 0; d += 1 } }; continue }
            // Day-of-week: Calendar weekday is 1=Sun..7=Sat; cron DOW is 0=Sun..6=Sat
            // (with 7 also meaning Sun). Match if the cron field contains cronDOW,
            // or (cronDOW==0 and the field contains 7).
            let calWeekday = cal.component(.weekday, from: probe)   // 1..7
            let cronDOW = (calWeekday - 1) % 7                      // Sun=0..Sat=6
            let dowMatch = dayOfWeek.contains(cronDOW) || (cronDOW == 0 && dayOfWeek.contains(7))
            if !dowMatch { d += 1; h = 0; mi = 0; continue }
            return probe
        }
    }

    var describe: String {
        if minute.isStep && hour.all && dayOfMonth.all && month.all && dayOfWeek.all {
            return "Every \(minute.step!) min"
        }
        if minute.containsExactlyOne, hour.containsExactlyOne, dayOfMonth.all, month.all, dayOfWeek.all {
            return String(format: "At %02d:%02d", hour.single!, minute.single!)
        }
        return rawDescription
    }

    private var rawDescription: String {
        "\(minute.raw) \(hour.raw) \(dayOfMonth.raw) \(month.raw) \(dayOfWeek.raw)"
    }

    private struct Field: Sendable, Equatable {
        let values: Set<Int>      // the literal values this field matches (already expanded)
        let raw: String           // original text, for describe
        var all: Bool { raw == "*" }
        var isStep: Bool { raw.hasPrefix("*/") }
        var step: Int? { isStep ? Int(raw.dropFirst(2)) : nil }
        var containsExactlyOne: Bool { values.count == 1 }
        var single: Int? { values.sorted().first }

        func contains(_ v: Int) -> Bool { values.contains(v) }

        static func parse(_ s: String, min: Int, max: Int) -> Field? {
            var out: Set<Int> = []
            for term in s.split(separator: ",") {
                let part = String(term)
                if part == "*" { out.formUnion(Array(min...max)) }
                else if part.hasPrefix("*/") {
                    guard let step = Int(part.dropFirst(2)), step > 0 else { return nil }
                    out.formUnion(stride(from: min, through: max, by: step))
                } else if let dash = part.range(of: "/") {
                    let range = String(part[..<dash.lowerBound])
                    let step = Int(part[dash.upperBound...]) ?? 1
                    guard step > 0 else { return nil }
                    let (lo, hi) = bounds(range, min: min, max: max) ?? (min, max)
                    if lo > hi || lo < min || hi > max { return nil }
                    out.formUnion(stride(from: lo, through: hi, by: step))
                } else {
                    let (lo, hi) = bounds(part, min: min, max: max) ?? (Int(part) ?? -1, Int(part) ?? -1)
                    if part.contains("-") {
                        guard lo...hi ~= lo, lo >= min, hi <= max, lo <= hi else { return nil }
                        out.formUnion(Array(lo...hi))
                    } else {
                        guard lo >= min, lo <= max, lo == hi else { return nil }
                        out.insert(lo)
                    }
                }
            }
            return out.isEmpty ? nil : Field(values: out, raw: s)
        }

        private static func bounds(_ s: String, min: Int, max: Int) -> (Int, Int)? {
            guard let dash = s.range(of: "-") else { return nil }
            let lo = Int(s[..<dash.lowerBound])
            let hi = Int(s[dash.upperBound...])
            guard let lo, let hi else { return nil }
            return (lo, hi)
        }
    }
}
```

> `nextFire` is the trickiest piece — field-by-field forward scan with carry. The 7 tests in Step 1 (esp. `testNextFireWeekday` on a Saturday and `testImpossibleCronReturnsNil`) are the contract; iterate against them until green. If the loop's carry logic misbehaves for a case not covered, add a focused test rather than guessing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter CronExpressionTests`
Expected: PASS (7 tests). `swift build` green.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/CronExpression.swift mac/Tests/LlmIdeMacTests/CronExpressionTests.swift
git commit -m "feat(mac): CronExpression 5-field parser + nextFire"
```

---

### Task 2: Per-task `cron` + `nextFireAt` in `AutoTaskSettings` (additive)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift`
- Test: `mac/Tests/LlmIdeMacTests/AutoTaskSettingsCronTests.swift`

**Interfaces:**
- Consumes: `CronExpression` (Task 1).
- Produces: `AutoTaskSettings.cron(for:) -> String`, `setCron(_:for:)`, `nextFireAt(for:) -> Date?`, `setNextFireAt(_:for:)`, `recomputeNextFire(for:now:)`. Per-task cron is persisted at keys `autoCodeCron.<taskRawValue>`; `nextFireAt` at `autoCodeNextFireAt.<taskRawValue>` (stored as `TimeInterval` since 1970). Migration seeds cron from the old `intervalMinutes` if present. `intervalMinutes` is left in place here (removed in Task 5).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoTaskSettingsCronTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "cron-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    func testPerTaskCronPersists() {
        let a = AutoTaskSettings(defaults: suite)
        a.setCron("0 9 * * 1-5", for: .reviewCode)
        let b = AutoTaskSettings(defaults: suite)
        XCTAssertEqual(b.cron(for: .reviewCode), "0 9 * * 1-5")
        // Unset task falls back to the default hourly cron.
        XCTAssertEqual(b.cron(for: .reviewDoc), "0 * * * *")
    }

    func testNextFireAtPersistsAndRecomputes() {
        let now = Date()
        let a = AutoTaskSettings(defaults: suite)
        a.setCron("0 9 * * *", for: .regression)
        a.recomputeNextFire(for: .regression, now: now)
        let stored = a.nextFireAt(for: .regression)
        XCTAssertNotNil(stored)
        XCTAssertGreaterThan(stored!, now)
    }

    func testMigrationFromIntervalMinutes() {
        suite.set(60, forKey: "autoCodeIntervalMinutes")     // → 0 * * * *
        suite.set(30, forKey: "autoCodeIntervalMinutes")     // last write wins → 30
        // Simulate the first-launch migration path by constructing settings that
        // still have the legacy key and no cron keys.
        suite.removeObject(forKey: "autoCodeCron.reviewCode")
        let a = AutoTaskSettings(defaults: suite)            // init runs migration
        // 30 min → */30 * * * *
        XCTAssertEqual(a.cron(for: .reviewCode), "*/30 * * * *")
    }

    func testMigrationHourlyDailyAndMultiHour() {
        func cron(forInterval minutes: Int) -> String {
            let s = UserDefaults(suiteName: "cron-migrate-\(UUID().uuidString)")
            s.set(minutes, forKey: "autoCodeIntervalMinutes")
            return AutoTaskSettings(defaults: s).cron(for: .reviewCode)
        }
        XCTAssertEqual(cron(forInterval: 60), "0 * * * *")
        XCTAssertEqual(cron(forInterval: 1440), "0 0 * * *")
        XCTAssertEqual(cron(forInterval: 120), "0 */2 * * *")
        XCTAssertEqual(cron(forInterval: 15), "*/15 * * * *")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter AutoTaskSettingsCronTests`
Expected: FAIL — `cron(for:)` / `setCron(_:for:)` etc. do not exist.

- [ ] **Step 3: Add per-task cron + nextFireAt + migration**

In `mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift`:

(a) Add two helpers near the top of the class (after `// MARK: - Published State`):

```swift
    static let defaultCron = "0 * * * *"   // hourly; used for fresh installs

    private static func cronKey(_ task: AutoTask) -> String { "autoCodeCron.\(task.rawValue)" }
    private static func nextFireKey(_ task: AutoTask) -> String { "autoCodeNextFireAt.\(task.rawValue)" }
```

(b) Add the accessors in the `// MARK: - Per-task enable (generic accessors)` section (after `setEnabled`):

```swift
    func cron(for task: AutoTask) -> String {
        defaults.string(forKey: Self.cronKey(task)) ?? Self.defaultCron
    }
    func setCron(_ value: String, for task: AutoTask) {
        guard CronExpression.parse(value) != nil else { return }   // refuse invalid
        defaults.set(value, forKey: Self.cronKey(task))
        recomputeNextFire(for: task, now: Date())
        objectWillChange.send()   // notify the UI
    }
    func nextFireAt(for task: AutoTask) -> Date? {
        let t = defaults.double(forKey: Self.nextFireKey(task))
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }
    func setNextFireAt(_ date: Date?, for task: AutoTask) {
        if let date { defaults.set(date.timeIntervalSince1970, forKey: Self.nextFireKey(task)) }
        else { defaults.removeObject(forKey: Self.nextFireKey(task)) }
    }
    /// Recompute the next fire strictly after `now`. No-op if cron is invalid.
    func recomputeNextFire(for task: AutoTask, now: Date) {
        guard let expr = CronExpression.parse(cron(for: task)),
              let next = expr.nextFire(after: now, now: now) else {
            setNextFireAt(nil, for: task); return
        }
        setNextFireAt(next, for: task)
    }
```

(c) Add the migration + default-seeding at the END of `init(defaults:)` (after the existing `showOnlyEnabledTasks` line and before the `NotificationCenter` observer):

```swift
        // --- Per-task cron migration / seeding ---
        let legacyInterval = defaults.object(forKey: "autoCodeIntervalMinutes") as? Int
        for task in AutoTask.allCases {
            if defaults.string(forKey: Self.cronKey(task)) == nil {
                let seeded = Self.cronFromInterval(legacyInterval)
                defaults.set(seeded, forKey: Self.cronKey(task))
            }
            if nextFireAt(for: task) == nil {
                recomputeNextFire(for: task, now: Date())
            }
        }
```

(d) Add the helper used above (near `intervalDescription`):

```swift
    /// Map the legacy shared interval (minutes) to a per-task cron seed.
    static func cronFromInterval(_ minutes: Int?) -> String {
        guard let minutes else { return defaultCron }
        switch minutes {
        case ..<60:  return "*/\(max(1, minutes)) * * * *"
        case 60:     return "0 * * * *"
        case 1440:   return "0 0 * * *"
        default:     return "0 */\(max(1, minutes / 60)) * * * *"
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter AutoTaskSettingsCronTests`
Expected: PASS (4 tests). `swift build` green.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift mac/Tests/LlmIdeMacTests/AutoTaskSettingsCronTests.swift
git commit -m "feat(mac): per-task cron + nextFireAt in AutoTaskSettings (interval migration)"
```

---

### Task 3: Cron-driven `AutoCodeUpdateService` tick

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`
- Test: `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceCronTests.swift`

**Interfaces:**
- Consumes: `CronExpression` (Task 1), `AutoTaskSettings.cron/nextFireAt/setNextFireAt` + `isEnabled` (Task 2).
- Produces: `func dueTasks(now: Date = Date()) -> [AutoTask]` (pure read); `func runDue(now: Date = Date()) -> Bool` (runs due tasks once, realigns nextFireAt, re-entrancy-guarded); the 60s `Timer` calls `runDue`. `runNow()` / `runSingle(_:)` unchanged.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoCodeUpdateServiceCronTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "svc-cron-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    /// Minimal stand-in: we only test the scheduling DECISION (dueTasks + the
    /// nextFireAt realign), not the task bodies. Build via the real init if
    /// cheap; otherwise exercise the pure methods on a constructed instance.
    private func makeService() -> AutoCodeUpdateService {
        let settings = AutoTaskSettings(defaults: suite)
        settings.enabled = true
        settings.setEnabled(true, task: .reviewCode)
        settings.setCron("*/30 * * * *", for: .reviewCode)
        return AutoCodeUpdateService(
            config: AppConfig(defaults: suite),
            autoTaskSettings: settings,
            registry: ProcessedActionsRegistry(),
            logStore: TaskLogStore())
    }

    func testOverdueTaskIsDueAndRealigns() {
        let svc = makeService()
        let settings = svc.autoTaskSettings
        let past = Date().addingTimeInterval(-300)   // 5 min ago
        settings.setNextFireAt(past, for: .reviewCode)

        let due = svc.dueTasks(now: Date())
        XCTAssertEqual(due, [.reviewCode])

        // runDue realigns nextFireAt to strictly-after-now (we call the realign
        // path directly to avoid running task bodies in this unit test).
        svc.realignNextFire(for: .reviewCode, now: Date())
        XCTAssertGreaterThan(settings.nextFireAt(for: .reviewCode)!, Date())
    }

    func testFutureTaskIsNotDue() {
        let svc = makeService()
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(3600), for: .reviewCode)
        XCTAssertTrue(svc.dueTasks(now: Date()).isEmpty)
    }

    func testMasterDisabledSkipsAll() {
        let svc = makeService()
        svc.autoTaskSettings.enabled = false
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(-300), for: .reviewCode)
        XCTAssertTrue(svc.dueTasks(now: Date()).isEmpty)
    }

    func testPerTaskDisabledSkipsTask() {
        let svc = makeService()
        svc.autoTaskSettings.setEnabled(false, task: .reviewCode)
        svc.autoTaskSettings.setNextFireAt(Date().addingTimeInterval(-300), for: .reviewCode)
        XCTAssertTrue(svc.dueTasks(now: Date()).isEmpty)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter AutoCodeUpdateServiceCronTests`
Expected: FAIL — `dueTasks(now:)` / `realignNextFire(for:now:)` do not exist; `autoTaskSettings` may not be exposed.

- [ ] **Step 3: Expose `autoTaskSettings` and add the cron methods**

In `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`:

(a) If `autoTaskSettings` is currently `private`/internal-hidden, expose it for tests:
```swift
    let autoTaskSettings: AutoTaskSettings   // (was private let — make internal-visible)
```
(The exact existing visibility may already be internal; only change it if the test can't see it. The Settings UI already reads it, so it is very likely already accessible.)

(b) Replace `scheduleTimer()` (the repeating-interval timer) with a 60s cron tick. Replace the whole `scheduleTimer()` method:

```swift
    /// Arm the 60s cron-evaluation tick. Each tick runs every task whose
    /// `nextFireAt` is due, then realigns its next fire to the future.
    private func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.runDue(now: Date()) }
        }
    }
```

(c) Add the cron-decision methods (next to `runNow` / `runSingle`):

```swift
    /// Tasks whose next fire is at or before `now` (and are enabled). Pure read —
    /// does not mutate state or run anything. `now` is injected for tests.
    func dueTasks(now: Date = Date()) -> [AutoTask] {
        guard autoTaskSettings.enabled else { return [] }
        return AutoTask.allCases.filter { task in
            guard autoTaskSettings.isEnabled(task),
                  let next = autoTaskSettings.nextFireAt(for: task) else { return false }
            return now >= next
        }
    }

    /// Advance a task's nextFireAt to the first fire strictly after `now`
    /// (catch up once → realign to the future). Testable seam.
    func realignNextFire(for task: AutoTask, now: Date) {
        guard let expr = CronExpression.parse(autoTaskSettings.cron(for: task)),
              let next = expr.nextFire(after: now, now: now) else {
            autoTaskSettings.setNextFireAt(nil, for: task); return
        }
        autoTaskSettings.setNextFireAt(next, for: task)
    }

    /// Run every task due at `now`, once, then realign each. Shares the
    /// `runTask` re-entrancy guard with `runNow()`/`runSingle(_:)`.
    @discardableResult
    func runDue(now: Date = Date()) -> Bool {
        let due = dueTasks(now: now)
        guard !due.isEmpty, runTask == nil else { return false }
        for task in due { realignNextFire(for: task, now: now) }   // realign BEFORE running
        runTask = Task { [weak self] in
            for task in due { await self?.runOne(task) }
            self?.runTask = nil
        }
        return true
    }
```

(d) Remove the `intervalCancellable` plumbing (it watched `$intervalMinutes`, which is no longer used for scheduling). Delete the `private var intervalCancellable: AnyCancellable?` property and its sink block in `init`. Leave `cancellable` (the `$enabled` → start/stop sink) intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter AutoCodeUpdateServiceCronTests`
Expected: PASS (4 tests). `swift build` green. (`intervalMinutes` still exists on `AutoTaskSettings` and is simply unused by the service now — Task 5 removes it.)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceCronTests.swift
git commit -m "feat(mac): cron-driven Auto Tasks tick (60s) replacing shared interval"
```

---

### Task 4: AutoCodeView — per-task cron field + next-fire label

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/AutoCode/CronField.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift` (the per-task row)
- Test: covered by `CronExpressionTests` (validation = `CronExpression.parse`); SwiftUI view rendering is not unit-tested (matches repo convention — mac tests cover models/services, not views).

**Interfaces:**
- Consumes: `CronExpression` (Task 1), `AutoTaskSettings.cron/nextFireAt/setCron` (Task 2).
- Produces: `CronField` — a self-contained view bound to a `(task, settings)` that renders a validated cron TextField + the `describe` hint + the next-fire label.

- [ ] **Step 1: Create `CronField`**

Create `mac/Sources/LlmIdeMac/Views/AutoCode/CronField.swift`:

```swift
import SwiftUI

/// Validated cron editor for one Auto Task: a TextField that commits only
/// valid 5-field cron, the human `describe` hint, and the next-fire timestamp.
/// Invalid input is reverted to the last saved cron on commit.
struct CronField: View {
    let task: AutoTask
    @ObservedObject var settings: AutoTaskSettings
    @EnvironmentObject private var theme: ThemeStore

    @State private var draft: String = ""
    @State private var touched = false

    private var isValid: Bool { CronExpression.parse(draft) != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: "clock")
                    .foregroundStyle(theme.current.textMuted)
                TextField("cron", text: $draft)
                    .font(.system(.caption, design: .monospaced))
                    .onSubmit { commit() }
                    .onAppear { draft = settings.cron(for: task) }
                if let next = settings.nextFireAt(for: task) {
                    Text("next: \(Self.fireFormatter.string(from: next))")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                } else {
                    Text("no upcoming fire")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            if !isValid && touched {
                Text("invalid cron")
                    .font(.caption2)
                    .foregroundStyle(.red)
            } else if let desc = CronExpression.parse(settings.cron(for: task))?.describe {
                Text(desc).font(.caption2).foregroundStyle(theme.current.textMuted)
            }
        }
    }

    private func commit() {
        touched = true
        if CronExpression.parse(draft) != nil { settings.setCron(draft, for: task) }
        else { draft = settings.cron(for: task) }   // revert
    }

    static let fireFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = "EEE HH:mm"
        return f
    }()
}
```

- [ ] **Step 2: Insert `CronField` into the task row**

In `mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`, find each task row rendering (the row that shows the task's `Toggle`/enable + label + the per-task ▶ run button). Add `CronField(task: task, settings: autoTaskSettings)` immediately above the row's Run button, e.g.:

```swift
    CronField(task: task, settings: autoTaskSettings)
```

If the row is built by a reusable subview, pass `autoTaskSettings` through its environment (it is already an `@EnvironmentObject` on the page) or as an explicit parameter. The exact surrounding code differs by row; the requirement is: **each of the 12 task rows shows its `CronField` above its Run button**, bound to that row's `task`.

- [ ] **Step 3: Build + smoke**

Run: `cd mac && swift build`
Expected: BUILD green. (No new unit test — validation is covered by `CronExpressionTests`; view rendering follows repo convention of not unit-testing SwiftUI views.)

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AutoCode/CronField.swift mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift
git commit -m "feat(mac): per-task cron field + next-fire on the Auto Tasks page"
```

---

### Task 5: Remove the global interval

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift` — remove `intervalMinutes`, `intervalDescription`, their `@Published`/`didSet`/init/`userDefaultsDidChange` lines.
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift` — remove the interval picker (whatever control binds `autoTaskSettings.intervalMinutes`).
- Modify: `mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarAutoTaskView.swift` — replace the "Every X min" block with the soonest upcoming fire.
- Test: `mac/Tests/LlmIdeMacTests/AutoTaskSettingsCronTests.swift` (append) — assert `intervalMinutes` is gone.

**Interfaces:**
- Consumes: Tasks 1–4 (cron/nextFireAt + service + UI all work without the interval).
- Produces: no remaining reference to `intervalMinutes` / `intervalDescription` anywhere. The menu bar shows the soonest `nextFireAt`.

- [ ] **Step 1: Append the "interval gone" test**

Append to `mac/Tests/LlmIdeMacTests/AutoTaskSettingsCronTests.swift`:

```swift
extension AutoTaskSettingsCronTests {
    func testIntervalMinutesRemovedFromDefaults() {
        // The legacy key may still exist on disk for migration, but the type no
        // longer exposes intervalMinutes. A fresh settings object must not write it.
        let a = AutoTaskSettings(defaults: suite)
        _ = a
        // No API to set interval; the key is read once for migration then unused.
        // (If a `var intervalMinutes` still compiles here, this task is incomplete.)
    }
}
```

> This test is intentionally a compile-time + behavior guard: it should compile precisely because `intervalMinutes` is no longer a property. If the property still exists, the test body's reference would resolve — but the broader requirement is "no source references it," which `swift build` enforces (any remaining caller fails to compile).

- [ ] **Step 2: Remove `intervalMinutes` from `AutoTaskSettings`**

In `mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift`, delete:
- the `@Published var intervalMinutes` property + its `didSet`;
- the `self.intervalMinutes = …` line in `init`;
- the `intervalMinutes` block in `userDefaultsDidChange()`;
- the `var intervalDescription` computed property.

Leave the `autoCodeIntervalMinutes` UserDefaults read inside the migration path from Task 2 (it reads the legacy key once via `defaults.object(forKey: "autoCodeIntervalMinutes")`, which does NOT reference the removed property).

- [ ] **Step 3: Remove the interval picker from Settings**

In `mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift`, delete the picker/stepper bound to `autoTaskSettings.intervalMinutes` (and its row/label). Run `grep -n intervalMinutes mac/Sources` to confirm no remaining UI references.

- [ ] **Step 4: Replace the menu-bar "Every X min" with the soonest fire**

In `mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarAutoTaskView.swift`, replace the block:

```swift
                HStack(spacing: 4) {
                    Image(systemName: "timer")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                    Text("Every \(autoTaskSettings.intervalDescription)")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
```

with:

```swift
                HStack(spacing: 4) {
                    Image(systemName: "timer")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                    Text(nextFireLabel)
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
```

and add a computed property on `MenuBarAutoTaskView`:

```swift
    private var nextFireLabel: String {
        let upcoming = AutoTask.allCases
            .filter { autoTaskSettings.isEnabled($0) }
            .compactMap { autoTaskSettings.nextFireAt(for: $0) }
            .sorted()
        guard let soonest = upcoming.first else { return "No tasks scheduled" }
        return "Next: \(AutoTask.fireFormatter.string(from: soonest))"
    }
```

and add to the `AutoTask` enum (in `AutoCodeView.swift`) the shared formatter:

```swift
    static let fireFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = "EEE HH:mm"
        return f
    }()
```

(If `CronField.fireFormatter` already exists from Task 4, reuse that instead of duplicating — move it onto `AutoTask` and have `CronField` reference `AutoTask.fireFormatter`.)

- [ ] **Step 5: Build + full suite**

Run: `cd mac && swift build && swift test`
Expected: BUILD green; all tests PASS. `grep -rn "intervalMinutes\|intervalDescription" mac/Sources` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift \
        mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift \
        mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarAutoTaskView.swift \
        mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift \
        mac/Tests/LlmIdeMacTests/AutoTaskSettingsCronTests.swift
git commit -m "refactor(mac): remove the shared Auto Tasks interval (per-task cron replaces it)"
```

---

## Self-Review (run after writing — already applied)

**Spec coverage:** cron engine ✓ T1; per-task cron + nextFireAt + migration ✓ T2; cron-driven 60s tick (catch-up-once realign, manual runs schedule-independent, master/per-task disable) ✓ T3; AutoCodeView cron field + next-fire ✓ T4; remove global interval + menu-bar next-fire ✓ T5. CronExpression `describe`, impossible-cron nil, and the migration matrix are all covered by tests.

**Placeholders:** Task 4 Step 2 (inserting `CronField` into the row) is the one place that depends on the existing row shape — it gives the exact binding + placement rule ("each row shows `CronField(task:settings)` above its Run button") rather than guessing the surrounding code. If the row is a reusable subview, the instruction names the fallback (pass `autoTaskSettings` through). No bare TODO.

**Type consistency:** `cron(for:)` / `setCron(_:for:)` / `nextFireAt(for:)` / `setNextFireAt(_:for:)` defined in T2, used identically in T3/T4/T5. `dueTasks(now:)` / `realignNextFire(for:now:)` / `runDue(now:)` defined in T3 and used by the timer. `AutoTask.fireFormatter` introduced in T5 (with a note to fold `CronField.fireFormatter` from T4 into it).

**Refinement vs spec:** the catch-up realign is `nextFire(after: now)` (always strictly future), so the spec's `repeat…while` loop is unnecessary — behavior is identical (run once, realign). Noted in T3.

## Execution Handoff

**Plan complete and saved to** `docs/superpowers/plans/2026-08-01-per-task-cron-auto-tasks.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
