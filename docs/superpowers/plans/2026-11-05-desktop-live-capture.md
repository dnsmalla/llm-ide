# Desktop Live Caption Capture (macOS first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Tauri desktop app a Live section that reads Zoom and Teams desktop meeting captions on macOS through the Accessibility API. It records only after the user presses Start, shows a recording banner the whole time, never touches audio, and saves the meeting as the same Markdown note the Mac app writes.

**Architecture:** The Rust host owns all of the capture work. A small macOS FFI layer turns the meeting app's accessibility tree into a plain JSON-shaped `AxNode` tree, bounded by depth, node count and time. Pure Rust readers (Zoom, Teams), the caption content rules and the row delta state then turn that tree into caption rows, so all of the caption logic is tested on recorded JSON fixtures. A worker thread ticks every 800 ms. It streams append, replace and closed events to the webview over a Tauri `Channel`, writes a crash-safe partial file in the app data folder, and at Stop writes the final meeting note into the notes folder through the hardened `notes_write` path. It reads the note back to verify it, then gives the webview a ready-made upsert for the core's note index. The webview screen (`ui/screens/live/`) only displays rows and sends Start and Stop.

**Tech Stack:** Rust (Tauri 2.11, `regex`, `serde`, `libc`, `objc2-app-kit` / `objc2-foundation` 0.3.2, all already in `Cargo.lock`), ApplicationServices and CoreFoundation FFI (the same pattern as `desktop/src-tauri/src/ax_probe.rs`), React 18 + TypeScript screens tested with `node --test --experimental-strip-types` and esbuild server rendering.

**Spec:** This plan's section A (decisions and assumptions), argued from [Phase 5 macOS plan section 8 "P5-L Live capture"](2026-10-31-tauri-phase5-macos-plan.md), [live-then-archive section 3.6 A "Mac native capture"](2026-10-29-live-then-archive.md), [Tauri plan risks](2026-10-24-tauri-desktop-and-relay.md) ("Accessibility capture differs per OS", "Meeting capture via Rust AX"), [parity checklist section 10](2026-10-31-tauri-parity-checklist.md), [invariants: Caption scraper](../../explanation/invariants.md), `extension/CLAUDE.md` caption checklist, and USER-NEEDS **UN-035**. Mac reference: `mac/Sources/LlmIdeMac/Features/Live/` (2,751 lines).

## Global Constraints

- Capture starts **only** from an explicit Start click. No auto-start on a meeting window (Mac `AutoCaptureService` is **not** ported).
- **Never record audio.** No microphone, camera or screen-recording API, entitlement, crate or `Info.plist` usage string may be added (there is a guard test in Task 8).
- A recording banner is visible in every section while capture runs (Task 11). Inside Live, the recording bar plays that role.
- Caption cadence: **800 ms** per tick (`SCRAPE_INTERVAL_MS = 800`, invariants.md).
- Same content rules as the extension: content-based `isValidCaption`, `sanitizeSpeaker` with combined-speaker suffix stripping (`& N others`, `他N名`), and the minimum caption length stays 1 (`はい。` is kept). Parity is pinned by one shared JSON fixture that both the extension and Rust tests run.
- Send only on change: the webview receives an event only for an appended, grown (replaced) or closed row.
- Caption text is untrusted. It is rendered as React text only: no Markdown and no `dangerouslySetInnerHTML`.
- Caption text never goes to logs: no `println!` or `eprintln!` of speaker or text in any `capture_*.rs` file (guard test in Task 8).
- Meeting content goes to a model provider only through the user-started Re-summarise button in Library. The desktop does not summarise in the background.
- The durable copy is the note file `source/meetings/YYYY/MM/<date>-<slug>-<8hex>.md` inside the notes root, in the Mac format (`MeetingFileStore` + `MeetingFrontmatter`). The partial file lives only in `<desktop_data_dir>/capture/`.
- Every new host command is declared in `desktop/src-tauri/build.rs` `COMMANDS`, registered in `lib.rs` `product_handlers!`, and granted in `capabilities/default.json`. `node scripts/check-capabilities.mjs --product` must pass. Spike-only commands go only in the `spike` block and `capabilities/spike.json`.
- No new crate. Only features are added to `objc2-app-kit`, and `objc2-foundation` gets a direct entry at the version already in `Cargo.lock` (`=0.3.2`).
- No Swift change (feature freeze). Section A.1 says what changes if the user approves UN-035.
- No feature branch: work and commit on `main` (user rule). Push only when the user says so.
- Conventional Commits, one concern per commit. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## A. Decisions, assumptions and what is not grounded

### A.1 UN-035: what this plan assumes

UN-035 asks the user to approve "the one Swift addition for the Live capture helper" (Phase 5 plan section 15, item 2). **It is not approved yet** (unchecked in `docs/superpowers/USER-NEEDS.md`), and the Swift feature freeze is in force.

**This plan assumes "no Swift": capture is pure Rust inside the host.** Reasons:

1. The freeze stays exactly as it is. The default when nobody answers is "no new Swift".
2. One binary, one signature and one Accessibility (TCC) entry, attributed to `com.llmide.desktop`. A helper is a second signed executable whose TCC attribution has to be proven (Phase 7 spike 1, not run).
3. The requirement asks for Rust unit tests on AX tree fixtures recorded as JSON. That needs the readers and the delta logic in Rust either way. With a helper they would stay in Swift, and the Rust fixtures would test nothing real.
4. `ax_probe.rs` already proves the FFI works (`AXIsProcessTrusted`, `AXUIElementCopyAttributeValue`, messaging timeouts, a bounded walk).
5. The Phase 5 plan wanted the helper for process isolation (a hung AX call). Here the AX reads run on a worker thread, with a 0.3 s per-element messaging timeout and a 0.5 s per-app deadline (the Mac's `AXCaptionReader.messagingTimeout` and `WalkLimits.within(0.5)`). A hang therefore costs at most one tick and never touches the UI thread.

**If the user says yes to the Swift helper:** only Task 5 changes. A `desktop/capture-helper/` SwiftPM executable would do exactly what `capture_ax_macos.rs` does: take a bundle id on stdin and print one `AxAppTree` JSON line, or `{"error":"permission_denied"}`. A `HelperSource` would implement the same `SnapshotSource` trait (Task 6) by spawning that helper from the signed bundle path and killing it on Stop. Tasks 1 to 4 and 6 to 13 stay unchanged, because the readers, rules, delta state, store and UI all consume `AxAppTree`. The extra cost would be a second Developer ID signature, `Contents/MacOS/llmide-capture` in the bundle, a possible second TCC entry, and about 300 lines of Swift kept after the Swift app retires.

**If the user says no (or says nothing):** this plan runs as written. A later Windows phase (UI Automation) and Linux phase (AT-SPI) add new `SnapshotSource` implementations behind the same trait.

### A.2 Store path: native capture (3.6 A), not the `/kb/live` ack path (3.6 B)

Live-then-archive defines two meeting flows. **3.6 A, "Mac native capture"**: the partial file is the live copy, there is no server row at any time, and the finalized note goes to the index. **3.6 B, "Extension capture"**: the server ring buffer is the live copy until the archivist acks. The desktop's AX capture is a native capture, so this plan reuses 3.6 A's store rules: partial then finalize, then verify, then feed the index. It does **not** push captions to `/kb/live/*`, for three reasons found in the code:

- `finalizeSession` caps a capture at `MAX_FINAL_CAPTIONS = 2000` lines (`extension/agents/live-sessions.mjs:360,377`, 413 `CAPTURE_TOO_LARGE`). A long meeting (about 20k rows in 4 h, Phase 5 plan section 8) could not be finalized.
- The Swift app's `LiveSessionMirror` writes a note for **every** finalized `/kb/live` session it sees, and adopts `/kb/live/unacked` at start. If both apps are open, one desktop capture would become two notes.
- The ack (`POST /kb/live/:id/ack`) exists to release a **server** copy. Path A has no server copy, so there is nothing to ack. Path A also does not wait on `LLMIDE_LIVE_ACK` or on the user's recorded meetings (MASTER-PLAN `(wait)`).

What is reused from live-then-archive: the one-copy rule (the note file is the only durable copy), the verify-before-cleanup order (3.6 A step 1: the file reads back, the frontmatter is present, the transcript line count equals the captured rows), and the index feed (`POST /kb/index/notes`, same `noteKey` and upsert shape as `ui/screens/library/index-rebuild.ts` `makeUpsertInput`). The desktop acting as an **archivist for extension captures** (adopting `/kb/live/unacked` like the Swift mirror) is a separate follow-up (section F).

### A.3 Decisions for the user (secure default first)

| # | Decision | Secure default (what this plan builds) | If the user picks the other option |
|---|---|---|---|
| D1 | UN-035: Swift capture helper or pure Rust | **Pure Rust in the host, no Swift** (A.1) | Task 5 becomes a Swift helper plus `HelperSource`; nothing else changes |
| D2 | Desktop capture store: native partial file (3.6 A) or `/kb/live` + ack (3.6 B) | **3.6 A**: partial in the app data folder, note in the notes folder, index feed, no server copy | Task 6 posts rows to `/kb/live/:id/append` and finalize, Task 12 acks. This hits the 2,000-line cap and duplicates notes while the Swift app runs |
| D3 | Tick cadence | **800 ms fixed** (extension invariant, Tauri plan) | Mac's 250 ms (500 ms when idle) means 3 to 4 times more AX reads |
| D4 | Summary after Stop | **Only when the user clicks Re-summarise in Library** | The Mac summarises in the background at once, so meeting text goes to the provider without a click |
| D5 | Auto-capture when a meeting starts | **Not built**: capture only on Start | Port `AutoCaptureService` later, behind an opt-in setting |
| D6 | Google Meet | **The Chrome extension covers it** (Meet has no desktop app; the Mac has no Meet reader) | A Safari or Chrome AX reader is a new reader plus fixtures |
| D7 | Teams client | **New Teams only (`com.microsoft.teams2`)**, same as `TeamsCaptionScraper` | Add `com.microsoft.teams` (classic) as a second bundle id |
| D8 | Swift app open at the same time | **Warn on the Live screen** ("the Mac app is also running; capture the meeting in one app only"), do not block | Block Start while `com.llmide.macapp` runs |

### A.4 Not grounded (checked and not found, or not checkable offline)

- **Real AX trees of current Zoom and Teams builds:** none are recorded in the repo. The fixtures in Task 3 are synthetic, shaped after the Swift readers' own comments (`ZoomCaptionScraper.swift`, `TeamsCaptionScraper.swift`). Task 5 adds a spike-only recorder, and the manual checklist (section E) asks the user to record one scrubbed tree per app.
- **Phase 7 spike 1 (TCC attribution matrix):** no result in the repo. Section D states Apple's documented "responsible process" behaviour as an assumption that the manual checklist confirms.
- **`objc2-app-kit` 0.3.2 API details** (`NSRunningApplication::runningApplicationsWithBundleIdentifier`, whether it is `unsafe`, and the exact feature names) could not be checked offline. Task 5 step 1 compiles a one-line probe first.
- **Whether `AXIsProcessTrusted()` turns true without a relaunch after the user grants access:** this varies by macOS version and is not verified. The UI offers "Check again" and says to relaunch if needed.
- **Where the Mac app's Start button lives:** not located (the Mac toolbar shows Live only while recording). The desktop puts Start inside the Live section.
- **Meet "desktop app":** none exists, so D6 applies.

---

## B. File structure

| File | Responsibility | Task |
|---|---|---|
| `desktop/src-tauri/tests/fixtures/captions/validation-cases.json` | Shared sanitize and validity cases (extension and Rust) | 1 |
| `desktop/src-tauri/src/capture_validate.rs` | `sanitize_speaker`, `sanitize_text`, `is_valid_caption`, `clean_lines` | 1 |
| `extension/tests/caption-validation-parity.test.ts` | Runs the shared fixture against `caption-validation.ts` | 1 |
| `desktop/src-tauri/src/capture_delta.rs` | Port of `CaptionDeltaState` (row alignment, growth, closing) | 2 |
| `desktop/src-tauri/src/capture_model.rs` | `AxNode`, `AxAppTree`, `AxReadError` | 3 |
| `desktop/src-tauri/src/capture_readers.rs` | `CaptionReader` trait, `ZoomReader`, `TeamsReader`, `pair_caption_rows` | 3 |
| `desktop/src-tauri/tests/fixtures/captions/*.json` | Reader fixtures (trees and expected rows) | 3 |
| `desktop/src-tauri/src/capture_store.rs` | Partial writer and reader, note rendering, final name, finalize and verify, index upsert | 4 |
| `desktop/src-tauri/src/capture_ax_macos.rs` | macOS FFI: trust, prompt, pid lookup, bounded tree read; stubs on other OSes; spike recorder | 5 |
| `desktop/src-tauri/src/capture_session.rs` | `SnapshotSource` trait, `Session` (pure tick, row flush policy, finish), `CaptureEvent` | 6 |
| `desktop/src-tauri/src/capture_host.rs` | Tauri commands, worker thread, recovery, exit flush | 7 |
| `desktop/src-tauri/src/lib.rs`, `build.rs`, `capabilities/default.json`, `capabilities/spike.json`, `Cargo.toml` | Registration and features | 5, 7 |
| `desktop/scripts/check-capture-privacy.test.mjs` | No-audio and no-caption-logging guard | 8 |
| `desktop/src/live/captureBridge.ts` | Tauri `Channel` for capture events | 9 |
| `ui/screens/live/host.ts` | Typed host wrappers and strict decoders | 9 |
| `ui/screens/live/transcript.ts` | Bounded mutable transcript store (20k rows, O(1) replace) | 9 |
| `ui/screens/live/LiveScreen.tsx`, `PermissionCard.tsx`, `TranscriptList.tsx`, `RecoveryList.tsx`, `index.tsx`, `live.css` | The Live screen | 10, 12 |
| `ui/screens/shell/sections.ts`, `screens.tsx`, `toolbar-model.ts`, `tests/toolbar.test.mjs` | Section registration | 10 |
| `ui/screens/shell/live-status.ts`, `LiveBanner.tsx`, `Shell.tsx` | App-wide recording banner | 11 |
| `ui/screens/live/tests/*.test.*` | UI tests | 9 to 12 |
| `desktop/package.json` | Add the live tests to `npm test` | 9 |
| `docs/how-to/desktop-live-capture.md`, parity checklist section 10, MASTER-PLAN S2, USER-NEEDS UN-035 note | Docs | 13 |

---

## C. Tasks

### Task 1: Caption content rules in Rust, pinned to the extension by a shared fixture

**Files:**
- Create: `desktop/src-tauri/tests/fixtures/captions/validation-cases.json`
- Create: `desktop/src-tauri/src/capture_validate.rs`
- Create: `extension/tests/caption-validation-parity.test.ts`
- Modify: `desktop/src-tauri/src/lib.rs` (add `mod capture_validate;` next to `mod ax_probe;`, line 4)

**Interfaces:**
- Produces: `pub const UNKNOWN_SPEAKER: &str`, `pub fn sanitize_speaker(raw: &str) -> String` (may return `""`), `pub fn sanitize_text(raw: &str) -> String`, `pub fn is_valid_caption(speaker: &str, text: &str) -> bool`, `pub type Line = (String, String)`, `pub fn clean_lines(lines: Vec<Line>) -> Vec<Line>` (sanitize, empty speaker becomes `"Unknown"`, drop invalid).

Background: the TypeScript rules are in `extension/src/content/caption-validation.ts:17-98`. JS `\b` and `\d` are ASCII-only, while Rust `regex` has Unicode `\b` and `\d` and no look-behind. So word boundaries are written as explicit ASCII classes (`(?:^|[^A-Za-z0-9_])` before a word and `(?:$|[^A-Za-z0-9_])` after one), digits as `[0-9]`, and the `(?:\b|(?<=[\s:-]))` tail of `UI_PATTERNS` becomes two groups: alternatives that end in a word character need the boundary, and alternatives that end in a space, colon or dash need nothing.

- [ ] **Step 1: Write the shared fixture**

`desktop/src-tauri/tests/fixtures/captions/validation-cases.json`:

```json
{
  "note": "Expected values are the TypeScript answers (extension/src/content/caption-validation.ts). If the extension parity test fails on a case, the fixture is wrong: fix the fixture, never the TypeScript.",
  "sanitize": [
    { "in": "Tanaka & 2 others", "out": "Tanaka" },
    { "in": "Bob ＆ 3 more", "out": "Bob" },
    { "in": "田中 他2名", "out": "田中" },
    { "in": "  Alice\u0007  Smith ", "out": "Alice Smith" },
    { "in": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "out": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { "in": "Callum", "out": "Callum" }
  ],
  "valid": [
    { "speaker": "Tanaka", "text": "はい。", "valid": true },
    { "speaker": "Callum", "text": "Let's start.", "valid": true },
    { "speaker": "Alice", "text": "Moreover, the plan is fine.", "valid": true },
    { "speaker": "Bob", "text": "Share your screen, please.", "valid": true },
    { "speaker": "Carol", "text": "Let's chat tomorrow.", "valid": true },
    { "speaker": "Dana", "text": "Can you raise that?", "valid": true },
    { "speaker": "Unknown", "text": "Thanks, everyone.", "valid": true },
    { "speaker": "Turn off microphone", "text": "Hello.", "valid": false },
    { "speaker": "Alice", "text": "Turn off captions", "valid": false },
    { "speaker": "Alice", "text": "More options", "valid": false },
    { "speaker": "Alice", "text": "Share screen", "valid": false },
    { "speaker": "Alice", "text": "chat", "valid": false },
    { "speaker": "8:41", "text": "Hello there.", "valid": false },
    { "speaker": "ume-xkgs-oqf", "text": "Hello.", "valid": false },
    { "speaker": "Live captions", "text": "Hello.", "valid": false },
    { "speaker": "Alice", "text": "frame_person", "valid": false },
    { "speaker": "Alice", "text": "visual_effects blur", "valid": false },
    { "speaker": "Alice", "text": "+81 3-4545-0450", "valid": false },
    { "speaker": "Alice", "text": "42", "valid": false },
    { "speaker": "Alice", "text": "", "valid": false },
    { "speaker": "", "text": "Hello.", "valid": false },
    { "speaker": "one two three four five six", "text": "Hello.", "valid": false }
  ]
}
```

- [ ] **Step 2: Write the extension parity test (it proves the fixture is TS truth)**

`extension/tests/caption-validation-parity.test.ts`:

```ts
// The desktop's Rust caption rules (desktop/src-tauri/src/capture_validate.rs) run the same fixture.
// Run: npm test -- tests/caption-validation-parity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidCaption, sanitizeSpeaker } from '../src/content/caption-validation.ts';

const cases = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tests/fixtures/captions/validation-cases.json', import.meta.url), 'utf8'));

test('shared fixture: sanitizeSpeaker answers', () => {
  for (const c of cases.sanitize) assert.equal(sanitizeSpeaker(c.in), c.out, JSON.stringify(c.in));
});

test('shared fixture: isValidCaption answers', () => {
  for (const c of cases.valid) assert.equal(isValidCaption(c.speaker, c.text), c.valid, JSON.stringify(c));
});
```

- [ ] **Step 3: Run it**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test --experimental-strip-types tests/caption-validation-parity.test.ts`
Expected: PASS. If a case fails, correct that case's expected value in the fixture to the TypeScript answer and re-run. Never change `caption-validation.ts`.

- [ ] **Step 4: Write the failing Rust test module and the module skeleton**

Create `desktop/src-tauri/src/capture_validate.rs` containing only the tests and empty signatures:

```rust
//! Caption content rules for the desktop capture (port of extension/src/content/caption-validation.ts).

pub const UNKNOWN_SPEAKER: &str = "Unknown";
pub type Line = (String, String);

pub fn sanitize_speaker(_raw: &str) -> String { unimplemented!() }
pub fn sanitize_text(_raw: &str) -> String { unimplemented!() }
pub fn is_valid_caption(_speaker: &str, _text: &str) -> bool { unimplemented!() }
pub fn clean_lines(_lines: Vec<Line>) -> Vec<Line> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/captions/validation-cases.json")).expect("fixture")
    }

    #[test]
    fn capture_validate_sanitize_matches_fixture() {
        for c in cases()["sanitize"].as_array().unwrap() {
            assert_eq!(sanitize_speaker(c["in"].as_str().unwrap()), c["out"].as_str().unwrap(), "{c}");
        }
    }

    #[test]
    fn capture_validate_validity_matches_fixture() {
        for c in cases()["valid"].as_array().unwrap() {
            let got = is_valid_caption(c["speaker"].as_str().unwrap(), c["text"].as_str().unwrap());
            assert_eq!(got, c["valid"].as_bool().unwrap(), "{c}");
        }
    }

    #[test]
    fn capture_validate_clean_lines_names_unknown_and_drops_ui() {
        let out = clean_lines(vec![
            ("  ".into(), "Thanks, everyone.".into()),
            ("Alice & 2 others".into(), "Hello\nthere.".into()),
            ("Unknown".into(), "Turn off captions".into()),
        ]);
        assert_eq!(out, vec![("Unknown".into(), "Thanks, everyone.".into()), ("Alice".into(), "Hello there.".into())]);
    }

    #[test]
    fn capture_validate_text_is_capped_not_dropped() {
        let long = "word ".repeat(600);
        let t = sanitize_text(&long);
        assert!(t.encode_utf16().count() <= 2000);
        assert!(is_valid_caption("Alice", &t));
    }
}
```

Add `mod capture_validate;` to `desktop/src-tauri/src/lib.rs` after `mod ax_probe;`.

- [ ] **Step 5: Run to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_validate`
Expected: FAIL with panics `not implemented`.

- [ ] **Step 6: Implement**

Replace the four `unimplemented!()` bodies (keep the test module) with:

```rust
//! Caption content rules for the desktop capture: a port of extension/src/content/caption-validation.ts
//! (`sanitizeSpeaker`, `isValidCaption`) used on every AX-read line before the delta state sees it.
//! JS `\b` and `\d` are ASCII and the TS uses a look-behind; the Rust `regex` crate has Unicode classes and
//! no look-behind, so boundaries are spelled as ASCII classes. Parity is pinned by
//! tests/fixtures/captions/validation-cases.json, which extension/tests/caption-validation-parity.test.ts runs too.
//! One deliberate difference, kept from the Mac (`CaptionSpeaker.sanitize`): `clean_lines` names an empty
//! speaker "Unknown" instead of dropping the line, because the AX readers already found the row.

use regex::Regex;
use std::sync::OnceLock;

pub const UNKNOWN_SPEAKER: &str = "Unknown";
pub type Line = (String, String);

const MAX_SPEAKER_UNITS: usize = 50;
const MAX_TEXT_UNITS: usize = 2000;
/// ASCII `\b` before a word character / after one (JS semantics).
const BS: &str = r"(?:^|[^A-Za-z0-9_])";
const BE: &str = r"(?:$|[^A-Za-z0-9_])";

const UI_WORD_ALTS: &str = r"present|mute|unmute|camera|more|chat|people|raise|record|share|hang|info|meeting|host|leave|call|keyboard|audio|video|back_hand|mood|apps|lock|closed_caption|format_size|circle|font|settings|open|turn|send|language|japanese|english|live captions|frame_person|visual_effects|reframe|backgrounds|effects|filters|appearance|touch|framing|portrait|blur|lighting|your\s+meeting|dial-in|joining\s+info|attachments|share\s+this|meeting\s+link|meeting\s+code|loading\s+invitees|contributors|just\s+you|[0-9]+\s+joined|save\s+transcript|ask\s+tactiq|chevron_right|chevron_left|expand_more|expand_less|content_copy|return\s+to\s+home|submit\s+feedback|in\s+the\s+meeting|your\s+meet\s+call|secure\s+video|video\s+conferencing|new\s+meeting|enter\s+a\s+code|connect.*collaborate|from\s+your\s+google";
/// Alternatives that end on their own separator: the TS look-behind `(?<=[\s:-])` is always true for them.
const UI_SEP_ALTS: &str = r"ume-|pm\s|am\s|close\s|pin:|copy\s|add\s";
const ICON_TOKENS: &str = "frame_person|visual_effects|closed_caption|format_size|keyboard_arrow|more_vert|call_end|back_hand|lock_person|stop_circle|chevron_right|chevron_left|expand_more|expand_less|content_copy|arrow_back|arrow_forward|open_in_new|check_circle|navigate_next|navigate_before";
const ICON_WORDS: &str = "mic|videocam|computer|reaction|settings|chat|apps|info|mood|raise|filter|cancel";

struct Rules {
    ui: Regex,
    icon_token: Regex,
    icon_word: Regex,
    banner: Regex,
    clock: Regex,
    meet_id: Regex,
    turn: Regex,
    phone: Regex,
    video_call: Regex,
    snake_speaker: Regex,
    digits: Regex,
    combined: Regex,
    combined_ja: Regex,
    control: Regex,
    ws: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| {
        let r = |p: &str| Regex::new(p).expect("static caption regex");
        Rules {
            ui: r(&format!(r"(?i)^(?:(?:{UI_WORD_ALTS}){BE}|(?:{UI_SEP_ALTS}))")),
            icon_token: r(&format!(r"(?i){BS}(?:{ICON_TOKENS}){BE}")),
            icon_word: r(&format!(r"(?i){BS}(?:{ICON_WORDS}){BE}")),
            banner: r(r"(?i)^(?:connect.*collaborate|from\s+your\s+google)"),
            clock: r(r"^[0-9]{1,2}:[0-9]{2}"),
            meet_id: r(r"(?i)^[a-z]{3}-[a-z]{4}-[a-z]{3}"),
            turn: r(&format!(r"(?i){BS}turn (?:off|on){BE}")),
            phone: r(r"\+[0-9]{1,3}[\s-]?[0-9]"),
            // `\bkeyboard\b.*\bJoin\b`: one separator may serve both boundaries.
            video_call: r(&format!(r"(?i){BS}video_call{BE}|{BS}keyboard[^A-Za-z0-9_](?:.*[^A-Za-z0-9_])?Join{BE}")),
            snake_speaker: r(&format!(r"{BS}[a-z]+_[a-z]+{BE}")),
            digits: r(r"^[0-9]{1,3}$"),
            combined: r(&format!(r"(?i)\s*[&＆]\s*[0-9]+\s*(?:others?|more){BE}.*$")),
            // TS: `\s*(他|ほか)\s*\d+\s*(名|人|さん)?\b.*$`; the optional-suffix branch is implied by this one.
            combined_ja: r(r"\s*(?:他|ほか)\s*[0-9]+(?:$|[^A-Za-z0-9_]).*$"),
            control: r(r"[\x00-\x1F\x7F]"),
            ws: r(r"\s+"),
        }
    })
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// First `max` UTF-16 units (JS `slice` semantics), never splitting a character.
fn truncate_units(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for c in s.chars() {
        n += c.len_utf16();
        if n > max {
            break;
        }
        out.push(c);
    }
    out
}

/// `sanitizeSpeaker`: control chars to spaces, combined-speaker suffixes removed, whitespace collapsed,
/// trimmed, at most 50 UTF-16 units. May return "".
pub fn sanitize_speaker(raw: &str) -> String {
    let r = rules();
    let s = r.control.replace_all(raw, " ");
    let s = r.combined.replace(&s, "");
    let s = r.combined_ja.replace(&s, "");
    let s = r.ws.replace_all(&s, " ");
    truncate_units(s.trim(), MAX_SPEAKER_UNITS).trim().to_string()
}

/// Caption text as stored: control chars (newlines included) to spaces, whitespace collapsed, trimmed,
/// capped at 2,000 UTF-16 units (a growing monologue keeps its first 2,000 units rather than vanishing).
pub fn sanitize_text(raw: &str) -> String {
    let r = rules();
    let s = r.control.replace_all(raw, " ");
    let s = r.ws.replace_all(&s, " ");
    truncate_units(s.trim(), MAX_TEXT_UNITS)
}

fn looks_like_ui_label(text: &str) -> bool {
    let t = text.trim();
    rules().ws.split(t).count() <= 5 && !t.ends_with(['.', '?', '!', '…', '。', '？', '！'])
}

fn is_snake_word(w: &str) -> bool {
    match w.split_once('_') {
        Some((a, b)) => {
            !a.is_empty() && !b.is_empty() && a.bytes().all(|c| c.is_ascii_alphabetic()) && b.bytes().all(|c| c.is_ascii_alphabetic())
        }
        None => false,
    }
}

/// `isValidCaption`: content-based, never position-based (invariants.md).
pub fn is_valid_caption(speaker: &str, text: &str) -> bool {
    let r = rules();
    let (su, tu) = (units(speaker), units(text));
    if su < 1 || su > MAX_SPEAKER_UNITS || tu < 1 || tu > MAX_TEXT_UNITS {
        return false;
    }
    if r.ui.is_match(speaker) || r.icon_token.is_match(speaker) || r.icon_word.is_match(speaker) {
        return false;
    }
    if r.clock.is_match(speaker) || r.meet_id.is_match(speaker) {
        return false;
    }
    if r.ws.split(speaker).count() > 5 {
        return false;
    }
    if r.icon_token.is_match(text) || r.banner.is_match(text) {
        return false;
    }
    if looks_like_ui_label(text) && (r.ui.is_match(text) || r.icon_word.is_match(text) || r.turn.is_match(text)) {
        return false;
    }
    if r.phone.is_match(text) || r.video_call.is_match(text) {
        return false;
    }
    if r.snake_speaker.is_match(speaker) {
        return false;
    }
    if r.ws.split(text).all(is_snake_word) {
        return false;
    }
    !r.digits.is_match(text.trim())
}

/// Reader output -> what the delta state sees: sanitized, "Unknown" for an empty speaker, invalid lines dropped.
pub fn clean_lines(lines: Vec<Line>) -> Vec<Line> {
    lines
        .into_iter()
        .filter_map(|(speaker, text)| {
            let mut s = sanitize_speaker(&speaker);
            if s.is_empty() {
                s = UNKNOWN_SPEAKER.to_string();
            }
            let t = sanitize_text(&text);
            is_valid_caption(&s, &t).then_some((s, t))
        })
        .collect()
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_validate`
Expected: PASS (4 tests). If a fixture case fails here but passes in TS, the Rust port is wrong. Fix the regex, never the fixture.

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/tests/fixtures/captions/validation-cases.json desktop/src-tauri/src/capture_validate.rs desktop/src-tauri/src/lib.rs extension/tests/caption-validation-parity.test.ts
git commit -m "feat(desktop): caption content rules in Rust, pinned to the extension by a shared fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Row delta state (port of `CaptionDeltaState`)

**Files:**
- Create: `desktop/src-tauri/src/capture_delta.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`mod capture_delta;`)

**Interfaces:**
- Consumes: `capture_validate::Line`.
- Produces: `pub enum CaptionDelta { Append { row: u64, speaker: String, text: String }, Replace { row: u64, speaker: String, old_text: String, new_text: String }, Closed { row: u64 } }`, `pub struct DeltaState` with `pub fn new() -> Self` and `pub fn ingest(&mut self, snapshot: &[Line]) -> Vec<CaptionDelta>`, `pub const MAX_EMPTY_TICKS: u32 = 13`, `pub fn align(prev: &[(&str, &str)], cur: &[(&str, &str)]) -> Vec<Option<usize>>`.

Why this, and not the extension's `Map<speaker, {sessionId, text, lastSeen}>`: the extension sees one DOM element per speaker, while AX returns the **whole panel** on every read. The Mac's `CaptionDeltaState` is the AX form of "per-speaker state, send only on change". It aligns rows in order, treats a line as growth only when the same speaker's old text is a word-boundary prefix that has left the screen, and reports nothing for unchanged lines. `MAX_EMPTY_TICKS` is 13 here (about 10 s at 800 ms; the Mac's 40 is 10 s at 250 ms).

- [ ] **Step 1: Write the failing tests (ported from `mac/Tests/LlmIdeMacTests/CaptionDeltaStateTests.swift`)**

Create `desktop/src-tauri/src/capture_delta.rs` with stub signatures and this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn lines(xs: &[(&str, &str)]) -> Vec<Line> {
        xs.iter().map(|(s, t)| (s.to_string(), t.to_string())).collect()
    }

    /// Applies deltas to (row, speaker, text) rows; a replace of a missing row appends (Swift `apply`).
    fn apply(ds: &[CaptionDelta], rows: &mut Vec<(u64, String, String)>) {
        for d in ds {
            match d {
                CaptionDelta::Append { row, speaker, text } => rows.push((*row, speaker.clone(), text.clone())),
                CaptionDelta::Replace { row, speaker, new_text, .. } => match rows.iter_mut().find(|r| r.0 == *row) {
                    Some(r) => *r = (*row, speaker.clone(), new_text.clone()),
                    None => rows.push((*row, speaker.clone(), new_text.clone())),
                },
                CaptionDelta::Closed { .. } => {}
            }
        }
    }

    fn run(frames: &[Vec<Line>]) -> Vec<String> {
        let mut st = DeltaState::new();
        let mut rows = Vec::new();
        for f in frames {
            apply(&st.ingest(f), &mut rows);
        }
        rows.into_iter().map(|(_, s, t)| format!("{s}:{t}")).collect()
    }

    #[test]
    fn capture_delta_unchanged_snapshot_emits_nothing_after_first() {
        let mut st = DeltaState::new();
        assert_eq!(st.ingest(&lines(&[("A", "Hello")])), vec![CaptionDelta::Append { row: 0, speaker: "A".into(), text: "Hello".into() }]);
        assert!(st.ingest(&lines(&[("A", "Hello")])).is_empty());
        assert!(st.ingest(&lines(&[("A", "Hello")])).is_empty());
    }

    #[test]
    fn capture_delta_growth_replaces_in_place() {
        let mut st = DeltaState::new();
        st.ingest(&lines(&[("A", "Hello")]));
        assert_eq!(
            st.ingest(&lines(&[("A", "Hello there")])),
            vec![CaptionDelta::Replace { row: 0, speaker: "A".into(), old_text: "Hello".into(), new_text: "Hello there".into() }]
        );
        assert_eq!(run(&[lines(&[("A", "Hello")]), lines(&[("A", "Hello there")]), lines(&[("A", "Hello there again")])]), vec!["A:Hello there again"]);
    }

    #[test]
    fn capture_delta_repeated_text_after_other_speaker_is_kept() {
        let got = run(&[lines(&[("A", "Yes.")]), lines(&[("A", "Yes."), ("B", "Agreed?")]), lines(&[("A", "Yes."), ("B", "Agreed?"), ("A", "Yes.")])]);
        assert_eq!(got, vec!["A:Yes.", "B:Agreed?", "A:Yes."]);
    }

    #[test]
    fn capture_delta_same_text_two_speakers_and_twice_on_screen() {
        assert_eq!(run(&[lines(&[("A", "OK"), ("B", "OK")])]), vec!["A:OK", "B:OK"]);
        assert_eq!(run(&[lines(&[("A", "OK"), ("B", "Hmm"), ("A", "OK")])]), vec!["A:OK", "B:Hmm", "A:OK"]);
    }

    #[test]
    fn capture_delta_unknown_speakers_do_not_collapse() {
        let got = run(&[
            lines(&[("Unknown", "Thanks")]),
            lines(&[("Unknown", "Thanks"), ("Unknown", "Yes")]),
            lines(&[("Unknown", "Thanks"), ("Unknown", "Yes"), ("Unknown", "Thanks")]),
        ]);
        assert_eq!(got, vec!["Unknown:Thanks", "Unknown:Yes", "Unknown:Thanks"]);
    }

    #[test]
    fn capture_delta_prefix_rules() {
        assert_eq!(run(&[lines(&[("A", "Yes.")]), lines(&[("A", "Yes."), ("A", "Yes. Let's ship it.")])]), vec!["A:Yes.", "A:Yes. Let's ship it."]);
        assert_eq!(run(&[lines(&[("A", "No")]), lines(&[("A", "Nothing else")])]), vec!["A:No", "A:Nothing else"]);
        assert_eq!(run(&[lines(&[("A", "はい")]), lines(&[("A", "はいそうです")])]), vec!["A:はいそうです"], "CJK growth has no spaces");
    }

    #[test]
    fn capture_delta_interleaved_growth_replaces_original_row() {
        let got = run(&[lines(&[("A", "Hello")]), lines(&[("A", "Hello"), ("B", "Hi")]), lines(&[("A", "Hello there, team"), ("B", "Hi")])]);
        assert_eq!(got, vec!["A:Hello there, team", "B:Hi"]);
    }

    #[test]
    fn capture_delta_scrolled_off_line_closes_and_can_reappear() {
        let mut st = DeltaState::new();
        st.ingest(&lines(&[("A", "One"), ("B", "Two")]));
        assert_eq!(
            st.ingest(&lines(&[("B", "Two"), ("A", "Three")])),
            vec![CaptionDelta::Append { row: 2, speaker: "A".into(), text: "Three".into() }, CaptionDelta::Closed { row: 0 }]
        );
        assert_eq!(st.ingest(&lines(&[("B", "Two"), ("A", "Three"), ("A", "One")])), vec![CaptionDelta::Append { row: 3, speaker: "A".into(), text: "One".into() }]);
    }

    #[test]
    fn capture_delta_empty_flicker_then_long_empty_closes() {
        let mut st = DeltaState::new();
        st.ingest(&lines(&[("A", "Hello")]));
        assert!(st.ingest(&[]).is_empty());
        assert!(st.ingest(&lines(&[("A", "Hello")])).is_empty());
        let mut last = Vec::new();
        for _ in 0..MAX_EMPTY_TICKS {
            last = st.ingest(&[]);
        }
        assert_eq!(last, vec![CaptionDelta::Closed { row: 0 }]);
    }

    fn reference_lcs(prev: &[(&str, &str)], cur: &[(&str, &str)]) -> usize {
        let mut t = vec![vec![0usize; cur.len() + 1]; prev.len() + 1];
        for i in (0..prev.len()).rev() {
            for j in (0..cur.len()).rev() {
                t[i][j] = if prev[i] == cur[j] { t[i + 1][j + 1] + 1 } else { t[i + 1][j].max(t[i][j + 1]) };
            }
        }
        t[0][0]
    }

    #[test]
    fn capture_delta_alignment_is_a_maximum_in_order_matching() {
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = |bound: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % bound
        };
        let names = ["S0", "S1"];
        let texts = ["t0", "t1", "t2", "t3", "t4"];
        for _ in 0..300 {
            let p: Vec<(&str, &str)> = (0..next(12)).map(|_| (names[next(2) as usize], texts[next(5) as usize])).collect();
            let c: Vec<(&str, &str)> = (0..next(12)).map(|_| (names[next(2) as usize], texts[next(5) as usize])).collect();
            let a = align(&p, &c);
            let pairs: Vec<(usize, usize)> = a.iter().enumerate().filter_map(|(j, i)| i.map(|i| (i, j))).collect();
            assert_eq!(pairs.len(), reference_lcs(&p, &c));
            for w in pairs.windows(2) {
                assert!(w[0].0 < w[1].0 && w[0].1 < w[1].1, "in order");
            }
            for (i, j) in pairs {
                assert_eq!(p[i], c[j]);
            }
        }
    }

    #[test]
    fn capture_delta_identical_2000_rows_align_without_table() {
        let owned: Vec<String> = (0..2000).map(|i| format!("line {i}")).collect();
        let keys: Vec<(&str, &str)> = owned.iter().map(|t| ("A", t.as_str())).collect();
        let started = std::time::Instant::now();
        assert_eq!(align(&keys, &keys), (0..2000).map(Some).collect::<Vec<_>>());
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
    }
}
```

Stub signatures above the tests:

```rust
use crate::capture_validate::Line;
pub const MAX_EMPTY_TICKS: u32 = 13;
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum CaptionDelta { Append { row: u64, speaker: String, text: String }, Replace { row: u64, speaker: String, old_text: String, new_text: String }, Closed { row: u64 } }
#[derive(Debug, Default)]
pub struct DeltaState;
impl DeltaState { pub fn new() -> Self { Self } pub fn ingest(&mut self, _s: &[Line]) -> Vec<CaptionDelta> { unimplemented!() } }
pub fn align(_p: &[(&str, &str)], _c: &[(&str, &str)]) -> Vec<Option<usize>> { unimplemented!() }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_delta`
Expected: FAIL (`not implemented`).

- [ ] **Step 3: Implement (replace the stubs, keep the tests)**

```rust
//! Snapshot -> row deltas for AX-read captions: a port of the Mac's `CaptionDeltaState`
//! (mac/Sources/LlmIdeMac/Features/Live/Services/CaptionDeltaState.swift). AX returns every on-screen line on
//! every read, so each snapshot is aligned with the previous one as an in-order multiset (LCS), never a set.
//! A line aligned with a previous line is unchanged (no delta). A line is GROWTH only if a previous line from the
//! same speaker is a word-boundary prefix of it AND that old text is no longer on screen. Anything else is new.
//! Input lines are already cleaned (capture_validate::clean_lines); this module does not sanitize again.

use std::collections::HashSet;

use serde::Serialize;

use crate::capture_validate::Line;

/// Consecutive empty snapshots tolerated before the on-screen rows are closed (about 10 s at 800 ms).
pub const MAX_EMPTY_TICKS: u32 = 13;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptionDelta {
    /// A new utterance; row ids are never reused within one state.
    Append { row: u64, speaker: String, text: String },
    /// The utterance in `row` grew in place.
    Replace { row: u64, speaker: String, old_text: String, new_text: String },
    /// The row left the screen and will never grow again: safe to persist.
    Closed { row: u64 },
}

#[derive(Debug, Clone)]
struct Entry {
    row: u64,
    speaker: String,
    text: String,
}

#[derive(Debug, Default)]
pub struct DeltaState {
    previous: Vec<Entry>,
    next_row: u64,
    empty_streak: u32,
}

impl DeltaState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ingest(&mut self, snapshot: &[Line]) -> Vec<CaptionDelta> {
        if snapshot.is_empty() {
            self.empty_streak += 1;
            if self.empty_streak < MAX_EMPTY_TICKS || self.previous.is_empty() {
                return Vec::new();
            }
            let closed = self.previous.iter().map(|e| CaptionDelta::Closed { row: e.row }).collect();
            self.previous.clear();
            return closed;
        }
        self.empty_streak = 0;
        let prev_keys: Vec<(&str, &str)> = self.previous.iter().map(|e| (e.speaker.as_str(), e.text.as_str())).collect();
        let cur_keys: Vec<(&str, &str)> = snapshot.iter().map(|(s, t)| (s.as_str(), t.as_str())).collect();
        let aligned = align(&prev_keys, &cur_keys);
        let matched: HashSet<usize> = aligned.iter().flatten().copied().collect();
        let on_screen: HashSet<(&str, &str)> = cur_keys.iter().copied().collect();
        let candidates: Vec<usize> = (0..self.previous.len()).filter(|i| !matched.contains(i) && !on_screen.contains(&prev_keys[*i])).collect();
        let mut claimed: HashSet<usize> = HashSet::new();
        let mut deltas = Vec::new();
        let mut current = Vec::with_capacity(snapshot.len());
        for (j, (speaker, text)) in snapshot.iter().enumerate() {
            if let Some(i) = aligned[j] {
                current.push(self.previous[i].clone());
                continue;
            }
            if let Some(i) = self.growth_source(speaker, text, j, &candidates, &claimed) {
                claimed.insert(i);
                let old = &self.previous[i];
                deltas.push(CaptionDelta::Replace { row: old.row, speaker: speaker.clone(), old_text: old.text.clone(), new_text: text.clone() });
                current.push(Entry { row: old.row, speaker: speaker.clone(), text: text.clone() });
            } else {
                let row = self.next_row;
                self.next_row += 1;
                deltas.push(CaptionDelta::Append { row, speaker: speaker.clone(), text: text.clone() });
                current.push(Entry { row, speaker: speaker.clone(), text: text.clone() });
            }
        }
        for (i, old) in self.previous.iter().enumerate() {
            if !matched.contains(&i) && !claimed.contains(&i) {
                deltas.push(CaptionDelta::Closed { row: old.row });
            }
        }
        self.previous = current;
        deltas
    }

    /// The nearest unclaimed candidate with the same speaker that `text` grew from (first on ties, like Swift).
    fn growth_source(&self, speaker: &str, text: &str, j: usize, candidates: &[usize], taken: &HashSet<usize>) -> Option<usize> {
        candidates
            .iter()
            .copied()
            .filter(|i| !taken.contains(i))
            .filter(|&i| self.previous[i].speaker == speaker && is_growth(&self.previous[i].text, text))
            .min_by_key(|&i| i.abs_diff(j))
    }
}

/// `new` strictly extends `old` at a word or punctuation boundary ("No" -> "Nothing" is not growth).
/// Only ASCII letters and digits count as word characters: CJK has no spaces, so growth there is mid-"word".
fn is_growth(old: &str, new: &str) -> bool {
    if old.is_empty() || new.len() <= old.len() || !new.starts_with(old) {
        return false;
    }
    match (old.chars().next_back(), new[old.len()..].chars().next()) {
        (Some(a), Some(b)) => !(a.is_ascii_alphanumeric() && b.is_ascii_alphanumeric()),
        _ => false,
    }
}

/// For each snapshot index, the previous index it aligns with: a maximum-size in-order matching (LCS) on exact
/// (speaker, text). Lines present on one side only are filtered out and the common head and tail are matched
/// directly, so an unchanged or scrolled snapshot is O(n); the table covers only the changed middle.
pub fn align(prev: &[(&str, &str)], cur: &[(&str, &str)]) -> Vec<Option<usize>> {
    let mut result = vec![None; cur.len()];
    if prev.is_empty() || cur.is_empty() {
        return result;
    }
    let prev_set: HashSet<(&str, &str)> = prev.iter().copied().collect();
    let cur_set: HashSet<(&str, &str)> = cur.iter().copied().collect();
    let p: Vec<usize> = (0..prev.len()).filter(|&i| cur_set.contains(&prev[i])).collect();
    let c: Vec<usize> = (0..cur.len()).filter(|&j| prev_set.contains(&cur[j])).collect();
    let limit = p.len().min(c.len());
    let mut head = 0;
    while head < limit && prev[p[head]] == cur[c[head]] {
        result[c[head]] = Some(p[head]);
        head += 1;
    }
    let mut tail = 0;
    while tail < limit - head && prev[p[p.len() - 1 - tail]] == cur[c[c.len() - 1 - tail]] {
        result[c[c.len() - 1 - tail]] = Some(p[p.len() - 1 - tail]);
        tail += 1;
    }
    let rows = p.len() - head - tail;
    let cols = c.len() - head - tail;
    if rows == 0 || cols == 0 {
        return result;
    }
    let eq = |i: usize, j: usize| prev[p[head + i]] == cur[c[head + j]];
    let w = cols + 1;
    let mut t = vec![0u32; (rows + 1) * w];
    for i in (0..rows).rev() {
        for j in (0..cols).rev() {
            t[i * w + j] = if eq(i, j) { t[(i + 1) * w + j + 1] + 1 } else { t[(i + 1) * w + j].max(t[i * w + j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < rows && j < cols {
        if eq(i, j) {
            result[c[head + j]] = Some(p[head + i]);
            i += 1;
            j += 1;
        } else if t[(i + 1) * w + j] >= t[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    result
}
```

Add `mod capture_delta;` to `lib.rs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_delta`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/capture_delta.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): port the caption row delta state to Rust

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: AX tree model and the Zoom and Teams readers, tested on JSON fixtures

**Files:**
- Create: `desktop/src-tauri/src/capture_model.rs`
- Create: `desktop/src-tauri/src/capture_readers.rs`
- Create: `desktop/src-tauri/tests/fixtures/captions/zoom-basic.json`, `zoom-ja.json`, `zoom-no-panel.json`, `teams-structured.json`, `teams-flat.json`, `teams-no-panel.json`, `teams-growth-sequence.json`
- Modify: `desktop/src-tauri/src/lib.rs` (`mod capture_model; mod capture_readers;`)

**Interfaces:**
- Produces (model): `#[serde(rename_all = "camelCase")] pub struct AxNode { pub role: String, pub title: Option<String>, pub description: Option<String>, pub value: Option<String>, pub children: Vec<AxNode> }`, `pub struct AxAppTree { pub bundle_id: String, pub windows: Vec<AxNode> }`, `pub enum AxReadError { PermissionDenied, CannotComplete, Unsupported }`.
- Produces (readers): `pub trait CaptionReader: Send + Sync { fn platform(&self) -> &'static str; fn bundle_id(&self) -> &'static str; fn read(&self, app: &AxAppTree) -> Option<Vec<Line>>; }` (`None` means the captions panel is not in the tree), `pub struct ZoomReader;`, `pub struct TeamsReader;`, `pub fn all_readers() -> Vec<Box<dyn CaptionReader>>` (Zoom first, like `PlatformDetector.allScrapers`), `pub fn pair_caption_rows(groups: &[Vec<String>]) -> Vec<Line>`.

The tree carries only the four attributes the readers use: `title` (windows), `description` (groups), `value` (static text) and `role`. Task 5 reads only those, which keeps IPC low and keeps the rest of the meeting window's text out of memory.

- [ ] **Step 1: Write the model**

`desktop/src-tauri/src/capture_model.rs`:

```rust
//! The accessibility tree as the capture readers see it: a plain value type, so the readers run on JSON
//! fixtures in tests and on a live AX read (capture_ax_macos.rs) in the app. Only the attributes the readers
//! use are carried: role always, title on windows, description on groups, value on static text.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxNode {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<AxNode>,
}

/// One running meeting app: its windows, in AXWindows order.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxAppTree {
    pub bundle_id: String,
    pub windows: Vec<AxNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AxReadError {
    /// kAXErrorAPIDisabled or AXIsProcessTrusted() false: Accessibility is not granted (or was revoked).
    PermissionDenied,
    /// kAXErrorCannotComplete or the read deadline: the app did not answer in time. Skip this tick.
    CannotComplete,
    /// No AX backend on this OS (yet).
    Unsupported,
}
```

- [ ] **Step 2: Write the fixtures**

`desktop/src-tauri/tests/fixtures/captions/zoom-basic.json` (synthetic, shaped like `ZoomCaptionScraper.swift`'s comment: a separate window whose title contains "Caption", with one `AXStaticText` per line in the form "Speaker\nText"):

```json
{
  "name": "zoom: speaker lines, an anonymous line, a UI label, a blank, and a toolbar in another window",
  "reader": "zoom",
  "app": { "bundleId": "us.zoom.xos", "windows": [
    { "role": "AXWindow", "title": "Zoom Meeting", "children": [ { "role": "AXStaticText", "value": "Mute" } ] },
    { "role": "AXWindow", "title": "Captions and Subtitles", "children": [
      { "role": "AXScrollArea", "children": [
        { "role": "AXStaticText", "value": "Tanaka\nLet's start the demo." },
        { "role": "AXStaticText", "value": "Alice & 2 others\nI can see your screen." },
        { "role": "AXStaticText", "value": "Thanks, everyone." },
        { "role": "AXStaticText", "value": "Turn off captions" },
        { "role": "AXStaticText", "value": "   " }
      ] }
    ] }
  ] },
  "raw": [["Tanaka", "Let's start the demo."], ["Alice & 2 others", "I can see your screen."], ["Unknown", "Thanks, everyone."], ["Unknown", "Turn off captions"]],
  "clean": [["Tanaka", "Let's start the demo."], ["Alice", "I can see your screen."], ["Unknown", "Thanks, everyone."]]
}
```

`zoom-ja.json`:

```json
{
  "name": "zoom: Japanese window title, short Japanese caption, combined-speaker suffix",
  "reader": "zoom",
  "app": { "bundleId": "us.zoom.xos", "windows": [
    { "role": "AXWindow", "title": "字幕", "children": [
      { "role": "AXStaticText", "value": "田中 他2名\nはい。" },
      { "role": "AXStaticText", "value": "佐藤\n了解です。" }
    ] }
  ] },
  "raw": [["田中 他2名", "はい。"], ["佐藤", "了解です。"]],
  "clean": [["田中", "はい。"], ["佐藤", "了解です。"]]
}
```

`zoom-no-panel.json`:

```json
{
  "name": "zoom: meeting open, captions panel closed",
  "reader": "zoom",
  "app": { "bundleId": "us.zoom.xos", "windows": [ { "role": "AXWindow", "title": "Zoom Meeting", "children": [ { "role": "AXStaticText", "value": "Tanaka" } ] } ] },
  "raw": null,
  "clean": null
}
```

`teams-structured.json` (synthetic, shaped like `TeamsCaptionScraper.swift`'s comment: an `AXGroup` described "Live captions" with one child group per row, speaker first; a one-text row continues the previous speaker):

```json
{
  "name": "teams: structured rows, multi-text body, continuation line, toolbar group ignored",
  "reader": "teams",
  "app": { "bundleId": "com.microsoft.teams2", "windows": [
    { "role": "AXWindow", "title": "Meeting | Microsoft Teams", "children": [
      { "role": "AXGroup", "description": "Toolbar", "children": [ { "role": "AXStaticText", "value": "Leave" } ] },
      { "role": "AXGroup", "description": "Live Captions", "children": [
        { "role": "AXGroup", "children": [ { "role": "AXStaticText", "value": "Alice Smith" }, { "role": "AXStaticText", "value": "Hello team." } ] },
        { "role": "AXGroup", "children": [ { "role": "AXStaticText", "value": "Bob" }, { "role": "AXStaticText", "value": "Morning." }, { "role": "AXStaticText", "value": "Shall we start?" } ] },
        { "role": "AXGroup", "children": [ { "role": "AXStaticText", "value": "Yes, let's go." } ] }
      ] }
    ] }
  ] },
  "raw": [["Alice Smith", "Hello team."], ["Bob", "Morning. Shall we start?"], ["Bob", "Yes, let's go."]],
  "clean": [["Alice Smith", "Hello team."], ["Bob", "Morning. Shall we start?"], ["Bob", "Yes, let's go."]]
}
```

`teams-flat.json`:

```json
{
  "name": "teams: every text under one parent, alternate speaker/body",
  "reader": "teams",
  "app": { "bundleId": "com.microsoft.teams2", "windows": [
    { "role": "AXWindow", "title": "Meeting", "children": [
      { "role": "AXGroup", "description": "live captions", "children": [
        { "role": "AXStaticText", "value": "Alice" }, { "role": "AXStaticText", "value": "Hi there." },
        { "role": "AXStaticText", "value": "Bob" }, { "role": "AXStaticText", "value": "Hey." }
      ] }
    ] }
  ] },
  "raw": [["Alice", "Hi there."], ["Bob", "Hey."]],
  "clean": [["Alice", "Hi there."], ["Bob", "Hey."]]
}
```

`teams-no-panel.json`:

```json
{
  "name": "teams: running, no captions group",
  "reader": "teams",
  "app": { "bundleId": "com.microsoft.teams2", "windows": [ { "role": "AXWindow", "title": "Chat", "children": [ { "role": "AXGroup", "description": "Chat list" } ] } ] },
  "raw": null,
  "clean": null
}
```

`teams-growth-sequence.json`:

```json
{
  "name": "teams: one utterance grows over three reads, a second speaker joins",
  "reader": "teams",
  "frames": [
    { "bundleId": "com.microsoft.teams2", "windows": [ { "role": "AXWindow", "children": [ { "role": "AXGroup", "description": "Live captions", "children": [
      { "role": "AXGroup", "children": [ { "role": "AXStaticText", "value": "Alice" }, { "role": "AXStaticText", "value": "Hello" } ] } ] } ] } ] },
    { "bundleId": "com.microsoft.teams2", "windows": [ { "role": "AXWindow", "children": [ { "role": "AXGroup", "description": "Live captions", "children": [
      { "role": "AXGroup", "children": [ { "role": "AXStaticText", "value": "Alice" }, { "role": "AXStaticText", "value": "Hello there," } ] } ] } ] } ] },
    { "bundleId": "com.microsoft.teams2", "windows": [ { "role": "AXWindow", "children": [ { "role": "AXGroup", "description": "Live captions", "children": [
      { "role": "AXGroup", "children": [ { "role": "AXStaticText", "value": "Alice" }, { "role": "AXStaticText", "value": "Hello there, team." } ] },
      { "role": "AXGroup", "children": [ { "role": "AXStaticText", "value": "Bob" }, { "role": "AXStaticText", "value": "Hi." } ] } ] } ] } ] }
  ],
  "deltaKinds": ["append", "replace", "replace", "append"],
  "finalRows": [["Alice", "Hello there, team."], ["Bob", "Hi."]]
}
```

- [ ] **Step 3: Write the failing reader tests**

At the bottom of `desktop/src-tauri/src/capture_readers.rs` (stub `pub fn all_readers() -> Vec<Box<dyn CaptionReader>> { unimplemented!() }` and the trait first):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_delta::{CaptionDelta, DeltaState};
    use crate::capture_validate::clean_lines;
    use serde_json::Value;

    const FIXTURES: &[(&str, &str)] = &[
        ("zoom-basic", include_str!("../tests/fixtures/captions/zoom-basic.json")),
        ("zoom-ja", include_str!("../tests/fixtures/captions/zoom-ja.json")),
        ("zoom-no-panel", include_str!("../tests/fixtures/captions/zoom-no-panel.json")),
        ("teams-structured", include_str!("../tests/fixtures/captions/teams-structured.json")),
        ("teams-flat", include_str!("../tests/fixtures/captions/teams-flat.json")),
        ("teams-no-panel", include_str!("../tests/fixtures/captions/teams-no-panel.json")),
    ];

    fn reader(name: &str) -> Box<dyn CaptionReader> {
        all_readers().into_iter().find(|r| r.platform() == name).expect("reader")
    }

    fn rows(v: &Value) -> Option<Vec<Line>> {
        v.as_array().map(|a| a.iter().map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string())).collect())
    }

    #[test]
    fn capture_readers_fixtures_raw_and_clean() {
        for (name, src) in FIXTURES {
            let fx: Value = serde_json::from_str(src).unwrap();
            let app: AxAppTree = serde_json::from_value(fx["app"].clone()).unwrap();
            let r = reader(fx["reader"].as_str().unwrap());
            let raw = r.read(&app);
            assert_eq!(raw, rows(&fx["raw"]), "{name} raw");
            assert_eq!(raw.map(clean_lines), rows(&fx["clean"]), "{name} clean");
        }
    }

    #[test]
    fn capture_readers_teams_growth_sequence() {
        let fx: Value = serde_json::from_str(include_str!("../tests/fixtures/captions/teams-growth-sequence.json")).unwrap();
        let r = reader("teams");
        let mut st = DeltaState::new();
        let mut kinds = Vec::new();
        let mut table: Vec<(u64, String, String)> = Vec::new();
        for f in fx["frames"].as_array().unwrap() {
            let app: AxAppTree = serde_json::from_value(f.clone()).unwrap();
            for d in st.ingest(&clean_lines(r.read(&app).unwrap())) {
                match d {
                    CaptionDelta::Append { row, speaker, text } => { kinds.push("append"); table.push((row, speaker, text)); }
                    CaptionDelta::Replace { row, new_text, .. } => { kinds.push("replace"); table.iter_mut().find(|t| t.0 == row).unwrap().2 = new_text; }
                    CaptionDelta::Closed { .. } => kinds.push("closed"),
                }
            }
        }
        let want: Vec<&str> = fx["deltaKinds"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(kinds, want);
        let got: Vec<Line> = table.into_iter().map(|(_, s, t)| (s, t)).collect();
        assert_eq!(Some(got), rows(&fx["finalRows"]));
    }

    #[test]
    fn capture_readers_pair_rows_edge_cases() {
        let g = |xs: &[&[&str]]| xs.iter().map(|g| g.iter().map(|s| s.to_string()).collect::<Vec<_>>()).collect::<Vec<_>>();
        assert!(pair_caption_rows(&[]).is_empty());
        assert!(pair_caption_rows(&g(&[&["orphan continuation"], &["Bob", "Hi."]])).len() == 1, "a leading one-text row has no speaker and is dropped");
        assert_eq!(pair_caption_rows(&g(&[&["A", "x", "y", "z"]])), vec![("A".into(), "x".into()), ("y".into(), "z".into())], "one flat group alternates");
    }

    #[test]
    fn capture_readers_walk_is_bounded() {
        // A pathological 5,000-node chain under the captions window: the reader stops at its node budget.
        let mut deep = AxNode { role: "AXStaticText".into(), value: Some("Tanaka\nEnd.".into()), ..Default::default() };
        for _ in 0..5000 {
            deep = AxNode { role: "AXGroup".into(), children: vec![deep], ..Default::default() };
        }
        let app = AxAppTree { bundle_id: "us.zoom.xos".into(), windows: vec![AxNode { role: "AXWindow".into(), title: Some("Captions".into()), children: vec![deep], ..Default::default() }] };
        assert_eq!(reader("zoom").read(&app), Some(vec![]), "the text past the depth limit is not reached");
    }
}
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_readers`
Expected: FAIL (`not implemented`).

- [ ] **Step 5: Implement the readers**

Replace the stubs in `capture_readers.rs` (keep the tests):

```rust
//! Per-app caption readers over an `AxAppTree` (ports of ZoomCaptionScraper.swift and TeamsCaptionScraper.swift).
//! Pure: no AX calls here, so every reader runs on the JSON fixtures in tests/fixtures/captions/.
//! Adding a platform is one reader plus fixtures; `all_readers` order is the Mac's PlatformDetector order.

use crate::capture_model::{AxAppTree, AxNode};
use crate::capture_validate::{Line, UNKNOWN_SPEAKER};

const ROLE_STATIC_TEXT: &str = "AXStaticText";
const ROLE_GROUP: &str = "AXGroup";
/// Node budget per read (AXCaptionReader.WalkLimits.nodeBudget).
const MAX_NODES: usize = 2_000;

pub trait CaptionReader: Send + Sync {
    /// Frontmatter `platform` value (MeetingFrontmatter: "meet" | "teams" | "zoom" | "mic").
    fn platform(&self) -> &'static str;
    fn bundle_id(&self) -> &'static str;
    /// `None`: the captions panel is not in the tree. `Some(lines)`: the on-screen lines in order (maybe empty).
    fn read(&self, app: &AxAppTree) -> Option<Vec<Line>>;
}

pub struct ZoomReader;
pub struct TeamsReader;

pub fn all_readers() -> Vec<Box<dyn CaptionReader>> {
    vec![Box::new(ZoomReader), Box::new(TeamsReader)]
}

fn trimmed_value(n: &AxNode) -> Option<&str> {
    n.value.as_deref().map(str::trim).filter(|t| !t.is_empty())
}

/// Pre-order static-text values under `n`, bounded by depth and node budget.
fn static_texts<'a>(n: &'a AxNode, depth: usize, max_depth: usize, budget: &mut usize, out: &mut Vec<&'a str>) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    if n.role == ROLE_STATIC_TEXT {
        if let Some(t) = trimmed_value(n) {
            out.push(t);
        }
    }
    if depth >= max_depth {
        return;
    }
    for c in &n.children {
        static_texts(c, depth + 1, max_depth, budget, out);
    }
}

impl CaptionReader for ZoomReader {
    fn platform(&self) -> &'static str {
        "zoom"
    }
    fn bundle_id(&self) -> &'static str {
        "us.zoom.xos"
    }
    fn read(&self, app: &AxAppTree) -> Option<Vec<Line>> {
        // The panel title localizes: match a substring, English first, then Japanese (Mac order).
        let has = |w: &&AxNode, needle: &str| w.title.as_deref().is_some_and(|t| t.to_lowercase().contains(needle));
        let window = app.windows.iter().find(|w| has(w, "caption")).or_else(|| app.windows.iter().find(|w| has(w, "字幕")))?;
        let mut texts = Vec::new();
        let mut budget = MAX_NODES;
        static_texts(window, 0, 12, &mut budget, &mut texts);
        Some(texts.into_iter().map(split_zoom_line).collect())
    }
}

/// "Tanaka\nLet's start." -> (Tanaka, Let's start.); no speaker prefix -> ("Unknown", whole line).
fn split_zoom_line(t: &str) -> Line {
    if let Some((s, b)) = t.split_once('\n') {
        let (s, b) = (s.trim(), b.trim());
        if !s.is_empty() && !b.is_empty() {
            return (s.to_string(), b.to_string());
        }
    }
    (UNKNOWN_SPEAKER.to_string(), t.to_string())
}

impl CaptionReader for TeamsReader {
    fn platform(&self) -> &'static str {
        "teams"
    }
    fn bundle_id(&self) -> &'static str {
        "com.microsoft.teams2"
    }
    fn read(&self, app: &AxAppTree) -> Option<Vec<Line>> {
        let mut budget = MAX_NODES;
        let panel = app.windows.iter().find_map(|w| find_panel(w, 0, 16, &mut budget))?;
        let mut groups = Vec::new();
        let mut budget = MAX_NODES;
        collect_groups(panel, 0, 16, &mut budget, &mut groups);
        Some(pair_caption_rows(&groups))
    }
}

/// The first AXGroup whose description contains "live caption" (stops at the first match).
fn find_panel<'a>(n: &'a AxNode, depth: usize, max_depth: usize, budget: &mut usize) -> Option<&'a AxNode> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    if n.role == ROLE_GROUP && n.description.as_deref().is_some_and(|d| d.to_lowercase().contains("live caption")) {
        return Some(n);
    }
    if depth >= max_depth {
        return None;
    }
    n.children.iter().find_map(|c| find_panel(c, depth + 1, max_depth, budget))
}

/// Static-text values grouped by their immediate parent, groups in first-seen pre-order
/// (AXCaptionReader.staticTextGroups): the only row structure AX gives for caption panels.
fn collect_groups(n: &AxNode, depth: usize, max_depth: usize, budget: &mut usize, groups: &mut Vec<Vec<String>>) {
    if depth >= max_depth {
        return;
    }
    let mut mine: Option<usize> = None;
    for c in &n.children {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        if c.role == ROLE_STATIC_TEXT {
            if let Some(t) = trimmed_value(c) {
                let idx = *mine.get_or_insert_with(|| {
                    groups.push(Vec::new());
                    groups.len() - 1
                });
                groups[idx].push(t.to_string());
            }
        }
        collect_groups(c, depth + 1, max_depth, budget, groups);
    }
}

/// TeamsCaptionScraper.pairCaptionRows: with real per-row parents, the first text is the speaker and the rest the
/// body, and a one-text group continues the previous speaker (dropped when there is none). Everything under ONE
/// parent has no structure: alternate speaker/body over the flat list.
pub fn pair_caption_rows(groups: &[Vec<String>]) -> Vec<Line> {
    let non_empty: Vec<&Vec<String>> = groups.iter().filter(|g| !g.is_empty()).collect();
    if non_empty.is_empty() {
        return Vec::new();
    }
    if !(non_empty.len() > 1 || non_empty[0].len() == 2) {
        return non_empty[0].chunks(2).filter(|c| c.len() == 2).map(|c| (c[0].clone(), c[1].clone())).collect();
    }
    let mut out = Vec::new();
    let mut last: Option<&str> = None;
    for g in non_empty {
        if g.len() == 1 {
            if let Some(s) = last {
                out.push((s.to_string(), g[0].clone()));
            }
            continue;
        }
        out.push((g[0].clone(), g[1..].join(" ")));
        last = Some(g[0].as_str());
    }
    out
}
```

Add `mod capture_model; mod capture_readers;` to `lib.rs`.

- [ ] **Step 6: Run to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_readers`
Expected: PASS (4 tests). The bounded-walk test returns `Some(vec![])` because depth 12 is reached long before the text.

- [ ] **Step 7: Commit**

```bash
git add desktop/src-tauri/src/capture_model.rs desktop/src-tauri/src/capture_readers.rs desktop/src-tauri/tests/fixtures/captions desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Zoom and Teams caption readers over AX tree fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Partial file, meeting note rendering, finalize with read-back verify

**Files:**
- Create: `desktop/src-tauri/src/capture_store.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`mod capture_store;`)

**Interfaces:**
- Consumes: `notes_write::create_note(root, &CreateReq { rel, text }) -> Result<SavedNote, String>`, `notes_write::open_note(root, rel) -> Result<OpenedNote, String>` (fields `text`, `hash`, `mtime_ms`), `chat_archive::iso_utc(unix: f64) -> String`.
- Produces: `pub struct PartialHeader { v, id, started_at_ms, language, notes_root }`, `pub struct Row { pub time: String, pub speaker: String, pub text: String }`, `pub struct PartialWriter` (`create(dir, &PartialHeader)`, `path()`, `append_row(&Row)`, `set_platform(&str)`, `sync()`), `pub struct Recovered { header, platform: Option<String>, rows: Vec<Row> }`, `pub fn read_partial(path) -> Result<Recovered, String>`, `pub struct PartialSummary { id, started_at_ms, rows }`, `pub fn list_partials(dir, skip_id: Option<&str>) -> Vec<PartialSummary>`, `pub fn partial_path(dir, id) -> Option<PathBuf>`, `pub struct FinalMeta<'a> { id, title, started_at_ms, ended_at_ms, platform, language }`, `pub fn render_meeting(&FinalMeta, &[Row]) -> String`, `pub fn final_rel(started_at_ms, title, id) -> String`, `pub fn finalize(root, partial: Option<&Path>, &FinalMeta, &[Row]) -> Result<FinalizedNote, String>`, `pub struct FinalizedNote { rel, hash, lines, mtime_ms, index: Option<IndexUpsert> }`, `pub fn new_session_id(now_ms: i64) -> String`, `pub fn valid_session_id(&str) -> bool`, `pub fn clean_title(&str) -> String`, `pub fn local_hms(ms: i64) -> String`.

The format follows the Mac exactly. Line: `[HH:MM:SS] **Speaker**: text` (`MeetingFileStore.appendCaption`, local time). Frontmatter keys: `id, title, started_at, ended_at, duration_seconds, participants, platform, language, tldr` (`MeetingFrontmatter.CodingKeys`, ISO 8601 UTC with no fraction, the `ISO8601DateFormatter` default). Name: `<yyyy-MM-dd local>-<slug>-<8hex>.md` under `source/meetings/YYYY/MM/`, where `8hex` is FNV-1a folded to 32 bits for non-UUID ids (`MeetingFileStore.idDisambiguator`). String values are written as JSON strings, which are valid YAML double-quoted scalars. The partial lives in the app data folder, not the notes folder, so the Swift app's `PartialRecovery` never sees it and the Library lister never lists it.

- [ ] **Step 1: Write the failing tests**

In `desktop/src-tauri/src/capture_store.rs`, after stub signatures for every item in Interfaces, add:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("llmide-cap-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn row(t: &str, s: &str, x: &str) -> Row {
        Row { time: t.into(), speaker: s.into(), text: x.into() }
    }

    fn header(root: &Path) -> PartialHeader {
        PartialHeader { v: 1, id: "m-abc123-xyz789".into(), started_at_ms: 1_762_335_000_000, language: "en".into(), notes_root: root.display().to_string() }
    }

    #[test]
    fn capture_store_session_ids() {
        let id = new_session_id(1_762_335_000_000);
        assert!(valid_session_id(&id), "{id}");
        for bad in ["", "m-", "../x", "m-ABC-1", "m-abc-123/../../x", "m-12345678901234-a"] {
            assert!(!valid_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn capture_store_partial_round_trip_with_platform_line() {
        let dir = scratch("partial");
        let mut w = PartialWriter::create(&dir, &header(&dir)).unwrap();
        w.append_row(&row("09:30:01", "Alice", "Hello.")).unwrap();
        w.set_platform("zoom").unwrap();
        w.append_row(&row("09:30:04", "Bob", "Hi **there**.")).unwrap();
        w.sync().unwrap();
        let r = read_partial(w.path()).unwrap();
        assert_eq!(r.header.id, "m-abc123-xyz789");
        assert_eq!(r.platform.as_deref(), Some("zoom"));
        assert_eq!(r.rows, vec![row("09:30:01", "Alice", "Hello."), row("09:30:04", "Bob", "Hi **there**.")]);
        assert!(PartialWriter::create(&dir, &header(&dir)).is_err(), "create never overwrites");
        let list = list_partials(&dir, None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].rows, 2);
        assert!(list_partials(&dir, Some("m-abc123-xyz789")).is_empty(), "the active session is never offered for recovery");
    }

    #[cfg(unix)]
    #[test]
    fn capture_store_partial_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        let w = PartialWriter::create(&dir, &header(&dir)).unwrap();
        assert_eq!(std::fs::metadata(w.path()).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn capture_store_renders_the_mac_format() {
        let meta = FinalMeta { id: "m-abc123-xyz789", title: "Weekly: sync \"Q4\"", started_at_ms: 1_762_335_000_000, ended_at_ms: 1_762_336_800_000, platform: "teams", language: "ja" };
        let text = render_meeting(&meta, &[row("09:30:01", "Bob", "Hi."), row("09:30:04", "Alice", "Hello.")]);
        assert!(text.starts_with("---\nid: \"m-abc123-xyz789\"\ntitle: \"Weekly: sync \\\"Q4\\\"\"\nstarted_at: \"2025-11-05T09:30:00Z\"\n"), "{text}");
        assert!(text.contains("\nduration_seconds: 1800\nparticipants: [\"Alice\",\"Bob\"]\nplatform: \"teams\"\nlanguage: \"ja\"\ntldr: []\n---\n\n## Transcript\n\n"));
        assert!(text.ends_with("[09:30:01] **Bob**: Hi.\n[09:30:04] **Alice**: Hello.\n"));
    }

    #[test]
    fn capture_store_final_name() {
        let rel = final_rel(1_762_335_000_000, "Weekly Sync / Q4!", "m-abc123-xyz789");
        let re = regex::Regex::new(r"^source/meetings/\d{4}/\d{2}/\d{4}-\d{2}-\d{2}-weekly-sync--q4-[0-9a-f]{8}\.md$").unwrap();
        assert!(re.is_match(&rel), "{rel}");
        assert!(final_rel(1_762_335_000_000, "", "m-abc123-xyz789").contains("-untitled-"));
        assert_eq!(disambiguator("m-abc123-xyz789"), disambiguator("m-abc123-xyz789"), "stable");
    }

    #[test]
    fn capture_store_finalize_verifies_and_removes_the_partial() {
        let root = scratch("root");
        let dir = scratch("data");
        let mut w = PartialWriter::create(&dir, &header(&root)).unwrap();
        w.append_row(&row("09:30:01", "Alice", "Hello.")).unwrap();
        let partial = w.path().to_path_buf();
        drop(w);
        let meta = FinalMeta { id: "m-abc123-xyz789", title: "Sync", started_at_ms: 1_762_335_000_000, ended_at_ms: 1_762_335_060_000, platform: "zoom", language: "en" };
        let rows = vec![row("09:30:01", "Alice", "Hello."), row("09:30:02", "Bob", "Hi.")];
        let n = finalize(&root, Some(&partial), &meta, &rows).unwrap();
        assert_eq!(n.lines, 2);
        assert!(!partial.exists(), "partial removed only after the verified note exists");
        let on_disk = std::fs::read_to_string(root.join(&n.rel)).unwrap();
        assert!(on_disk.contains("[09:30:02] **Bob**: Hi.\n"));
        let idx = n.index.expect("small note is indexable");
        assert_eq!(idx.note_key, n.rel);
        assert_eq!(idx.kind, "meeting");
        assert_eq!(idx.content_hash, n.hash);
        assert!(idx.body.starts_with("\n## Transcript"), "body is everything after the frontmatter");
        // Same name again: a second note with a numeric suffix, never an overwrite.
        let n2 = finalize(&root, None, &meta, &rows).unwrap();
        assert_ne!(n2.rel, n.rel);
        assert!(n2.rel.ends_with("-2.md"));
    }

    #[test]
    fn capture_store_finalize_refuses_empty() {
        let root = scratch("empty");
        let meta = FinalMeta { id: "m-abc123-xyz789", title: "", started_at_ms: 0, ended_at_ms: 0, platform: "zoom", language: "en" };
        assert!(finalize(&root, None, &meta, &[]).unwrap_err().starts_with("empty"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_store`
Expected: FAIL (`not implemented`).

- [ ] **Step 3: Implement**

```rust
//! The capture's two files.
//!
//! - The PARTIAL (crash copy) lives in `<desktop_data_dir>/capture/<id>.partial.md`, mode 0600, created with
//!   O_EXCL|O_NOFOLLOW. Line 1 is a JSON header; a later `{"platform":..}` line records the observed platform;
//!   every other line is a transcript line. Rows are appended once they stop growing (capture_session.rs), so a
//!   crash loses at most a few seconds. It is outside the notes folder on purpose: the Library lists only finished
//!   notes, and the Swift app's PartialRecovery never adopts a desktop capture.
//! - The NOTE (the one durable copy, live-then-archive 3.6 A) is written once at Stop through
//!   `notes_write::create_note` (atomic, never overwrites, root-confined), read back and verified (frontmatter id +
//!   transcript line count == rows) before the partial is removed. Format = the Mac's MeetingFileStore.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::notes_write;

pub const PARTIAL_SUFFIX: &str = ".partial.md";
const SYNC_EVERY: Duration = Duration::from_secs(2);
const MAX_TITLE_CHARS: usize = 300;
const MAX_PARTIAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECOVERY_LIST: usize = 50;
/// Same body limit as the Library index rebuild (ui/screens/library/index-rebuild.ts BODY_BYTES).
const INDEX_BODY_BYTES: usize = 512 * 1024;

fn io(e: std::io::Error) -> String {
    format!("io: {e}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialHeader {
    pub v: u32,
    pub id: String,
    pub started_at_ms: i64,
    pub language: String,
    /// Notes root captured at Start (Mac rule: a folder change mid-recording cannot split the capture).
    pub notes_root: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub time: String,
    pub speaker: String,
    pub text: String,
}

pub fn render_line(r: &Row) -> String {
    format!("[{}] **{}**: {}", r.time, r.speaker, r.text)
}

fn line_re() -> &'static Regex {
    static R: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\[(\d{2}:\d{2}:\d{2})\] \*\*(.+?)\*\*: (.*)$").expect("static"))
}

// ---- session ids -------------------------------------------------------------------------------

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut v = Vec::new();
    while n > 0 {
        v.push(D[(n % 36) as usize]);
        n /= 36;
    }
    v.reverse();
    String::from_utf8(v).expect("ascii")
}

/// `m-<base36 unix seconds>-<6 base36 random>`: the Mac's and the extension's capture id shape.
pub fn new_session_id(now_ms: i64) -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    let r = u64::from_le_bytes(b) % 36u64.pow(6);
    format!("m-{}-{:0>6}", base36((now_ms.max(0) / 1000) as u64), base36(r))
}

pub fn valid_session_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("m-") else { return false };
    let Some((a, b)) = rest.split_once('-') else { return false };
    let ok = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase());
    ok(a, 13) && ok(b, 8)
}

// ---- partial -----------------------------------------------------------------------------------

pub struct PartialWriter {
    path: PathBuf,
    file: File,
    last_sync: Instant,
}

impl PartialWriter {
    pub fn create(dir: &Path, h: &PartialHeader) -> Result<Self, String> {
        if !valid_session_id(&h.id) {
            return Err("invalid_id: bad session id".into());
        }
        std::fs::create_dir_all(dir).map_err(io)?;
        let path = dir.join(format!("{}{PARTIAL_SUFFIX}", h.id));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = opts.open(&path).map_err(io)?;
        let head = serde_json::to_string(h).map_err(|e| format!("io: {e}"))?;
        writeln!(file, "{head}").map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(Self { path, file, last_sync: Instant::now() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append_row(&mut self, r: &Row) -> Result<(), String> {
        writeln!(self.file, "{}", render_line(r)).map_err(io)?;
        self.maybe_sync()
    }

    pub fn set_platform(&mut self, platform: &str) -> Result<(), String> {
        writeln!(self.file, "{}", serde_json::json!({ "platform": platform })).map_err(io)?;
        self.maybe_sync()
    }

    pub fn sync(&mut self) -> Result<(), String> {
        self.last_sync = Instant::now();
        self.file.sync_data().map_err(io)
    }

    fn maybe_sync(&mut self) -> Result<(), String> {
        if self.last_sync.elapsed() >= SYNC_EVERY {
            self.sync()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Recovered {
    pub header: PartialHeader,
    pub platform: Option<String>,
    pub rows: Vec<Row>,
}

pub fn read_partial(path: &Path) -> Result<Recovered, String> {
    let meta = std::fs::symlink_metadata(path).map_err(io)?;
    if !meta.is_file() || meta.len() > MAX_PARTIAL_BYTES {
        return Err("invalid_partial: not a regular file or too large".into());
    }
    let mut lines = BufReader::new(File::open(path).map_err(io)?).lines();
    let first = lines.next().ok_or("invalid_partial: empty")?.map_err(io)?;
    let header: PartialHeader = serde_json::from_str(&first).map_err(|e| format!("invalid_partial: {e}"))?;
    if !valid_session_id(&header.id) {
        return Err("invalid_partial: bad id".into());
    }
    let mut platform = None;
    let mut rows = Vec::new();
    for line in lines {
        let line = line.map_err(io)?;
        if line.starts_with('{') {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(p) = v.get("platform").and_then(|p| p.as_str()) {
                    platform = Some(p.chars().take(20).collect());
                }
            }
        } else if let Some(c) = line_re().captures(&line) {
            rows.push(Row { time: c[1].to_string(), speaker: c[2].to_string(), text: c[3].to_string() });
        }
    }
    Ok(Recovered { header, platform, rows })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialSummary {
    pub id: String,
    pub started_at_ms: i64,
    pub rows: usize,
}

pub fn partial_path(dir: &Path, id: &str) -> Option<PathBuf> {
    valid_session_id(id).then(|| dir.join(format!("{id}{PARTIAL_SUFFIX}")))
}

/// Unfinished captures, newest first, never the active one.
pub fn list_partials(dir: &Path, skip_id: Option<&str>) -> Vec<PartialSummary> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PartialSummary> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_suffix(PARTIAL_SUFFIX)?;
            if !valid_session_id(id) || Some(id) == skip_id {
                return None;
            }
            let r = read_partial(&e.path()).ok()?;
            Some(PartialSummary { id: id.to_string(), started_at_ms: r.header.started_at_ms, rows: r.rows.len() })
        })
        .collect();
    out.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
    out.truncate(MAX_RECOVERY_LIST);
    out
}

// ---- time --------------------------------------------------------------------------------------

/// Local (year, month, day, hour, minute, second) for a Unix ms time.
#[cfg(unix)]
fn local_parts(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    let t: libc::time_t = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: an all-zero `tm` is a valid value to be overwritten.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the duration of the call; localtime_r is the thread-safe form.
    let ok = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
    if !ok {
        return utc_parts(ms);
    }
    (tm.tm_year as i64 + 1900, (tm.tm_mon + 1) as u32, tm.tm_mday as u32, tm.tm_hour as u32, tm.tm_min as u32, tm.tm_sec as u32)
}

// shortcut: non-unix hosts use UTC for file names and line times; the Windows phase (section F) adds localtime_s.
#[cfg(not(unix))]
fn local_parts(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    utc_parts(ms)
}

fn utc_parts(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    let iso = crate::chat_archive::iso_utc(ms as f64 / 1000.0); // YYYY-MM-DDTHH:MM:SSZ
    let n = |a: usize, b: usize| iso[a..b].parse::<u32>().unwrap_or(0);
    (iso[0..4].parse().unwrap_or(1970), n(5, 7), n(8, 10), n(11, 13), n(14, 16), n(17, 19))
}

/// "HH:MM:SS" local, the transcript line time (AppDateFormatter.hourMinuteSecond).
pub fn local_hms(ms: i64) -> String {
    let (_, _, _, h, mi, s) = local_parts(ms);
    format!("{h:02}:{mi:02}:{s:02}")
}

// ---- note --------------------------------------------------------------------------------------

pub struct FinalMeta<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub platform: &'a str,
    pub language: &'a str,
}

/// Title as stored: control chars to spaces, trimmed, at most 300 chars, "Untitled meeting" when empty (Mac).
pub fn clean_title(raw: &str) -> String {
    let t: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t: String = t.trim().chars().take(MAX_TITLE_CHARS).collect();
    if t.trim().is_empty() { "Untitled meeting".into() } else { t.trim().to_string() }
}

fn q(s: &str) -> String {
    serde_json::to_string(s).expect("string serializes")
}

fn participants(rows: &[Row]) -> Vec<String> {
    let mut p: Vec<String> = rows.iter().map(|r| r.speaker.clone()).collect();
    p.sort();
    p.dedup();
    p
}

pub fn render_meeting(m: &FinalMeta, rows: &[Row]) -> String {
    let iso = |ms: i64| crate::chat_archive::iso_utc(ms as f64 / 1000.0);
    let duration = ((m.ended_at_ms - m.started_at_ms).max(0)) / 1000;
    let mut out = format!(
        "---\nid: {}\ntitle: {}\nstarted_at: {}\nended_at: {}\nduration_seconds: {}\nparticipants: {}\nplatform: {}\nlanguage: {}\ntldr: []\n---\n\n## Transcript\n\n",
        q(m.id),
        q(m.title),
        q(&iso(m.started_at_ms)),
        q(&iso(m.ended_at_ms)),
        duration,
        serde_json::to_string(&participants(rows)).expect("list serializes"),
        q(m.platform),
        q(m.language),
    );
    for r in rows {
        out.push_str(&render_line(r));
        out.push('\n');
    }
    out
}

/// MeetingFileStore.idDisambiguator for a non-UUID id: FNV-1a 64 folded to 32 bits, 8 hex.
pub fn disambiguator(id: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

fn slug(title: &str) -> String {
    let s: String = title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-')
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .take(60)
        .collect();
    if s.is_empty() { "untitled".into() } else { s }
}

pub fn final_rel(started_at_ms: i64, title: &str, id: &str) -> String {
    let (y, mo, d, ..) = local_parts(started_at_ms);
    let t = if title == "Untitled meeting" { "" } else { title };
    format!("source/meetings/{y:04}/{mo:02}/{y:04}-{mo:02}-{d:02}-{}-{}.md", slug(t), disambiguator(id))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    pub meeting_id: String,
    pub platform: String,
    pub language: String,
}

/// One `POST /kb/index/notes` entry, the same shape as Library's `makeUpsertInput` (index-rebuild.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexUpsert {
    pub note_key: String,
    pub kind: &'static str,
    pub title: String,
    pub date: String,
    pub duration_sec: i64,
    pub participants: Vec<String>,
    pub body: String,
    pub content_hash: String,
    pub mtime_ms: i64,
    pub meta: IndexMeta,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizedNote {
    pub rel: String,
    pub hash: String,
    pub lines: usize,
    pub mtime_ms: i64,
    /// None when the note is larger than the index body limit (a Library rebuild still covers it).
    pub index: Option<IndexUpsert>,
}

fn create_unique(root: &Path, base: &str, text: &str) -> Result<notes_write::SavedNote, String> {
    let stem = base.strip_suffix(".md").expect("final_rel ends in .md");
    for n in 1..=9 {
        let rel = if n == 1 { base.to_string() } else { format!("{stem}-{n}.md") };
        match notes_write::create_note(root, &notes_write::CreateReq { rel, text: text.to_string() }) {
            Ok(s) => return Ok(s),
            Err(e) if e.starts_with("exists") => continue,
            Err(e) => return Err(e),
        }
    }
    Err("exists: nine notes with this name already exist".into())
}

fn verify(text: &str, id: &str, rows: usize) -> Result<(), String> {
    if !text.starts_with("---\n") || !text.contains(&format!("\nid: {}\n", q(id))) {
        return Err("verify_failed: frontmatter does not read back".into());
    }
    let body = text.split_once("\n## Transcript\n").map(|(_, b)| b).ok_or("verify_failed: no transcript heading")?;
    let n = body.lines().filter(|l| line_re().is_match(l)).count();
    if n != rows {
        return Err(format!("verify_failed: {n} transcript lines read back, {rows} captured"));
    }
    Ok(())
}

/// Writes the note, reads it back, verifies it, then removes the partial (in that order: verify before cleanup).
/// On any error the partial stays for recovery.
pub fn finalize(root: &Path, partial: Option<&Path>, m: &FinalMeta, rows: &[Row]) -> Result<FinalizedNote, String> {
    if rows.is_empty() {
        return Err("empty: nothing was captured".into());
    }
    let text = render_meeting(m, rows);
    let saved = create_unique(root, &final_rel(m.started_at_ms, m.title, m.id), &text)?;
    let opened = notes_write::open_note(root, &saved.rel)?;
    verify(&opened.text, m.id, rows.len())?;
    if let Some(p) = partial {
        // Our own working copy, superseded by the verified note: removed, not trashed.
        std::fs::remove_file(p).map_err(io)?;
    }
    let index = (opened.text.len() <= INDEX_BODY_BYTES).then(|| IndexUpsert {
        note_key: saved.rel.clone(),
        kind: "meeting",
        title: m.title.chars().take(500).collect(),
        date: crate::chat_archive::iso_utc(m.started_at_ms as f64 / 1000.0).replace('Z', ".000Z"),
        duration_sec: ((m.ended_at_ms - m.started_at_ms).max(0)) / 1000,
        participants: participants(rows).into_iter().take(200).map(|p| p.chars().take(200).collect()).collect(),
        body: opened.text.split_once("\n---\n").map(|(_, b)| b.to_string()).unwrap_or_default(),
        content_hash: opened.hash.clone(),
        mtime_ms: opened.mtime_ms,
        meta: IndexMeta { meeting_id: m.id.to_string(), platform: m.platform.to_string(), language: m.language.to_string() },
    });
    Ok(FinalizedNote { rel: saved.rel, hash: opened.hash, lines: rows.len(), mtime_ms: opened.mtime_ms, index })
}
```

Check the two `notes_write` items this uses: `CreateReq` (line 92) must be `pub` with `pub` fields, and `SavedNote` and `OpenedNote` fields must be `pub` (lines 59-76). If `CreateReq` derives only `Deserialize` and its fields are private, make the fields `pub` (one-word change, no behaviour change). Add `mod capture_store;` to `lib.rs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_store`
Expected: PASS (7 tests). The `started_at` assertion uses UTC (`2025-11-05T09:30:00Z` for `1_762_335_000_000`). The final-name test checks only the shape, so it passes in any time zone.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/capture_store.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/src/notes_write.rs
git commit -m "feat(desktop): crash-safe capture partial and verified meeting note in the Mac format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: macOS Accessibility source (trust, prompt, pid lookup, bounded tree read)

**Files:**
- Create: `desktop/src-tauri/src/capture_ax_macos.rs`
- Modify: `desktop/src-tauri/Cargo.toml` (macOS target deps)
- Modify: `desktop/src-tauri/src/lib.rs` (`mod capture_ax_macos;`)

**Interfaces:**
- Consumes: `capture_model::{AxNode, AxAppTree, AxReadError}`.
- Produces: `pub fn is_trusted() -> bool` (no prompt), `pub fn prompt_trust() -> bool` (shows the macOS dialog; call only from a user click), `pub fn running_pid(bundle_id: &str) -> Option<i32>`, `pub fn read_app_tree(bundle_id: &str) -> Result<Option<AxAppTree>, AxReadError>` (`Ok(None)` when the app is not running), `pub const SUPPORTED: bool`. On non-macOS: `is_trusted` and `prompt_trust` return false, `running_pid` returns None, `read_app_tree` returns `Err(Unsupported)`, and `SUPPORTED` is false.

This is the only `unsafe` code in the feature. It follows `ax_probe.rs` (an `Owned` RAII wrapper and an attribute-name cache), but it is a **product** module: `ax_probe` stays spike-only.

- [ ] **Step 1: Add the AppKit and Foundation features and compile a probe**

In `desktop/src-tauri/Cargo.toml`, change the macOS block to:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "=0.6.5"
objc2-app-kit = { version = "=0.3.2", features = ["NSApplication", "NSRunningApplication"] }
# Bundle id -> pid for the capture reader (NSString argument, NSArray result). Same version tao already locks.
objc2-foundation = { version = "=0.3.2", features = ["NSString", "NSArray", "NSEnumerator"] }
keyring = { version = "=3.6.3", default-features = false, features = ["apple-native"] }
```

Create `capture_ax_macos.rs` with only:

```rust
#[cfg(target_os = "macos")]
pub fn running_pid(bundle_id: &str) -> Option<i32> {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id));
    apps.iter().map(|a| a.processIdentifier()).find(|p| *p > 0)
}
```

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo build --lib`
Expected: builds. If the compiler says the call is `unsafe`, wrap it in `unsafe { }` with the comment `// SAFETY: class method with a valid NSString; NSRunningApplication is documented thread-safe.` If a feature name is wrong, the error names the missing feature: add it. `Cargo.lock` must not gain a new package version (`git diff Cargo.lock` shows only the dependency list of this crate).

- [ ] **Step 2: Write the failing tests (they need no Accessibility permission)**

Add to `capture_ax_macos.rs`:

```rust
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn capture_ax_unknown_app_is_not_running() {
        assert_eq!(running_pid("com.llmide.no-such-app"), None);
        // Not running is Ok(None) whether or not the test process is trusted.
        assert!(matches!(read_app_tree("com.llmide.no-such-app"), Ok(None) | Err(AxReadError::PermissionDenied)));
    }

    #[test]
    fn capture_ax_trust_check_does_not_prompt_or_panic() {
        let _ = is_trusted();
    }

    #[test]
    fn capture_ax_cf_string_round_trip() {
        let s = cf_string("AXStaticText 字幕").unwrap();
        assert_eq!(string_of(s.0).as_deref(), Some("AXStaticText 字幕"));
    }
}
```

Run: `cargo test --lib capture_ax` and expect a FAIL (missing functions).

- [ ] **Step 3: Implement**

```rust
//! macOS Accessibility source for the live capture: reads ONE meeting app's windows into an `AxAppTree`
//! (capture_model.rs) that the pure readers parse. Only the attributes the readers use are read: AXRole always,
//! AXTitle on windows, AXDescription on groups, AXValue on static text. Nothing else in the meeting window is
//! copied. Bounds (AXCaptionReader): 0.3 s messaging timeout on EVERY element (it is not inherited by copied
//! children), depth 16, 2,000 nodes, 0.5 s per app read. Values are kept in memory for one tick and never logged.
//! Called only from the capture worker thread (capture_host.rs), never the UI thread.

use crate::capture_model::{AxAppTree, AxNode, AxReadError};

#[cfg(target_os = "macos")]
pub const SUPPORTED: bool = true;
#[cfg(not(target_os = "macos"))]
pub const SUPPORTED: bool = false;

#[cfg(target_os = "macos")]
pub use macos::{is_trusted, prompt_trust, read_app_tree, running_pid};

#[cfg(target_os = "macos")]
use macos::{cf_string, string_of};

#[cfg(not(target_os = "macos"))]
pub fn is_trusted() -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn prompt_trust() -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn running_pid(_bundle_id: &str) -> Option<i32> {
    None
}
#[cfg(not(target_os = "macos"))]
pub fn read_app_tree(_bundle_id: &str) -> Result<Option<AxAppTree>, AxReadError> {
    Err(AxReadError::Unsupported)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{AxAppTree, AxNode, AxReadError};
    use std::ffi::{c_char, c_void, CString};
    use std::time::{Duration, Instant};

    type CfRef = *const c_void;
    type AxError = i32;
    const AX_OK: AxError = 0;
    const AX_ERROR_API_DISABLED: AxError = -25211;
    const AX_ERROR_CANNOT_COMPLETE: AxError = -25204;
    const UTF8: u32 = 0x0800_0100;
    const MESSAGING_TIMEOUT_S: f32 = 0.3;
    const MAX_DEPTH: u32 = 16;
    const MAX_NODES: usize = 2_000;
    const READ_DEADLINE: Duration = Duration::from_millis(500);
    /// A caption value longer than this (UTF-16 units) is not a caption: skipped, not truncated.
    const MAX_VALUE_UNITS: isize = 20_000;

    #[repr(C)]
    struct DictKeyCallBacks([usize; 6]);
    #[repr(C)]
    struct DictValueCallBacks([usize; 5]);

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CfRef) -> u8;
        static kAXTrustedCheckOptionPrompt: CfRef;
        fn AXUIElementCreateApplication(pid: i32) -> CfRef;
        fn AXUIElementSetMessagingTimeout(element: CfRef, timeout: f32) -> AxError;
        fn AXUIElementCopyAttributeValue(element: CfRef, attribute: CfRef, value: *mut CfRef) -> AxError;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CfRef;
        static kCFTypeDictionaryKeyCallBacks: DictKeyCallBacks;
        static kCFTypeDictionaryValueCallBacks: DictValueCallBacks;
        fn CFDictionaryCreate(alloc: CfRef, keys: *const CfRef, values: *const CfRef, n: isize, kcb: *const DictKeyCallBacks, vcb: *const DictValueCallBacks) -> CfRef;
        fn CFRelease(cf: CfRef);
        fn CFGetTypeID(cf: CfRef) -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetCount(a: CfRef) -> isize;
        fn CFArrayGetValueAtIndex(a: CfRef, i: isize) -> CfRef;
        fn CFStringCreateWithCString(alloc: CfRef, s: *const c_char, enc: u32) -> CfRef;
        fn CFStringGetLength(s: CfRef) -> isize;
        fn CFStringGetMaximumSizeForEncoding(len: isize, enc: u32) -> isize;
        fn CFStringGetCString(s: CfRef, buf: *mut c_char, size: isize, enc: u32) -> u8;
    }

    /// One retained CF object, released on drop.
    pub struct Owned(pub CfRef);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: returned by a Create/Copy call, so we own one reference.
                unsafe { CFRelease(self.0) }
            }
        }
    }

    pub fn cf_string(s: &str) -> Option<Owned> {
        let c = CString::new(s).ok()?;
        // SAFETY: valid NUL-terminated string for the duration of the call.
        let r = unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) };
        (!r.is_null()).then(|| Owned(r))
    }

    /// The UTF-8 text of a CFString, or None for another type or an over-long value.
    pub fn string_of(cf: CfRef) -> Option<String> {
        // SAFETY: type queries on a live object owned by the caller.
        if cf.is_null() || unsafe { CFGetTypeID(cf) != CFStringGetTypeID() } {
            return None;
        }
        // SAFETY: `cf` is a live CFString (checked above).
        let len = unsafe { CFStringGetLength(cf) };
        if len > MAX_VALUE_UNITS {
            return None;
        }
        // SAFETY: plain size computation.
        let size = unsafe { CFStringGetMaximumSizeForEncoding(len, UTF8) } + 1;
        let mut buf = vec![0u8; size.max(1) as usize];
        // SAFETY: `buf` holds `size` bytes; the call writes at most that and NUL-terminates.
        let ok = unsafe { CFStringGetCString(cf, buf.as_mut_ptr() as *mut c_char, size, UTF8) } != 0;
        if !ok {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        Some(String::from_utf8_lossy(&buf[..end]).into_owned())
    }

    pub fn is_trusted() -> bool {
        // SAFETY: no arguments; does not prompt.
        unsafe { AXIsProcessTrusted() != 0 }
    }

    /// Shows the macOS "allow Accessibility" dialog (only from an explicit user click) and returns the current state.
    pub fn prompt_trust() -> bool {
        // SAFETY: the key and value are framework constants; the dictionary is released by `Owned`.
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let dict = Owned(CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
            AXIsProcessTrustedWithOptions(dict.0) != 0
        }
    }

    pub fn running_pid(bundle_id: &str) -> Option<i32> {
        use objc2_app_kit::NSRunningApplication;
        use objc2_foundation::NSString;
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id));
        apps.iter().map(|a| a.processIdentifier()).find(|p| *p > 0)
    }

    struct Names {
        role: Owned,
        title: Owned,
        description: Owned,
        value: Owned,
        children: Owned,
        windows: Owned,
    }

    fn names() -> Option<Names> {
        Some(Names {
            role: cf_string("AXRole")?,
            title: cf_string("AXTitle")?,
            description: cf_string("AXDescription")?,
            value: cf_string("AXValue")?,
            children: cf_string("AXChildren")?,
            windows: cf_string("AXWindows")?,
        })
    }

    fn copy(el: CfRef, attr: &Owned) -> Result<Option<Owned>, AxError> {
        let mut out: CfRef = std::ptr::null();
        // SAFETY: live element and attribute; `out` is written on success.
        let e = unsafe { AXUIElementCopyAttributeValue(el, attr.0, &mut out) };
        if e != AX_OK {
            return Err(e);
        }
        Ok((!out.is_null()).then(|| Owned(out)))
    }

    fn map_err(e: AxError) -> Option<AxReadError> {
        match e {
            AX_ERROR_API_DISABLED => Some(AxReadError::PermissionDenied),
            AX_ERROR_CANNOT_COMPLETE => Some(AxReadError::CannotComplete),
            _ => None, // attribute missing, wrong type, ...: just not this node
        }
    }

    fn str_attr(el: CfRef, attr: &Owned) -> Result<Option<String>, AxReadError> {
        match copy(el, attr) {
            Ok(Some(v)) => Ok(string_of(v.0)),
            Ok(None) => Ok(None),
            Err(e) => map_err(e).map_or(Ok(None), Err),
        }
    }

    struct Budget {
        left: usize,
        deadline: Instant,
    }

    /// Children (or windows) of `el` as an owned array plus its count; empty on any non-fatal error.
    fn array(el: CfRef, attr: &Owned) -> Result<Option<(Owned, isize)>, AxReadError> {
        match copy(el, attr) {
            Ok(Some(a)) => {
                // SAFETY: type query on a live object.
                if unsafe { CFGetTypeID(a.0) != CFArrayGetTypeID() } {
                    return Ok(None);
                }
                // SAFETY: `a` is a live CFArray.
                let n = unsafe { CFArrayGetCount(a.0) };
                Ok(Some((a, n)))
            }
            Ok(None) => Ok(None),
            Err(e) => map_err(e).map_or(Ok(None), Err),
        }
    }

    fn node(el: CfRef, depth: u32, n: &Names, b: &mut Budget) -> Result<Option<AxNode>, AxReadError> {
        if b.left == 0 || Instant::now() >= b.deadline {
            return Ok(None);
        }
        b.left -= 1;
        // SAFETY: `el` is live for this call (owned by the array the caller holds); the timeout is advisory.
        let _ = unsafe { AXUIElementSetMessagingTimeout(el, MESSAGING_TIMEOUT_S) };
        let role = str_attr(el, &n.role)?.unwrap_or_default();
        let mut out = AxNode { role, ..Default::default() };
        match out.role.as_str() {
            "AXWindow" => out.title = str_attr(el, &n.title)?,
            "AXGroup" => out.description = str_attr(el, &n.description)?,
            "AXStaticText" => out.value = str_attr(el, &n.value)?,
            _ => {}
        }
        if depth < MAX_DEPTH {
            if let Some((arr, count)) = array(el, &n.children)? {
                for i in 0..count {
                    // SAFETY: index within the count; the array keeps the child alive while `arr` lives.
                    let child = unsafe { CFArrayGetValueAtIndex(arr.0, i) };
                    if child.is_null() {
                        continue;
                    }
                    match node(child, depth + 1, n, b)? {
                        Some(c) => out.children.push(c),
                        None => break, // budget or deadline
                    }
                }
            }
        }
        Ok(Some(out))
    }

    pub fn read_app_tree(bundle_id: &str) -> Result<Option<AxAppTree>, AxReadError> {
        let Some(pid) = running_pid(bundle_id) else { return Ok(None) };
        if !is_trusted() {
            return Err(AxReadError::PermissionDenied);
        }
        let n = names().ok_or(AxReadError::Unsupported)?;
        // SAFETY: creates an app element for a live pid; released by `Owned`.
        let app = Owned(unsafe { AXUIElementCreateApplication(pid) });
        if app.0.is_null() {
            return Ok(None);
        }
        // SAFETY: live element; the timeout is advisory.
        let _ = unsafe { AXUIElementSetMessagingTimeout(app.0, MESSAGING_TIMEOUT_S) };
        let mut b = Budget { left: MAX_NODES, deadline: Instant::now() + READ_DEADLINE };
        let mut windows = Vec::new();
        if let Some((arr, count)) = array(app.0, &n.windows)? {
            for i in 0..count {
                // SAFETY: as in `node`.
                let w = unsafe { CFArrayGetValueAtIndex(arr.0, i) };
                if w.is_null() {
                    continue;
                }
                match node(w, 0, &n, &mut b)? {
                    Some(win) => windows.push(win),
                    None => break,
                }
            }
        }
        Ok(Some(AxAppTree { bundle_id: bundle_id.to_string(), windows }))
    }
}
```

Add `mod capture_ax_macos;` to `lib.rs`.

- [ ] **Step 4: Add the spike-only fixture recorder (for the user's real-meeting check)**

Append to `capture_ax_macos.rs`:

```rust
/// Spike-only: writes one app's tree as pretty JSON to `<desktop_data_dir>/capture-fixtures/` and returns the
/// path. The file holds REAL caption text and names: scrub it before it goes anywhere near the repo
/// (docs/how-to/desktop-live-capture.md "Recording a fixture").
#[cfg(feature = "spike")]
#[tauri::command]
pub async fn capture_dump_tree(bundle_id: String) -> Result<String, String> {
    if !matches!(bundle_id.as_str(), "us.zoom.xos" | "com.microsoft.teams2") {
        return Err("invalid_app: only the meeting apps the readers know".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tree = read_app_tree(&bundle_id).map_err(|e| format!("ax: {e:?}"))?.ok_or("not_running")?;
        let dir = crate::fsutil::desktop_data_dir()?.join("capture-fixtures");
        std::fs::create_dir_all(&dir).map_err(|e| format!("io: {e}"))?;
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let path = dir.join(format!("{bundle_id}-{ms}.json"));
        std::fs::write(&path, serde_json::to_vec_pretty(&tree).map_err(|e| format!("io: {e}"))?).map_err(|e| format!("io: {e}"))?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| format!("io: {e}"))?
}
```

Register it only in the spike block. In `lib.rs`, inside `#[cfg(feature = "spike")] macro_rules! app_handler`, add `capture_ax_macos::capture_dump_tree` after `ax_probe::ax_probe`. Add `"capture_dump_tree"` to `COMMANDS` in `build.rs`, and add `"allow-capture-dump-tree"` to `capabilities/spike.json` permissions.

- [ ] **Step 5: Run the tests and the capability gate**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_ax && cargo build --lib --features spike`
Expected: PASS (3 tests on macOS, 0 elsewhere) and a clean build.
Run: `cd /Users/dinsmallade/llm-ide/desktop && node scripts/check-capabilities.mjs --product`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/src/capture_ax_macos.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/build.rs desktop/src-tauri/capabilities/spike.json
git commit -m "feat(desktop): bounded macOS Accessibility tree read for the caption readers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Capture session: the pure tick, the row flush policy and finish

**Files:**
- Create: `desktop/src-tauri/src/capture_session.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`mod capture_session;`)

**Interfaces:**
- Consumes: Tasks 1 to 4 (`clean_lines`, `DeltaState`, `CaptionReader`, `all_readers`, `PartialWriter`, `Row`, `FinalMeta`, `finalize`, `local_hms`, `clean_title`, `new_session_id`), `AxAppTree`, `AxReadError`.
- Produces:
  - `pub trait SnapshotSource: Send { fn trusted(&self) -> bool; fn read(&mut self, bundle_id: &str) -> Result<Option<AxAppTree>, AxReadError>; }`
  - `pub struct MacSource;` (implements it over `capture_ax_macos`)
  - `#[serde(tag = "type", rename_all = "snake_case")] pub enum CaptureEvent { State { state: CaptureState, platform: Option<String>, detail: Option<String> }, Append { row: u64, time: String, speaker: String, text: String }, Replace { row: u64, text: String }, Closed { row: u64 } }`
  - `#[serde(rename_all = "snake_case")] pub enum CaptureState { Recording, NoSource, PermissionLost, Full, Stopped, Error }`
  - `pub enum TickOutcome { Continue, PermissionLost, Full }`
  - `pub struct Session` with `pub fn start(dir: &Path, notes_root: PathBuf, language: String, now_ms: i64, now: Instant, readers: Vec<Box<dyn CaptionReader>>) -> Result<Session, String>`, `pub fn id(&self) -> &str`, `pub fn started_at_ms(&self) -> i64`, `pub fn notes_root(&self) -> &Path`, `pub fn tick(&mut self, src: &mut dyn SnapshotSource, now: Instant, now_ms: i64, out: &mut Vec<CaptureEvent>) -> TickOutcome`, `pub fn close_out(&mut self) -> Result<(), String>`, `pub fn finish(self, root: Result<PathBuf, String>, title: &str, now_ms: i64) -> StopResult`
  - `#[serde(rename_all = "camelCase")] pub struct StopResult { pub note: Option<FinalizedNote>, pub kept_partial: bool, pub reason: Option<String> }`

Row policy, from `CaptionOrchestrator`: a row is written to the partial when it closes, when it has not grown for 3 s, or once it has been pending for 15 s. Growth after a row was written changes only the in-memory mirror, and the final note is always built from that mirror. "No captions detected" is reported once, after 8 s with no rows and no panel. At 50,000 rows the session stops with `Full`, keeping everything; that bounds memory at about 15 MB.

- [ ] **Step 1: Write the failing tests**

Bottom of `capture_session.rs` (after stubs for every interface):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_model::AxNode;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("llmide-sess-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Teams frames by tick; `None` entries mean "Teams not running"; Zoom is never running.
    struct Fake {
        trusted: bool,
        teams: VecDeque<Result<Option<AxAppTree>, AxReadError>>,
    }
    impl SnapshotSource for Fake {
        fn trusted(&self) -> bool {
            self.trusted
        }
        fn read(&mut self, bundle_id: &str) -> Result<Option<AxAppTree>, AxReadError> {
            if bundle_id != "com.microsoft.teams2" {
                return Ok(None);
            }
            self.teams.pop_front().unwrap_or(Ok(None))
        }
    }

    fn teams(rows: &[(&str, &str)]) -> Result<Option<AxAppTree>, AxReadError> {
        let groups = rows
            .iter()
            .map(|(s, t)| AxNode { role: "AXGroup".into(), children: vec![
                AxNode { role: "AXStaticText".into(), value: Some(s.to_string()), ..Default::default() },
                AxNode { role: "AXStaticText".into(), value: Some(t.to_string()), ..Default::default() },
            ], ..Default::default() })
            .collect();
        let panel = AxNode { role: "AXGroup".into(), description: Some("Live captions".into()), children: groups, ..Default::default() };
        Ok(Some(AxAppTree { bundle_id: "com.microsoft.teams2".into(), windows: vec![AxNode { role: "AXWindow".into(), children: vec![panel], ..Default::default() }] }))
    }

    fn start(tag: &str) -> (Session, PathBuf, PathBuf, Instant) {
        let (dir, root) = (scratch(&format!("{tag}-d")), scratch(&format!("{tag}-r")));
        let t0 = Instant::now();
        let s = Session::start(&dir, root.clone(), "en".into(), 1_762_335_000_000, t0, crate::capture_readers::all_readers()).unwrap();
        (s, dir, root, t0)
    }

    fn kinds(out: &[CaptureEvent]) -> Vec<&'static str> {
        out.iter().map(|e| match e {
            CaptureEvent::State { .. } => "state",
            CaptureEvent::Append { .. } => "append",
            CaptureEvent::Replace { .. } => "replace",
            CaptureEvent::Closed { .. } => "closed",
        }).collect()
    }

    #[test]
    fn capture_session_streams_only_changes() {
        let (mut s, ..) = start("stream");
        let t0 = Instant::now();
        let mut src = Fake { trusted: true, teams: VecDeque::from(vec![teams(&[("Alice", "Hello")]), teams(&[("Alice", "Hello")]), teams(&[("Alice", "Hello there.")])]) };
        let mut out = Vec::new();
        s.tick(&mut src, t0, 1, &mut out);
        assert_eq!(kinds(&out), vec!["state", "append"], "first read: platform state + one row");
        out.clear();
        s.tick(&mut src, t0 + Duration::from_millis(800), 2, &mut out);
        assert!(out.is_empty(), "unchanged snapshot sends nothing");
        s.tick(&mut src, t0 + Duration::from_millis(1600), 3, &mut out);
        assert_eq!(out, vec![CaptureEvent::Replace { row: 0, text: "Hello there.".into() }]);
    }

    #[test]
    fn capture_session_no_source_reported_once_after_8s() {
        let (mut s, ..) = start("nosrc");
        let t0 = Instant::now();
        let mut src = Fake { trusted: true, teams: VecDeque::new() };
        let mut out = Vec::new();
        s.tick(&mut src, t0 + Duration::from_secs(7), 1, &mut out);
        assert!(out.is_empty());
        s.tick(&mut src, t0 + Duration::from_secs(9), 2, &mut out);
        s.tick(&mut src, t0 + Duration::from_secs(10), 3, &mut out);
        assert_eq!(out, vec![CaptureEvent::State { state: CaptureState::NoSource, platform: None, detail: None }]);
    }

    #[test]
    fn capture_session_permission_lost_keeps_rows_and_finishes() {
        let (mut s, _dir, root, _) = start("perm");
        let t0 = Instant::now();
        let mut src = Fake { trusted: true, teams: VecDeque::from(vec![teams(&[("Alice", "Hello.")])]) };
        let mut out = Vec::new();
        s.tick(&mut src, t0, 1, &mut out);
        src.trusted = false;
        out.clear();
        assert!(matches!(s.tick(&mut src, t0 + Duration::from_secs(1), 2, &mut out), TickOutcome::PermissionLost));
        assert_eq!(kinds(&out), vec!["state"]);
        let r = s.finish(Ok(root.clone()), "Sync", 1_762_335_060_000);
        let note = r.note.expect("captured text is kept and saved");
        assert_eq!(note.lines, 1);
        assert!(std::fs::read_to_string(root.join(note.rel)).unwrap().contains("**Alice**: Hello."));
    }

    #[test]
    fn capture_session_ax_permission_error_is_permission_lost() {
        let (mut s, ..) = start("axperm");
        let mut src = Fake { trusted: true, teams: VecDeque::from(vec![Err(AxReadError::PermissionDenied)]) };
        assert!(matches!(s.tick(&mut src, Instant::now(), 1, &mut Vec::new()), TickOutcome::PermissionLost));
    }

    #[test]
    fn capture_session_idle_row_reaches_the_partial_before_stop() {
        let (mut s, dir, ..) = start("idle");
        let t0 = Instant::now();
        let mut src = Fake { trusted: true, teams: VecDeque::from(vec![teams(&[("Alice", "Hello.")]), teams(&[("Alice", "Hello.")])]) };
        s.tick(&mut src, t0, 1, &mut Vec::new());
        s.tick(&mut src, t0 + Duration::from_secs(4), 2, &mut Vec::new());
        s.close_out().unwrap();
        let p = crate::capture_store::partial_path(&dir, s.id()).unwrap();
        let r = crate::capture_store::read_partial(&p).unwrap();
        assert_eq!(r.rows.len(), 1, "a row idle for 3 s is on disk (crash loses at most seconds)");
        assert_eq!(r.platform.as_deref(), Some("teams"));
    }

    #[test]
    fn capture_session_empty_stop_saves_nothing_and_removes_the_partial() {
        let (s, dir, root, _) = start("empty");
        let id = s.id().to_string();
        let r = s.finish(Ok(root), "", 1);
        assert!(r.note.is_none() && !r.kept_partial);
        assert_eq!(r.reason.as_deref(), Some("empty"));
        assert!(!crate::capture_store::partial_path(&dir, &id).unwrap().exists());
    }

    #[test]
    fn capture_session_missing_notes_root_keeps_the_partial() {
        let (mut s, dir, ..) = start("noroot");
        let mut src = Fake { trusted: true, teams: VecDeque::from(vec![teams(&[("Alice", "Hello.")])]) };
        s.tick(&mut src, Instant::now(), 1, &mut Vec::new());
        let id = s.id().to_string();
        let r = s.finish(Err("no_root: notes folder is gone".into()), "x", 2);
        assert!(r.note.is_none() && r.kept_partial);
        assert!(crate::capture_store::partial_path(&dir, &id).unwrap().exists());
    }

    #[test]
    fn capture_session_events_serialize_for_the_webview() {
        let e = CaptureEvent::Append { row: 3, time: "09:30:01".into(), speaker: "A".into(), text: "<b>x</b>".into() };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"append","row":3,"time":"09:30:01","speaker":"A","text":"<b>x</b>"}"#);
        let st = CaptureEvent::State { state: CaptureState::PermissionLost, platform: None, detail: None };
        assert_eq!(serde_json::to_string(&st).unwrap(), r#"{"type":"state","state":"permission_lost","platform":null,"detail":null}"#);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_session`
Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
//! One live capture: picks the meeting app whose captions panel is on screen, runs reader -> clean_lines ->
//! DeltaState every tick, streams only changes (append / replace / closed) and keeps the crash partial current.
//! Pure apart from the partial file: time and the AX source are injected, so the tests drive it tick by tick.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::capture_delta::{CaptionDelta, DeltaState};
use crate::capture_model::{AxAppTree, AxReadError};
use crate::capture_readers::CaptionReader;
use crate::capture_store::{self, FinalMeta, FinalizedNote, PartialHeader, PartialWriter, Row};
use crate::capture_validate::clean_lines;

const ROW_CLOSE_AFTER: Duration = Duration::from_secs(3);
const ROW_MAX_PENDING: Duration = Duration::from_secs(15);
const NO_SOURCE_AFTER: Duration = Duration::from_secs(8);
/// Memory bound (about 15 MB); a 4-hour meeting is about 20k rows.
pub const MAX_ROWS: usize = 50_000;

pub trait SnapshotSource: Send {
    fn trusted(&self) -> bool;
    fn read(&mut self, bundle_id: &str) -> Result<Option<AxAppTree>, AxReadError>;
}

pub struct MacSource;
impl SnapshotSource for MacSource {
    fn trusted(&self) -> bool {
        crate::capture_ax_macos::is_trusted()
    }
    fn read(&mut self, bundle_id: &str) -> Result<Option<AxAppTree>, AxReadError> {
        crate::capture_ax_macos::read_app_tree(bundle_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Recording,
    NoSource,
    PermissionLost,
    Full,
    Stopped,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CaptureEvent {
    State { state: CaptureState, platform: Option<String>, detail: Option<String> },
    Append { row: u64, time: String, speaker: String, text: String },
    Replace { row: u64, text: String },
    Closed { row: u64 },
}

pub enum TickOutcome {
    Continue,
    PermissionLost,
    Full,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    pub note: Option<FinalizedNote>,
    pub kept_partial: bool,
    pub reason: Option<String>,
}

struct Pending {
    first_seen: Instant,
    changed: Instant,
}

pub struct Session {
    header: PartialHeader,
    notes_root: PathBuf,
    writer: PartialWriter,
    delta: DeltaState,
    readers: Vec<Box<dyn CaptionReader>>,
    preferred: Option<usize>,
    platform: Option<&'static str>,
    rows: BTreeMap<u64, Row>,
    pending: BTreeMap<u64, Pending>,
    started: Instant,
    no_source_flagged: bool,
}

fn state(state: CaptureState, platform: Option<&str>) -> CaptureEvent {
    CaptureEvent::State { state, platform: platform.map(str::to_string), detail: None }
}

impl Session {
    pub fn start(dir: &Path, notes_root: PathBuf, language: String, now_ms: i64, now: Instant, readers: Vec<Box<dyn CaptionReader>>) -> Result<Session, String> {
        let header = PartialHeader { v: 1, id: capture_store::new_session_id(now_ms), started_at_ms: now_ms, language, notes_root: notes_root.display().to_string() };
        let writer = PartialWriter::create(dir, &header)?;
        Ok(Session {
            header,
            notes_root,
            writer,
            delta: DeltaState::new(),
            readers,
            preferred: None,
            platform: None,
            rows: BTreeMap::new(),
            pending: BTreeMap::new(),
            started: now,
            no_source_flagged: false,
        })
    }

    pub fn id(&self) -> &str {
        &self.header.id
    }
    pub fn started_at_ms(&self) -> i64 {
        self.header.started_at_ms
    }
    pub fn notes_root(&self) -> &Path {
        &self.notes_root
    }

    pub fn tick(&mut self, src: &mut dyn SnapshotSource, now: Instant, now_ms: i64, out: &mut Vec<CaptureEvent>) -> TickOutcome {
        if !src.trusted() {
            return self.lose_permission(out);
        }
        self.flush_idle(now);
        let mut order: Vec<usize> = (0..self.readers.len()).collect();
        if let Some(p) = self.preferred {
            order.retain(|i| *i != p);
            order.insert(0, p);
        }
        let mut found = None;
        for idx in order {
            match src.read(self.readers[idx].bundle_id()) {
                Ok(Some(tree)) => {
                    if let Some(lines) = self.readers[idx].read(&tree) {
                        found = Some((idx, lines));
                        break;
                    }
                }
                Ok(None) | Err(AxReadError::CannotComplete) | Err(AxReadError::Unsupported) => {}
                Err(AxReadError::PermissionDenied) => return self.lose_permission(out),
            }
        }
        let Some((idx, lines)) = found else {
            if self.rows.is_empty() && !self.no_source_flagged && now.duration_since(self.started) >= NO_SOURCE_AFTER {
                self.no_source_flagged = true;
                out.push(state(CaptureState::NoSource, None));
            }
            // The panel closed: count it as an empty snapshot so open rows close after MAX_EMPTY_TICKS.
            for d in self.delta.ingest(&[]) {
                self.apply(d, now, now_ms, out);
            }
            return TickOutcome::Continue;
        };
        self.preferred = Some(idx);
        let platform = self.readers[idx].platform();
        if self.platform != Some(platform) {
            self.platform = Some(platform);
            self.no_source_flagged = false;
            let _ = self.writer.set_platform(platform);
            out.push(state(CaptureState::Recording, Some(platform)));
        }
        for d in self.delta.ingest(&clean_lines(lines)) {
            self.apply(d, now, now_ms, out);
        }
        if self.rows.len() >= MAX_ROWS {
            let _ = self.close_out();
            out.push(state(CaptureState::Full, self.platform));
            return TickOutcome::Full;
        }
        TickOutcome::Continue
    }

    fn lose_permission(&mut self, out: &mut Vec<CaptureEvent>) -> TickOutcome {
        let _ = self.close_out();
        out.push(state(CaptureState::PermissionLost, self.platform));
        TickOutcome::PermissionLost
    }

    fn apply(&mut self, d: CaptionDelta, now: Instant, now_ms: i64, out: &mut Vec<CaptureEvent>) {
        match d {
            CaptionDelta::Append { row, speaker, text } => {
                let time = capture_store::local_hms(now_ms);
                self.rows.insert(row, Row { time: time.clone(), speaker: speaker.clone(), text: text.clone() });
                self.pending.insert(row, Pending { first_seen: now, changed: now });
                out.push(CaptureEvent::Append { row, time, speaker, text });
            }
            CaptionDelta::Replace { row, speaker, new_text, .. } => {
                let time = capture_store::local_hms(now_ms);
                let r = self.rows.entry(row).or_insert(Row { time, speaker: speaker.clone(), text: String::new() });
                r.speaker = speaker;
                r.text = new_text.clone();
                if let Some(p) = self.pending.get_mut(&row) {
                    p.changed = now;
                }
                out.push(CaptureEvent::Replace { row, text: new_text });
            }
            CaptionDelta::Closed { row } => {
                self.flush_row(row);
                out.push(CaptureEvent::Closed { row });
            }
        }
    }

    fn flush_row(&mut self, row: u64) {
        if self.pending.remove(&row).is_some() {
            if let Some(r) = self.rows.get(&row) {
                // A failed write leaves the row in memory; it still reaches the final note.
                let _ = self.writer.append_row(r);
            }
        }
    }

    fn flush_idle(&mut self, now: Instant) {
        let due: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, p)| now.duration_since(p.changed) >= ROW_CLOSE_AFTER || now.duration_since(p.first_seen) >= ROW_MAX_PENDING)
            .map(|(k, _)| *k)
            .collect();
        for row in due {
            self.flush_row(row);
        }
    }

    /// Writes every pending row (row order) and syncs the partial. Used by Stop, permission loss and app quit.
    pub fn close_out(&mut self) -> Result<(), String> {
        let rows: Vec<u64> = self.pending.keys().copied().collect();
        for row in rows {
            self.flush_row(row);
        }
        self.writer.sync()
    }

    /// Ends the capture. `root` is the notes root re-validated by the caller.
    pub fn finish(mut self, root: Result<PathBuf, String>, title: &str, now_ms: i64) -> StopResult {
        let _ = self.close_out();
        let partial = self.writer.path().to_path_buf();
        if self.rows.is_empty() {
            let _ = std::fs::remove_file(&partial);
            return StopResult { note: None, kept_partial: false, reason: Some("empty".into()) };
        }
        let rows: Vec<Row> = self.rows.values().cloned().collect();
        let title = capture_store::clean_title(title);
        let meta = FinalMeta {
            id: &self.header.id,
            title: &title,
            started_at_ms: self.header.started_at_ms,
            ended_at_ms: now_ms,
            platform: self.platform.unwrap_or("mic"),
            language: &self.header.language,
        };
        match root.and_then(|r| capture_store::finalize(&r, Some(&partial), &meta, &rows)) {
            Ok(note) => StopResult { note: Some(note), kept_partial: false, reason: None },
            Err(e) => StopResult { note: None, kept_partial: true, reason: Some(e) },
        }
    }
}
```

Add `mod capture_session;` to `lib.rs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_session`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/capture_session.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): capture session tick with change-only events and crash-safe rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Host commands, worker thread, recovery and exit flush

**Files:**
- Create: `desktop/src-tauri/src/capture_host.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (module; 8 handlers in `product_handlers!`; `capture_host::shutdown()` in the `RunEvent::ExitRequested | RunEvent::Exit` arm, line 559, before `CoreHost` shutdown)
- Modify: `desktop/src-tauri/build.rs` (`COMMANDS`)
- Modify: `desktop/src-tauri/capabilities/default.json` (8 grants, plus a line in `description`)

**Interfaces:**
- Consumes: `Session`, `MacSource`, `CaptureEvent`, `StopResult`, `capture_store::{list_partials, partial_path, read_partial, finalize, FinalMeta, clean_title, PartialSummary}`, `notes_fs::{current_root, validate_notes_root}`, `fsutil::desktop_data_dir`, `trash_guard::{OsTrash, Trasher}`, `capture_ax_macos::{SUPPORTED, is_trusted, prompt_trust, running_pid}`.
- Produces Tauri commands (JS names): `capture_status() -> CaptureStatus { supported, trusted, recording, sessionId, startedAtMs, notesRoot, macAppRunning, devBuild }`, `capture_request_permission() -> bool`, `capture_open_settings() -> ()`, `capture_start({ language, onEvent }) -> { sessionId, startedAtMs }`, `capture_stop({ title }) -> StopResult`, `capture_recover_list() -> PartialSummary[]`, `capture_recover_finish({ id, title }) -> StopResult`, `capture_recover_discard({ id }) -> ()`. Error strings begin with a code: `unsupported`, `not_trusted`, `no_notes_root`, `already_recording`, `not_recording`, `invalid_language`, `invalid_id`, `not_found`, `io`, `trash_unavailable`.
- Produces: `pub fn shutdown()`.

- [ ] **Step 1: Write the failing tests (the pieces that need no AX: argument checks and the stop path with a fake source)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_host_language_tags() {
        for ok in ["en", "ja", "pt-BR", "zh_Hant"] {
            assert!(valid_language(ok), "{ok}");
        }
        for bad in ["", "en us", "<x>", &"a".repeat(36)] {
            assert!(!valid_language(bad), "{bad}");
        }
    }

    #[test]
    fn capture_host_stop_without_capture_is_an_error() {
        assert!(take_active().is_none());
        let err = tauri::async_runtime::block_on(capture_stop("x".into())).unwrap_err();
        assert!(err.starts_with("not_recording"), "{err}");
    }

    #[test]
    fn capture_host_recovery_ids_are_validated() {
        assert!(tauri::async_runtime::block_on(capture_recover_finish("../../etc".into(), "".into())).unwrap_err().starts_with("invalid_id"));
        assert!(capture_recover_discard("m-x/../../y".into()).unwrap_err().starts_with("invalid_id"));
    }
}
```

Run: `cargo test --lib capture_host` and expect FAIL.

- [ ] **Step 2: Implement**

```rust
//! Live capture host commands. One capture at a time, run on its own thread ("llmide-capture"): AX reads never
//! touch the UI thread, and a hung meeting app costs at most one tick (per-element 0.3 s timeouts, 0.5 s per app).
//! The webview gets change-only events over a Channel and never sees a path or the notes root. Privacy: capture
//! begins only in `capture_start` (an explicit click), reads caption text only (no audio API exists in this
//! module or its dependencies), and never logs speaker or text.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;

use crate::capture_ax_macos as ax;
use crate::capture_session::{CaptureEvent, CaptureState, MacSource, Session, SnapshotSource, StopResult, TickOutcome};
use crate::capture_store::{self, FinalMeta, PartialSummary};
use crate::trash_guard::{OsTrash, Trasher};

/// SCRAPE_INTERVAL_MS (invariants.md).
const TICK: Duration = Duration::from_millis(800);
const MIN_GAP: Duration = Duration::from_millis(50);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const MAC_APP_BUNDLE_ID: &str = "com.llmide.macapp";
const AX_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

enum Cmd {
    Stop { title: String, reply: mpsc::Sender<StopResult> },
    Abort,
}

struct Active {
    id: String,
    started_at_ms: i64,
    tx: mpsc::Sender<Cmd>,
    join: Option<JoinHandle<()>>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn capture_dir() -> Result<PathBuf, String> {
    Ok(crate::fsutil::desktop_data_dir()?.join("capture"))
}

fn valid_language(s: &str) -> bool {
    !s.is_empty() && s.len() <= 35 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn take_active() -> Option<Active> {
    ACTIVE.lock().ok().and_then(|mut g| g.take())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub supported: bool,
    pub trusted: bool,
    pub recording: bool,
    pub session_id: Option<String>,
    pub started_at_ms: Option<i64>,
    pub notes_root: bool,
    pub mac_app_running: bool,
    /// A debug build launched from a terminal is attributed to the terminal by TCC (docs/how-to/desktop-live-capture.md).
    pub dev_build: bool,
}

#[tauri::command]
pub fn capture_status() -> CaptureStatus {
    let (recording, session_id, started_at_ms) = match ACTIVE.lock().ok().as_deref() {
        Some(Some(a)) => (true, Some(a.id.clone()), Some(a.started_at_ms)),
        _ => (false, None, None),
    };
    CaptureStatus {
        supported: ax::SUPPORTED,
        trusted: ax::is_trusted(),
        recording,
        session_id,
        started_at_ms,
        notes_root: crate::notes_fs::current_root().is_ok(),
        mac_app_running: ax::running_pid(MAC_APP_BUNDLE_ID).is_some(),
        dev_build: cfg!(debug_assertions),
    }
}

/// Shows the macOS Accessibility dialog. Only the Live screen's "Allow Accessibility" button calls this.
#[tauri::command]
pub fn capture_request_permission() -> bool {
    ax::prompt_trust()
}

#[tauri::command]
pub fn capture_open_settings() -> Result<(), String> {
    if !ax::SUPPORTED {
        return Err("unsupported: Accessibility settings exist on macOS only".into());
    }
    // Fixed URL; nothing from the webview reaches the command line.
    std::process::Command::new("/usr/bin/open").arg(AX_SETTINGS_URL).status().map_err(|e| format!("io: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub session_id: String,
    pub started_at_ms: i64,
}

#[tauri::command]
pub fn capture_start(language: String, on_event: Channel<CaptureEvent>) -> Result<StartInfo, String> {
    if !ax::SUPPORTED {
        return Err("unsupported: live capture is macOS-only in this version".into());
    }
    if !valid_language(&language) {
        return Err("invalid_language: expected a short language tag".into());
    }
    if !ax::is_trusted() {
        return Err("not_trusted: Accessibility is not allowed for LLM-IDE".into());
    }
    let root = crate::notes_fs::current_root().map_err(|e| format!("no_notes_root: {e}"))?;
    let mut guard = ACTIVE.lock().map_err(|_| "io: capture state poisoned".to_string())?;
    if guard.is_some() {
        return Err("already_recording: stop the current capture first".into());
    }
    let session = Session::start(&capture_dir()?, root, language, now_ms(), Instant::now(), crate::capture_readers::all_readers())?;
    let info = StartInfo { session_id: session.id().to_string(), started_at_ms: session.started_at_ms() };
    let (tx, rx) = mpsc::channel();
    let join = std::thread::Builder::new()
        .name("llmide-capture".into())
        .spawn(move || run(session, Box::new(MacSource), rx, on_event))
        .map_err(|e| format!("io: {e}"))?;
    *guard = Some(Active { id: info.session_id.clone(), started_at_ms: info.started_at_ms, tx, join: Some(join) });
    Ok(info)
}

fn finish(session: Session, title: &str) -> StopResult {
    let root = crate::notes_fs::validate_notes_root(session.notes_root()).or_else(|_| crate::notes_fs::current_root());
    session.finish(root, title, now_ms())
}

fn run(mut session: Session, mut src: Box<dyn SnapshotSource>, rx: mpsc::Receiver<Cmd>, chan: Channel<CaptureEvent>) {
    let start = Instant::now();
    let mut n: u32 = 0;
    loop {
        let mut out = Vec::new();
        let outcome = session.tick(src.as_mut(), Instant::now(), now_ms(), &mut out);
        for e in out {
            let _ = chan.send(e);
        }
        if !matches!(outcome, TickOutcome::Continue) {
            break; // permission lost or full: everything is kept; wait for Stop
        }
        n += 1;
        let wait = (start + TICK * n).saturating_duration_since(Instant::now()).max(MIN_GAP);
        match rx.recv_timeout(wait) {
            Ok(Cmd::Stop { title, reply }) => {
                let _ = reply.send(finish(session, &title));
                let _ = chan.send(CaptureEvent::State { state: CaptureState::Stopped, platform: None, detail: None });
                return;
            }
            Ok(Cmd::Abort) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = session.close_out(); // the partial stays for recovery at next launch
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    match rx.recv() {
        Ok(Cmd::Stop { title, reply }) => {
            let _ = reply.send(finish(session, &title));
            let _ = chan.send(CaptureEvent::State { state: CaptureState::Stopped, platform: None, detail: None });
        }
        _ => {
            let _ = session.close_out();
        }
    }
}

#[tauri::command]
pub async fn capture_stop(title: String) -> Result<StopResult, String> {
    let Some(mut active) = take_active() else { return Err("not_recording: no capture is running".into()) };
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, got) = mpsc::channel();
        active.tx.send(Cmd::Stop { title, reply }).map_err(|_| "io: capture thread is gone".to_string())?;
        let r = got.recv_timeout(STOP_TIMEOUT).map_err(|_| "io: capture did not stop in time; the partial is kept".to_string())?;
        if let Some(j) = active.join.take() {
            let _ = j.join();
        }
        Ok(r)
    })
    .await
    .map_err(|e| format!("io: {e}"))?
}

fn active_id() -> Option<String> {
    ACTIVE.lock().ok().and_then(|g| g.as_ref().map(|a| a.id.clone()))
}

#[tauri::command]
pub fn capture_recover_list() -> Vec<PartialSummary> {
    capture_dir().map(|d| capture_store::list_partials(&d, active_id().as_deref())).unwrap_or_default()
}

fn recover_path(id: &str) -> Result<PathBuf, String> {
    if active_id().as_deref() == Some(id) {
        return Err("invalid_id: this capture is still running".into());
    }
    let p = capture_store::partial_path(&capture_dir()?, id).ok_or("invalid_id: bad capture id")?;
    if !p.is_file() {
        return Err("not_found: no unfinished capture with this id".into());
    }
    Ok(p)
}

#[tauri::command]
pub async fn capture_recover_finish(id: String, title: String) -> Result<StopResult, String> {
    if !capture_store::valid_session_id(&id) {
        return Err("invalid_id: bad capture id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = recover_path(&id)?;
        let r = capture_store::read_partial(&path)?;
        if r.rows.is_empty() {
            OsTrash.trash(&path).map_err(|e| format!("trash_unavailable: {}", e.message))?;
            return Ok(StopResult { note: None, kept_partial: false, reason: Some("empty".into()) });
        }
        let root = crate::notes_fs::validate_notes_root(std::path::Path::new(&r.header.notes_root)).or_else(|_| crate::notes_fs::current_root())?;
        let ended = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or_else(now_ms);
        let title = capture_store::clean_title(&title);
        let meta = FinalMeta { id: &r.header.id, title: &title, started_at_ms: r.header.started_at_ms, ended_at_ms: ended, platform: r.platform.as_deref().unwrap_or("mic"), language: &r.header.language };
        Ok(match capture_store::finalize(&root, Some(&path), &meta, &r.rows) {
            Ok(note) => StopResult { note: Some(note), kept_partial: false, reason: None },
            Err(e) => StopResult { note: None, kept_partial: true, reason: Some(e) },
        })
    })
    .await
    .map_err(|e| format!("io: {e}"))?
}

/// Moves an unfinished capture to the OS trash (never a permanent delete).
#[tauri::command]
pub fn capture_recover_discard(id: String) -> Result<(), String> {
    if !capture_store::valid_session_id(&id) {
        return Err("invalid_id: bad capture id".into());
    }
    OsTrash.trash(&recover_path(&id)?).map_err(|e| format!("trash_unavailable: {}", e.message))
}

/// App quit: flush the partial (no finalize); the next launch offers to finish it.
pub fn shutdown() {
    if let Some(mut a) = take_active() {
        let _ = a.tx.send(Cmd::Abort);
        if let Some(j) = a.join.take() {
            let _ = j.join();
        }
    }
}
```

Check that `TrashError` has a `message` field (`trash_guard.rs:16`). If the field has another name, use it.

- [ ] **Step 3: Register**

In `lib.rs`: add `mod capture_host;`. In `product_handlers!`'s `generate_handler![…]`, after `ax`-unrelated product entries, add:

```rust
                capture_host::capture_status,
                capture_host::capture_request_permission,
                capture_host::capture_open_settings,
                capture_host::capture_start,
                capture_host::capture_stop,
                capture_host::capture_recover_list,
                capture_host::capture_recover_finish,
                capture_host::capture_recover_discard,
```

In the exit arm (`lib.rs:559`), insert `capture_host::shutdown();` as the first line inside the block, so the partial is flushed while the process is still alive.

In `build.rs` `COMMANDS`, add `"capture_status", "capture_request_permission", "capture_open_settings", "capture_start", "capture_stop", "capture_recover_list", "capture_recover_finish", "capture_recover_discard",`.

In `capabilities/default.json`, add `"allow-capture-status", "allow-capture-request-permission", "allow-capture-open-settings", "allow-capture-start", "allow-capture-stop", "allow-capture-recover-list", "allow-capture-recover-finish", "allow-capture-recover-discard"`. Append to `description`: `, live caption capture (capture_*: Accessibility status and prompt on click, fixed Settings URL, start/stop on an explicit click, recovery of the app's own unfinished captures; no paths from the webview)`.

- [ ] **Step 4: Run tests and gates**

Run: `cd /Users/dinsmallade/llm-ide/desktop/src-tauri && cargo test --lib capture_`
Expected: PASS (all capture tests from Tasks 1 to 7).
Run: `cd /Users/dinsmallade/llm-ide/desktop && node scripts/check-capabilities.mjs --product && node --test scripts/check-capabilities.test.mjs`
Expected: exit 0 and PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/capture_host.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/build.rs desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): live capture host commands, worker thread and recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Privacy guard (no audio, no caption logging)

**Files:**
- Create: `desktop/scripts/check-capture-privacy.test.mjs` (already picked up by `desktop/package.json` `test`: `scripts/*.test.mjs`)

**Interfaces:**
- Consumes: the files from Tasks 1 to 7 and `desktop/src-tauri/{Cargo.toml,Info.plist,tauri.conf.json}`.

- [ ] **Step 1: Write the test**

```js
// Privacy guard for live capture: the desktop reads caption TEXT through Accessibility and never records audio,
// video or the screen, and caption text never reaches a log. Fails the build if any of that changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TAURI = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const read = (p) => readFileSync(join(TAURI, p), "utf8");
const rustFiles = readdirSync(join(TAURI, "src")).filter((f) => f.endsWith(".rs"));

test("no audio, camera or screen-capture usage strings or entitlements", () => {
  const plist = read("Info.plist");
  for (const key of ["NSMicrophoneUsageDescription", "NSCameraUsageDescription", "NSScreenCaptureUsageDescription", "NSAudioCaptureUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
    assert.equal(plist.includes(key), false, `Info.plist must not declare ${key}`);
  }
  const conf = read("tauri.conf.json");
  assert.equal(/device\.(audio-input|microphone|camera)/.test(conf), false, "no audio/camera entitlement");
});

test("no audio or screen-capture dependency or API", () => {
  const cargo = read("Cargo.toml");
  for (const crate of ["cpal", "coreaudio", "rodio", "screencapturekit", "xcap", "scap", "nokhwa", "AVFoundation"]) {
    assert.equal(cargo.includes(crate), false, `Cargo.toml must not depend on ${crate}`);
  }
  for (const f of rustFiles) {
    const src = read(join("src", f));
    for (const api of ["AVCapture", "AVAudio", "AudioQueue", "AudioUnit", "SCStream", "CGDisplayStream", "CGWindowListCreateImage", "NSSpeechRecognizer"]) {
      assert.equal(src.includes(api), false, `${f} must not use ${api}`);
    }
  }
});

test("capture modules never print caption text", () => {
  for (const f of rustFiles.filter((n) => n.startsWith("capture_"))) {
    const src = read(join("src", f)).split("#[cfg(test)]")[0];
    const prints = src.split("\n").filter((l) => /\b(e?print(ln)?|dbg)!\s*\(/.test(l));
    for (const l of prints) assert.equal(/speaker|text|value|caption|row/.test(l), false, `${f}: ${l.trim()}`);
  }
});
```

- [ ] **Step 2: Run it**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test scripts/check-capture-privacy.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add desktop/scripts/check-capture-privacy.test.mjs
git commit -m "test(desktop): guard that live capture never records audio or logs captions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: UI host wrapper, Tauri channel bridge and the bounded transcript store

**Files:**
- Create: `desktop/src/live/captureBridge.ts`
- Create: `ui/screens/live/host.ts`
- Create: `ui/screens/live/transcript.ts`
- Create: `ui/screens/live/tests/live-model.test.ts`
- Modify: `desktop/package.json` `test` script (append ` ../ui/screens/live/tests/*.test.*`)

**Interfaces:**
- Consumes: `invokeHost` from `ui/screens/shell/host.ts`; Rust payloads from Task 7.
- Produces:
  - `host.ts`: `type CaptureStateName = "recording" | "no_source" | "permission_lost" | "full" | "stopped" | "error"`, `type CaptureEvent`, `interface CaptureStatus { supported; trusted; recording; sessionId; startedAtMs; notesRoot; macAppRunning; devBuild }`, `interface IndexUpsert` (Rust camelCase shape), `interface FinalizedNote { rel; hash; lines; mtimeMs; index: IndexUpsert | null }`, `interface StopResult { note; keptPartial; reason }`, `interface PartialSummary { id; startedAtMs; rows }`, `decodeEvent(v): CaptureEvent | null`, `decodeStatus(v): CaptureStatus`, `decodeStop(v): StopResult`, `decodePartials(v): PartialSummary[]`, `interface CaptureHost { status(); requestPermission(); openSettings(); start(language, onEvent); stop(title); recoverList(); recoverFinish(id, title); recoverDiscard(id) }`, `createCaptureHost(channelFactory?): CaptureHost`, `captureErrorText(e: unknown): string`.
  - `transcript.ts`: `MAX_DISPLAY_ROWS = 20_000`, `PAGE_ROWS = 200`, `interface LiveRow { row; time; speaker; text }`, `class LiveTranscript { apply(ev); size(); dropped; version; tail(n); slice(start, count); clear(); subscribe(l) }`.

- [ ] **Step 1: Write the failing tests**

`ui/screens/live/tests/live-model.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureErrorText, decodeEvent, decodePartials, decodeStatus, decodeStop } from "../host.ts";
import { LiveTranscript, MAX_DISPLAY_ROWS } from "../transcript.ts";

test("events decode strictly and cap their strings", () => {
  assert.deepEqual(decodeEvent({ type: "append", row: 1, time: "09:30:01", speaker: "A", text: "hi" }), { type: "append", row: 1, time: "09:30:01", speaker: "A", text: "hi" });
  assert.equal(decodeEvent({ type: "append", row: -1, time: "x", speaker: "A", text: "hi" }), null);
  assert.equal(decodeEvent({ type: "replace", row: 1 }), null);
  assert.equal(decodeEvent({ type: "nope" }), null);
  assert.equal(decodeEvent(null), null);
  const long = decodeEvent({ type: "replace", row: 2, text: "x".repeat(5000) });
  assert.equal(long?.type === "replace" && long.text.length, 2000);
  assert.deepEqual(decodeEvent({ type: "state", state: "permission_lost", platform: null, detail: null }), { type: "state", state: "permission_lost", platform: null, detail: null });
  assert.equal(decodeEvent({ type: "state", state: "hacked", platform: null, detail: null }), null);
});

test("status, stop and partial lists decode with safe defaults", () => {
  assert.deepEqual(decodeStatus(null), { supported: false, trusted: false, recording: false, sessionId: null, startedAtMs: null, notesRoot: false, macAppRunning: false, devBuild: false });
  assert.equal(decodeStatus({ supported: true, trusted: true, recording: true, sessionId: "m-a-b", startedAtMs: 5, notesRoot: true, macAppRunning: false, devBuild: false }).recording, true);
  assert.deepEqual(decodeStop({ note: null, keptPartial: true, reason: "no_root: x" }), { note: null, keptPartial: true, reason: "no_root: x" });
  assert.equal(decodeStop({ note: { rel: 7 }, keptPartial: false, reason: null }).note, null, "a malformed note is dropped");
  assert.deepEqual(decodePartials([{ id: "m-a-b", startedAtMs: 1, rows: 3 }, { id: 5 }]), [{ id: "m-a-b", startedAtMs: 1, rows: 3 }]);
});

test("host errors map to plain sentences", () => {
  assert.match(captureErrorText("not_trusted: x"), /Accessibility/);
  assert.match(captureErrorText("no_notes_root: x"), /notes folder/);
  assert.match(captureErrorText(new Error("already_recording: x")), /already/);
});

test("transcript: append, replace in place, closed is a no-op, replace of an unknown row appends", () => {
  const t = new LiveTranscript();
  t.apply({ type: "append", row: 0, time: "09:00:00", speaker: "A", text: "Hello" });
  t.apply({ type: "replace", row: 0, text: "Hello there." });
  t.apply({ type: "closed", row: 0 });
  t.apply({ type: "replace", row: 9, text: "late" });
  assert.deepEqual(t.tail(10).map((r) => `${r.speaker}:${r.text}`), ["A:Hello there.", ":late"]);
});

test("transcript: bounded at 20k rows, counts what it dropped, replace stays O(1)", () => {
  const t = new LiveTranscript();
  const n = MAX_DISPLAY_ROWS + 5_000;
  for (let i = 0; i < n; i++) t.apply({ type: "append", row: i, time: "00:00:00", speaker: "S", text: `line ${i}` });
  assert.equal(t.size(), MAX_DISPLAY_ROWS);
  assert.equal(t.dropped, 5_000);
  assert.equal(t.slice(0, 1)[0].text, "line 5000");
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) t.apply({ type: "replace", row: n - 1, text: `grown ${i}` });
  assert.ok(performance.now() - started < 300, "20k replaces are fast");
  assert.equal(t.tail(1)[0].text, "grown 19999");
});

test("transcript: subscribers are notified once per microtask batch", async () => {
  const t = new LiveTranscript();
  let calls = 0;
  t.subscribe(() => calls++);
  for (let i = 0; i < 50; i++) t.apply({ type: "append", row: i, time: "", speaker: "A", text: "x" });
  await Promise.resolve();
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test --experimental-strip-types ../ui/screens/live/tests/live-model.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the bridge**

`desktop/src/live/captureBridge.ts`:

```ts
// Tauri side of the Live capture event stream. Kept in `desktop/` because `@tauri-apps/api` is not resolvable from
// `ui/screens`; the screen loads this module lazily (same pattern as src/editor/explorerBridge.ts). The payload is
// decoded by ui/screens/live/host.ts, never trusted here.
import { Channel } from "@tauri-apps/api/core";

export function createCaptureChannel(onEvent: (raw: unknown) => void): Channel<unknown> {
  const ch = new Channel<unknown>();
  ch.onmessage = (m) => onEvent(m);
  return ch;
}
```

- [ ] **Step 4: Implement `host.ts`**

```ts
// Typed wrappers over the capture_* host commands (desktop/src-tauri/src/capture_host.rs) with strict decoders:
// everything from the host is checked and capped before the screen sees it. Caption text stays plain text.
import { invokeHost } from "../shell/host";

export type CaptureStateName = "recording" | "no_source" | "permission_lost" | "full" | "stopped" | "error";
export type CaptureEvent =
  | { type: "state"; state: CaptureStateName; platform: string | null; detail: string | null }
  | { type: "append"; row: number; time: string; speaker: string; text: string }
  | { type: "replace"; row: number; text: string }
  | { type: "closed"; row: number };

export interface CaptureStatus { supported: boolean; trusted: boolean; recording: boolean; sessionId: string | null; startedAtMs: number | null; notesRoot: boolean; macAppRunning: boolean; devBuild: boolean }
export interface IndexUpsert { noteKey: string; kind: "meeting"; title: string; date: string; durationSec: number; participants: string[]; body: string; contentHash: string; mtimeMs: number; meta: { meetingId: string; platform: string; language: string } }
export interface FinalizedNote { rel: string; hash: string; lines: number; mtimeMs: number; index: IndexUpsert | null }
export interface StopResult { note: FinalizedNote | null; keptPartial: boolean; reason: string | null }
export interface PartialSummary { id: string; startedAtMs: number; rows: number }

const STATES: readonly CaptureStateName[] = ["recording", "no_source", "permission_lost", "full", "stopped", "error"];
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max: number): string | null => (typeof v === "string" ? (v.length > max ? v.slice(0, max) : v) : null);
const nat = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const bool = (v: unknown): boolean => v === true;

export function decodeEvent(v: unknown): CaptureEvent | null {
  const r = obj(v);
  if (!r) return null;
  switch (r.type) {
    case "append": {
      const row = nat(r.row), time = str(r.time, 8), speaker = str(r.speaker, 80), text = str(r.text, 2000);
      return row === null || time === null || speaker === null || text === null ? null : { type: "append", row, time, speaker, text };
    }
    case "replace": {
      const row = nat(r.row), text = str(r.text, 2000);
      return row === null || text === null ? null : { type: "replace", row, text };
    }
    case "closed": {
      const row = nat(r.row);
      return row === null ? null : { type: "closed", row };
    }
    case "state": {
      const state = STATES.find((s) => s === r.state);
      return state ? { type: "state", state, platform: str(r.platform, 20), detail: str(r.detail, 300) } : null;
    }
    default:
      return null;
  }
}

export function decodeStatus(v: unknown): CaptureStatus {
  const r = obj(v) ?? {};
  return {
    supported: bool(r.supported), trusted: bool(r.trusted), recording: bool(r.recording),
    sessionId: str(r.sessionId, 40), startedAtMs: nat(r.startedAtMs), notesRoot: bool(r.notesRoot),
    macAppRunning: bool(r.macAppRunning), devBuild: bool(r.devBuild),
  };
}

function decodeIndex(v: unknown): IndexUpsert | null {
  const r = obj(v);
  const m = obj(r?.meta);
  if (!r || !m || r.kind !== "meeting") return null;
  const noteKey = str(r.noteKey, 1024), title = str(r.title, 500), date = str(r.date, 64), body = str(r.body, 600_000), contentHash = str(r.contentHash, 128);
  const durationSec = nat(r.durationSec), mtimeMs = nat(r.mtimeMs);
  if (noteKey === null || title === null || date === null || body === null || contentHash === null || durationSec === null || mtimeMs === null || !Array.isArray(r.participants)) return null;
  return {
    noteKey, kind: "meeting", title, date, durationSec, body, contentHash, mtimeMs,
    participants: r.participants.filter((p): p is string => typeof p === "string").slice(0, 200).map((p) => p.slice(0, 200)),
    meta: { meetingId: str(m.meetingId, 64) ?? "", platform: str(m.platform, 20) ?? "", language: str(m.language, 35) ?? "" },
  };
}

function decodeNote(v: unknown): FinalizedNote | null {
  const r = obj(v);
  if (!r) return null;
  const rel = str(r.rel, 1024), hash = str(r.hash, 128), lines = nat(r.lines), mtimeMs = nat(r.mtimeMs);
  if (rel === null || hash === null || lines === null || mtimeMs === null) return null;
  return { rel, hash, lines, mtimeMs, index: decodeIndex(r.index) };
}

export function decodeStop(v: unknown): StopResult {
  const r = obj(v) ?? {};
  return { note: decodeNote(r.note), keptPartial: bool(r.keptPartial), reason: str(r.reason, 300) };
}

export function decodePartials(v: unknown): PartialSummary[] {
  if (!Array.isArray(v)) return [];
  const out: PartialSummary[] = [];
  for (const x of v.slice(0, 50)) {
    const r = obj(x);
    const id = str(r?.id, 40), startedAtMs = nat(r?.startedAtMs), rows = nat(r?.rows);
    if (id !== null && startedAtMs !== null && rows !== null) out.push({ id, startedAtMs, rows });
  }
  return out;
}

const ERROR_TEXT: Record<string, string> = {
  unsupported: "Live caption capture works on macOS in this version. For browser meetings, use the Chrome extension.",
  not_trusted: "LLM-IDE is not allowed to use Accessibility yet. Allow it, then press Check again.",
  no_notes_root: "Choose a notes folder in Library first. The meeting note is saved there.",
  already_recording: "A capture is already running.",
  not_recording: "No capture is running.",
  invalid_language: "The language setting is not valid.",
  invalid_id: "That unfinished capture cannot be opened.",
  not_found: "That unfinished capture is gone.",
  trash_unavailable: "It could not be moved to the Trash, so nothing was deleted.",
  empty: "Nothing was captured, so no note was saved.",
  verify_failed: "The note could not be verified after writing. The capture is kept and you can try again.",
  exists: "A note with this name already exists.",
  too_large: "The meeting is too large for one note. The capture is kept.",
  no_root: "The notes folder is not available. The capture is kept.",
};

export function captureErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const code = raw.split(":")[0]!.trim();
  return ERROR_TEXT[code] ?? "Something went wrong with the capture. What was captured is kept.";
}

export interface CaptureHost {
  status(): Promise<CaptureStatus>;
  requestPermission(): Promise<boolean>;
  openSettings(): Promise<void>;
  start(language: string, onEvent: (ev: CaptureEvent) => void): Promise<{ sessionId: string; startedAtMs: number }>;
  stop(title: string): Promise<StopResult>;
  recoverList(): Promise<PartialSummary[]>;
  recoverFinish(id: string, title: string): Promise<StopResult>;
  recoverDiscard(id: string): Promise<void>;
}

type ChannelFactory = (onRaw: (raw: unknown) => void) => unknown | Promise<unknown>;
const defaultChannel: ChannelFactory = (cb) => import("../../../desktop/src/live/captureBridge").then((m) => m.createCaptureChannel(cb));

export function createCaptureHost(channelFactory: ChannelFactory = defaultChannel): CaptureHost {
  return {
    status: async () => decodeStatus(await invokeHost<unknown>("capture_status")),
    requestPermission: async () => (await invokeHost<unknown>("capture_request_permission")) === true,
    openSettings: async () => { await invokeHost("capture_open_settings"); },
    start: async (language, onEvent) => {
      const onEventChannel = await channelFactory((raw) => { const ev = decodeEvent(raw); if (ev) onEvent(ev); });
      const r = obj(await invokeHost<unknown>("capture_start", { language, onEvent: onEventChannel })) ?? {};
      return { sessionId: str(r.sessionId, 40) ?? "", startedAtMs: nat(r.startedAtMs) ?? Date.now() };
    },
    stop: async (title) => decodeStop(await invokeHost<unknown>("capture_stop", { title })),
    recoverList: async () => decodePartials(await invokeHost<unknown>("capture_recover_list")),
    recoverFinish: async (id, title) => decodeStop(await invokeHost<unknown>("capture_recover_finish", { id, title })),
    recoverDiscard: async (id) => { await invokeHost("capture_recover_discard", { id }); },
  };
}
```

- [ ] **Step 5: Implement `transcript.ts`**

```ts
// The live transcript as the screen shows it: a mutable, bounded store outside React (useSyncExternalStore reads
// `version`). Replace is O(1) by row id; at MAX_DISPLAY_ROWS the oldest rows leave the VIEW (the host keeps every
// row for the note). Subscribers are notified once per microtask, so a burst of events renders once.
import type { CaptureEvent } from "./host.ts";

export const MAX_DISPLAY_ROWS = 20_000;
export const PAGE_ROWS = 200;

export interface LiveRow { row: number; time: string; speaker: string; text: string }

export class LiveTranscript {
  private byRow = new Map<number, LiveRow>();
  private order: number[] = [];
  private head = 0;
  private listeners = new Set<() => void>();
  private scheduled = false;
  dropped = 0;
  version = 0;

  apply(ev: CaptureEvent): void {
    if (ev.type === "append") this.add({ row: ev.row, time: ev.time, speaker: ev.speaker, text: ev.text });
    else if (ev.type === "replace") {
      const r = this.byRow.get(ev.row);
      if (r) r.text = ev.text;
      else this.add({ row: ev.row, time: "", speaker: "", text: ev.text });
    } else return;
    this.version++;
    this.notify();
  }

  private add(r: LiveRow): void {
    this.byRow.set(r.row, r);
    this.order.push(r.row);
    if (this.size() > MAX_DISPLAY_ROWS) {
      this.byRow.delete(this.order[this.head]!);
      this.head++;
      this.dropped++;
      if (this.head > 10_000) {
        this.order = this.order.slice(this.head);
        this.head = 0;
      }
    }
  }

  size(): number {
    return this.order.length - this.head;
  }

  slice(start: number, count: number): LiveRow[] {
    const from = this.head + Math.max(0, start);
    return this.order.slice(from, Math.min(this.order.length, from + count)).map((id) => this.byRow.get(id)!);
  }

  tail(count: number): LiveRow[] {
    return this.slice(Math.max(0, this.size() - count), count);
  }

  clear(): void {
    this.byRow.clear();
    this.order = [];
    this.head = 0;
    this.dropped = 0;
    this.version++;
    this.notify();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const l of [...this.listeners]) l();
    });
  }
}
```

- [ ] **Step 6: Add the tests to `npm test` and run**

In `desktop/package.json` `scripts.test`, append ` ../ui/screens/live/tests/*.test.*` to the end of the list.
Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test --experimental-strip-types ../ui/screens/live/tests/live-model.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add desktop/src/live/captureBridge.ts ui/screens/live/host.ts ui/screens/live/transcript.ts ui/screens/live/tests/live-model.test.ts desktop/package.json
git commit -m "feat(ui): typed live capture host wrapper and bounded transcript store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The Live screen and its section registration

**Files:**
- Create: `ui/screens/live/PermissionCard.tsx`, `ui/screens/live/TranscriptList.tsx`, `ui/screens/live/LiveScreen.tsx`, `ui/screens/live/index.tsx`, `ui/screens/live/live.css`
- Create: `ui/screens/live/tests/components.test.mjs`
- Modify: `ui/screens/shell/sections.ts` (`SectionId` union: add `"live"`; `SECTIONS`: `{ id: "live", label: "Live", enabled: true }` right after the `library` entry)
- Modify: `ui/screens/shell/screens.tsx` (`loaders`: add `live: () => import("../live/index.tsx"),` to the always-compiled block; Live has no `LLMIDE_FEATURES` key)
- Modify: `ui/screens/shell/toolbar-model.ts` (`TOOLBAR_IDS`: append `"live"`; `MAC_CASE_TO_ID.live`: `"live"`; rewrite the doc comment at lines 6-10 to say that Live is listed and mirrors `ShellSection.toolbarOrder` exactly)
- Modify: `ui/screens/shell/tests/toolbar.test.mjs:34` (test title: drop "(Live aside: no desktop live capture)")

**Interfaces:**
- Consumes: `CaptureHost`, `CaptureStatus`, `CaptureEvent`, `StopResult`, `captureErrorText` (Task 9), `LiveTranscript`, `PAGE_ROWS` (Task 9), `SectionProps` and `shellBus` from `@llmide/screens/shell`, `setLiveRecording` (Task 11; until Task 11 lands, `LiveScreen` takes it as the optional prop `onRecordingChange`).
- Produces: `export function LiveScreen(props: { active: boolean; deps: LiveDeps })`, `export interface LiveDeps { capture: CaptureHost; language(): string; openLibrary(): void; onRecordingChange?(r: { sessionId: string; startedAtMs: number; platform: string | null } | null): void; indexNote?(note: FinalizedNote): Promise<"indexed" | "skipped" | "failed"> }`, `export function PermissionCard(props)`, `export function TranscriptList(props: { transcript: LiveTranscript })`.

The words on the screen are part of the privacy design. They say what is read (caption text from Zoom and Teams windows), what is never read (audio), and when reading starts (only after Start).

- [ ] **Step 1: Write the failing component test**

`ui/screens/live/tests/components.test.mjs` (esbuild bundle, the same approach as `ui/screens/gantt/tests/gantt-body.test.mjs`):

```js
// Live screen components rendered on the server: permission states, privacy copy, text-only captions, windowing.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = resolve(HERE, "..");
const DESKTOP = resolve(LIVE, "../../../desktop");
const req = createRequire(join(DESKTOP, "package.json"));
const { createElement: h } = req("react");
const { renderToStaticMarkup: html } = req("react-dom/server");

let M;
before(async () => {
  const { build } = req("esbuild");
  const outfile = join(bundleDir("live"), "components.mjs");
  await build({ stdin: { contents: `export * from "./PermissionCard.tsx"; export * from "./TranscriptList.tsx"; export * from "./LiveScreen.tsx"; export * from "./transcript.ts";`, resolveDir: LIVE, loader: "ts" }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent" });
  M = await import(pathToFileURL(outfile).href);
});

const status = (o = {}) => ({ supported: true, trusted: false, recording: false, sessionId: null, startedAtMs: null, notesRoot: true, macAppRunning: false, devBuild: false, ...o });
const noop = () => {};

test("permission card: explains what is read, offers the three actions, mentions the terminal in a dev build", () => {
  const out = html(h(M.PermissionCard, { status: status({ devBuild: true }), asked: false, onRequest: noop, onOpenSettings: noop, onCheck: noop }));
  assert.match(out, /caption text/i);
  assert.match(out, /never records audio/i);
  assert.match(out, /Allow Accessibility/);
  assert.match(out, /Open System Settings/);
  assert.match(out, /Check again/);
  assert.match(out, /Terminal/);
});

test("permission card after a request: tells the user where to switch it on", () => {
  const out = html(h(M.PermissionCard, { status: status(), asked: true, onRequest: noop, onOpenSettings: noop, onCheck: noop }));
  assert.match(out, /Privacy &amp; Security/);
  assert.match(out, /relaunch/i);
});

test("transcript renders captions as text only, never markup", () => {
  const t = new M.LiveTranscript();
  t.apply({ type: "append", row: 0, time: "09:30:01", speaker: "<b>Eve</b>", text: "<img src=x onerror=alert(1)> **bold**" });
  const out = html(h(M.TranscriptList, { transcript: t }));
  assert.equal(out.includes("<img"), false);
  assert.equal(out.includes("<b>Eve"), false);
  assert.match(out, /&lt;img src=x/);
  assert.match(out, /\*\*bold\*\*/);
});

test("transcript windows a 20k-row meeting to one page", () => {
  const t = new M.LiveTranscript();
  for (let i = 0; i < 20_000; i++) t.apply({ type: "append", row: i, time: "00:00:00", speaker: "S", text: `line ${i}` });
  const out = html(h(M.TranscriptList, { transcript: t }));
  assert.equal((out.match(/class="lv-row"/g) ?? []).length, M.PAGE_ROWS);
  assert.match(out, /line 19999/);
  assert.match(out, /Show earlier/);
});

test("screen on a non-macOS host says where capture works", () => {
  const deps = { capture: { status: async () => status({ supported: false }) }, language: () => "en", openLibrary: noop };
  const out = html(h(M.LiveScreen, { active: true, deps, initialStatus: status({ supported: false }) }));
  assert.match(out, /macOS/);
  assert.match(out, /Chrome extension/);
});

test("screen idle and trusted: Start button and the hint to turn captions on", () => {
  const deps = { capture: {}, language: () => "en", openLibrary: noop };
  const out = html(h(M.LiveScreen, { active: true, deps, initialStatus: status({ trusted: true }) }));
  assert.match(out, /Start capture/);
  assert.match(out, /Turn on captions in Zoom or Teams/);
});

test("screen warns when the Mac app also runs", () => {
  const deps = { capture: {}, language: () => "en", openLibrary: noop };
  const out = html(h(M.LiveScreen, { active: true, deps, initialStatus: status({ trusted: true, macAppRunning: true }) }));
  assert.match(out, /Mac app is also running/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test ../ui/screens/live/tests/components.test.mjs`
Expected: FAIL (esbuild cannot resolve the `.tsx` files).

- [ ] **Step 3: Implement `PermissionCard.tsx`**

```tsx
// Accessibility permission card (the Mac PermissionsView's Accessibility row). The OS prompt fires only from
// "Allow Accessibility"; "Check again" re-reads the state without prompting.
import type { CaptureStatus } from "./host.ts";

export function PermissionCard({ status, asked, onRequest, onOpenSettings, onCheck }: {
  status: CaptureStatus; asked: boolean; onRequest(): void; onOpenSettings(): void; onCheck(): void;
}) {
  return (
    <section className="sh-panel lv-card" aria-labelledby="lv-perm-title">
      <h2 id="lv-perm-title" className="sh-panel-title">Allow Accessibility to capture captions</h2>
      <p className="sh-panel-text">
        LLM-IDE reads the caption text that Zoom or Teams shows on screen, and only after you press Start capture.
        It never records audio or video and never takes screenshots.
      </p>
      {asked && (
        <p className="sh-panel-text" role="status">
          In System Settings → Privacy &amp; Security → Accessibility, turn on LLM-IDE, then press Check again. If it is
          already on and this still shows, turn it off and on again, or relaunch LLM-IDE.
        </p>
      )}
      {status.devBuild && (
        <p className="sh-panel-text sh-muted">
          Development build: when LLM-IDE was started from Terminal or an editor, macOS asks for the permission on behalf of
          Terminal (or that editor), not LLM-IDE.
        </p>
      )}
      <div className="lv-actions">
        <button type="button" className="sh-button" onClick={onRequest}>Allow Accessibility…</button>
        <button type="button" className="sh-button" onClick={onOpenSettings}>Open System Settings</button>
        <button type="button" className="sh-button" onClick={onCheck}>Check again</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Implement `TranscriptList.tsx`**

```tsx
// Live transcript: the last PAGE_ROWS rows by default, "Show earlier" pages back. Captions are untrusted text and
// are rendered only as React text nodes (no Markdown, no HTML).
import { useState, useSyncExternalStore } from "react";
import { PAGE_ROWS, type LiveTranscript } from "./transcript.ts";

export function TranscriptList({ transcript }: { transcript: LiveTranscript }) {
  useSyncExternalStore((l) => transcript.subscribe(l), () => transcript.version, () => transcript.version);
  const [pages, setPages] = useState(1);
  const size = transcript.size();
  const count = Math.min(size, pages * PAGE_ROWS);
  const rows = transcript.tail(count);
  const hidden = size - count + transcript.dropped;
  return (
    <div className="lv-transcript" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Live transcript">
      {hidden > 0 && (
        <button type="button" className="sh-button lv-earlier" onClick={() => setPages((p) => p + 1)} disabled={size - count <= 0}>
          {size - count > 0 ? `Show earlier (${size - count} more)` : `${transcript.dropped} earliest lines are only in the saved note`}
        </button>
      )}
      {rows.map((r) => (
        <p key={r.row} className="lv-row">
          <span className="lv-time">{r.time}</span> <strong className="lv-speaker">{r.speaker}</strong> <span className="lv-text">{r.text}</span>
        </p>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Implement `LiveScreen.tsx`**

```tsx
// Live section: permission, Start/Stop with a title, the recording bar, the live transcript, then the saved result.
// Capture runs in the Rust host; this screen only displays its events. It never starts capture by itself.
import { useCallback, useEffect, useRef, useState } from "react";
import { captureErrorText, type CaptureEvent, type CaptureHost, type CaptureStatus, type FinalizedNote, type StopResult } from "./host.ts";
import { LiveTranscript } from "./transcript.ts";
import { PermissionCard } from "./PermissionCard.tsx";
import { TranscriptList } from "./TranscriptList.tsx";
import { RecoveryList } from "./RecoveryList.tsx";

export interface LiveRecording { sessionId: string; startedAtMs: number; platform: string | null }
export interface LiveDeps {
  capture: CaptureHost;
  language(): string;
  openLibrary(): void;
  onRecordingChange?(r: LiveRecording | null): void;
  indexNote?(note: FinalizedNote): Promise<"indexed" | "skipped" | "failed">;
}

type Phase = "idle" | "starting" | "recording" | "stopping" | "done";
const PLATFORM_LABEL: Record<string, string> = { zoom: "Zoom", teams: "Teams" };

function elapsed(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function LiveScreen({ active, deps, initialStatus }: { active: boolean; deps: LiveDeps; initialStatus?: CaptureStatus }) {
  const [status, setStatus] = useState<CaptureStatus | null>(initialStatus ?? null);
  const [asked, setAsked] = useState(false);
  const [phase, setPhase] = useState<Phase>(initialStatus?.recording ? "recording" : "idle");
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState<string | null>(null);
  const [notice, setNotice] = useState<CaptureEvent & { type: "state" } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(initialStatus?.startedAtMs ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<StopResult | null>(null);
  const [indexState, setIndexState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcript = useRef(new LiveTranscript()).current;

  const refresh = useCallback(async () => {
    try { setStatus(await deps.capture.status()); } catch (e) { setError(captureErrorText(e)); }
  }, [deps]);

  useEffect(() => { if (active && !initialStatus) void refresh(); }, [active, refresh, initialStatus]);

  // Re-check the permission once a second while the card is visible (no system "permission changed" event).
  const needsPermission = !!status && status.supported && !status.trusted && phase === "idle";
  useEffect(() => {
    if (!active || !needsPermission) return;
    const id = setInterval(() => void refresh(), 1000);
    return () => clearInterval(id);
  }, [active, needsPermission, refresh]);

  useEffect(() => {
    if (!active || phase !== "recording") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, phase]);

  const onEvent = useCallback((ev: CaptureEvent) => {
    if (ev.type !== "state") { transcript.apply(ev); return; }
    if (ev.state === "recording") { setPlatform(ev.platform); setNotice(null); }
    else if (ev.state !== "stopped") setNotice(ev);
  }, [transcript]);

  const start = useCallback(async () => {
    setError(null); setResult(null); setIndexState(null); setNotice(null); setPlatform(null);
    transcript.clear();
    setPhase("starting");
    try {
      const s = await deps.capture.start(deps.language(), onEvent);
      setStartedAt(s.startedAtMs); setNow(Date.now()); setPhase("recording");
      deps.onRecordingChange?.({ sessionId: s.sessionId, startedAtMs: s.startedAtMs, platform: null });
    } catch (e) {
      setError(captureErrorText(e)); setPhase("idle"); void refresh();
    }
  }, [deps, onEvent, refresh, transcript]);

  const stop = useCallback(async () => {
    setPhase("stopping");
    try {
      const r = await deps.capture.stop(title);
      setResult(r); setPhase("done");
      if (r.note && deps.indexNote) setIndexState(await deps.indexNote(r.note));
    } catch (e) {
      setError(captureErrorText(e)); setPhase("done");
    } finally {
      deps.onRecordingChange?.(null);
    }
  }, [deps, title]);

  if (!status) return <div className="sh-panel" role="status"><p className="sh-panel-text">Checking capture…</p></div>;
  if (!status.supported) {
    return (
      <section className="sh-panel lv-card">
        <h2 className="sh-panel-title">Live captions</h2>
        <p className="sh-panel-text">Live caption capture from Zoom and Teams desktop works on macOS in this version. Windows and Linux come later.</p>
        <p className="sh-panel-text">For Google Meet, Teams or Zoom in a browser, use the Chrome extension.</p>
      </section>
    );
  }
  if (!status.notesRoot && phase === "idle") {
    return (
      <section className="sh-panel lv-card">
        <h2 className="sh-panel-title">Choose a notes folder first</h2>
        <p className="sh-panel-text">The meeting note is saved in your notes folder. Choose it in Library, then come back.</p>
        <button type="button" className="sh-button" onClick={deps.openLibrary}>Open Library</button>
      </section>
    );
  }
  const recording = phase === "recording" || phase === "stopping";
  return (
    <div className="lv-screen">
      {needsPermission && (
        <PermissionCard status={status} asked={asked} onCheck={() => void refresh()}
          onRequest={async () => { setAsked(true); try { await deps.capture.requestPermission(); } finally { void refresh(); } }}
          onOpenSettings={() => { setAsked(true); void deps.capture.openSettings().catch((e) => setError(captureErrorText(e))); }} />
      )}
      {status.macAppRunning && !recording && (
        <p className="sh-notice" role="status">The Mac app is also running. Capture each meeting in one app only, or you get two notes.</p>
      )}
      {!recording && status.trusted && (
        <section className="sh-panel lv-card" aria-labelledby="lv-start-title">
          <h2 id="lv-start-title" className="sh-panel-title">Capture meeting captions</h2>
          <p className="sh-panel-text">Turn on captions in Zoom or Teams (desktop) first. LLM-IDE reads only the caption text, never audio.</p>
          <label className="lv-title-field">Meeting title
            <input type="text" maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled meeting" />
          </label>
          <button type="button" className="sh-button" onClick={() => void start()} disabled={phase === "starting"}>
            {phase === "starting" ? "Starting…" : "Start capture"}
          </button>
        </section>
      )}
      {recording && (
        <div className="lv-recording" role="status" aria-live="polite">
          <span className="lv-dot" aria-hidden="true">●</span>
          <span>Recording captions{platform ? ` from ${PLATFORM_LABEL[platform] ?? platform}` : ""} · {startedAt ? elapsed(startedAt, now) : "00:00:00"} · {transcript.size()} lines</span>
          <span className="sh-muted">Caption text only, never audio.</span>
          <button type="button" className="sh-button" onClick={() => void stop()} disabled={phase === "stopping"}>
            {phase === "stopping" ? "Saving…" : "Stop and save"}
          </button>
        </div>
      )}
      {notice?.state === "no_source" && <p className="sh-notice" role="status">No captions found yet. Turn on captions in Zoom or Teams, and keep the captions panel open.</p>}
      {notice?.state === "permission_lost" && <p className="sh-notice" role="alert">Accessibility was turned off, so capture paused. What was captured is kept. Press Stop and save.</p>}
      {notice?.state === "full" && <p className="sh-notice" role="alert">This capture reached its size limit and paused. Press Stop and save, then start a new capture.</p>}
      {error && <p className="sh-notice" role="alert">{error}</p>}
      {phase === "done" && result && (
        <section className="sh-panel lv-card" role="status">
          {result.note ? (
            <>
              <p className="sh-panel-text">Saved to Library: {result.note.rel} ({result.note.lines} lines).{indexState === "failed" ? " Search will find it after the next Library index rebuild." : ""}</p>
              <p className="sh-panel-text sh-muted">To summarise it, open it in Library and press Re-summarise. Nothing is sent to a model until you do.</p>
              <button type="button" className="sh-button" onClick={deps.openLibrary}>Open in Library</button>
            </>
          ) : (
            <p className="sh-panel-text">{captureErrorText(result.reason ?? "empty")}</p>
          )}
        </section>
      )}
      {(recording || transcript.size() > 0) && <TranscriptList transcript={transcript} />}
      {phase === "idle" && <RecoveryList capture={deps.capture} active={active} />}
    </div>
  );
}
```

Until Task 12 lands, create `ui/screens/live/RecoveryList.tsx` with `export function RecoveryList(_: { capture: unknown; active: boolean }) { return null; }` so this task builds on its own.

- [ ] **Step 6: Implement `index.tsx` and `live.css`**

`ui/screens/live/index.tsx`:

```tsx
// Live section entry: the shell lazy-loads this module (default export, SectionProps).
import "@llmide/ui-kit/styles.css";
import "./live.css";
import { useMemo } from "react";
import { core as shellCore, shellBus, type SectionProps } from "@llmide/screens/shell";
import { createCaptureHost } from "./host.ts";
import { LiveScreen, type LiveDeps } from "./LiveScreen.tsx";
import { setLiveRecording } from "../shell/live-status";

export default function Live({ active }: SectionProps) {
  const deps = useMemo<LiveDeps>(() => ({
    capture: createCaptureHost(),
    language: () => (globalThis.navigator?.language ?? "en").split("-")[0]!.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 35) || "en",
    openLibrary: () => shellBus.publish({ type: "goto-section", section: "library" }),
    onRecordingChange: setLiveRecording,
    indexNote: async (note) => {
      if (!note.index) return "skipped";
      try {
        const r = await shellCore.requestRaw("/kb/index/notes", { method: "POST", body: { notes: [note.index] } });
        return r.status >= 200 && r.status < 300 ? "indexed" : "failed";
      } catch {
        return "failed";
      }
    },
  }), []);
  return <LiveScreen active={active} deps={deps} />;
}
```

(The `setLiveRecording` import is added in Task 11. If Task 10 is reviewed first, temporarily leave out `onRecordingChange` and the import, and Task 11 adds both.)

Check `shellCore.requestRaw`'s body option: `ui/screens/library/core-adapter.ts` `viaClient` shows how Library sends a JSON body. Use the same option name it uses (`body`).

`ui/screens/live/live.css`:

```css
.lv-screen { display: flex; flex-direction: column; gap: 12px; padding: 16px; min-width: 0; }
.lv-card { max-width: 720px; }
.lv-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.lv-title-field { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; max-width: 420px; }
.lv-recording { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid currentColor; border-radius: 6px; }
.lv-dot { color: #d33; }
.lv-transcript { overflow-y: auto; max-height: 60vh; min-width: 0; }
.lv-row { margin: 2px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.lv-time { opacity: 0.6; font-variant-numeric: tabular-nums; }
.lv-earlier { margin-bottom: 8px; }
```

- [ ] **Step 7: Register the section**

Make the four shell edits listed under **Files**. In `sections.ts`, the new line is:

```ts
  { id: "live", label: "Live", enabled: true },
```

and the `SectionId` union gains `| "live"`.

- [ ] **Step 8: Run tests**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test ../ui/screens/live/tests/components.test.mjs && node --test --experimental-strip-types ../ui/screens/shell/tests/toolbar.test.mjs ../ui/screens/shell/tests/state.test.mjs`
Expected: PASS. The toolbar drift test now maps every Mac toolbar item, Live included, and the label test checks "Live" against `ShellSection.swift`.

- [ ] **Step 9: Commit**

```bash
git add ui/screens/live ui/screens/shell/sections.ts ui/screens/shell/screens.tsx ui/screens/shell/toolbar-model.ts ui/screens/shell/tests/toolbar.test.mjs
git commit -m "feat(ui): Live section with permission flow, Start/Stop and live transcript

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: App-wide recording banner

**Files:**
- Create: `ui/screens/shell/live-status.ts`
- Create: `ui/screens/shell/LiveBanner.tsx`
- Create: `ui/screens/shell/tests/live-status.test.mjs`
- Modify: `ui/screens/shell/Shell.tsx` (render `<LiveBanner …/>` as the first child of `<main>`, line 261, above `CrashReportBanner`; on mount call `syncLiveRecordingFromHost()` when `isHostAvailable()`)
- Modify: `ui/screens/live/index.tsx` (wire `onRecordingChange: setLiveRecording`, if Task 10 left it out)

**Interfaces:**
- Produces: `export interface LiveRecording { sessionId: string; startedAtMs: number; platform: string | null }`, `setLiveRecording(r: LiveRecording | null): void`, `getLiveRecording(): LiveRecording | null`, `subscribeLiveRecording(l: () => void): () => void`, `syncLiveRecordingFromHost(invoke?: (cmd: string) => Promise<unknown>): Promise<void>`, `LiveBanner({ activeSection, onOpen })`.

The host keeps capturing when the webview reloads, so on boot the shell asks the host directly (`capture_status`) whether a capture is running. The banner can then never be missing while capture runs.

- [ ] **Step 1: Write the failing test**

```js
// The recording banner: shown in every section except Live while a capture runs, restored from the host after reload.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, "..");
const req = createRequire(join(resolve(SHELL, "../../../desktop"), "package.json"));
const { createElement: h } = req("react");
const { renderToStaticMarkup: html } = req("react-dom/server");

let M;
before(async () => {
  const { build } = req("esbuild");
  const outfile = join(bundleDir("shell-live"), "banner.mjs");
  await build({ stdin: { contents: `export * from "./LiveBanner.tsx"; export * from "./live-status.ts";`, resolveDir: SHELL, loader: "ts" }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent" });
  M = await import(pathToFileURL(outfile).href);
});

test("store: set, subscribe, clear", () => {
  let n = 0;
  const off = M.subscribeLiveRecording(() => n++);
  M.setLiveRecording({ sessionId: "m-a-b", startedAtMs: 1, platform: "zoom" });
  M.setLiveRecording(null);
  off();
  assert.equal(n, 2);
  assert.equal(M.getLiveRecording(), null);
});

test("sync from the host restores a running capture after a reload", async () => {
  await M.syncLiveRecordingFromHost(async () => ({ recording: true, sessionId: "m-a-b", startedAtMs: 42 }));
  assert.deepEqual(M.getLiveRecording(), { sessionId: "m-a-b", startedAtMs: 42, platform: null });
  await M.syncLiveRecordingFromHost(async () => { throw new Error("no host"); });
  assert.notEqual(M.getLiveRecording(), null, "a failed check never hides the banner");
  M.setLiveRecording(null);
});

test("banner: a status with the privacy sentence and an Open Live button; hidden inside Live and when idle", () => {
  M.setLiveRecording({ sessionId: "m-a-b", startedAtMs: Date.now(), platform: "teams" });
  const out = html(h(M.LiveBanner, { activeSection: "library", onOpen: () => {} }));
  assert.match(out, /role="status"/);
  assert.match(out, /Recording meeting captions/);
  assert.match(out, /never audio/);
  assert.match(out, /Open Live/);
  assert.equal(html(h(M.LiveBanner, { activeSection: "live", onOpen: () => {} })), "");
  M.setLiveRecording(null);
  assert.equal(html(h(M.LiveBanner, { activeSection: "library", onOpen: () => {} })), "");
});

test("Shell renders the banner and syncs it from the host", () => {
  const src = readFileSync(join(SHELL, "Shell.tsx"), "utf8");
  assert.match(src, /<LiveBanner activeSection=\{nav\.active\}/);
  assert.match(src, /syncLiveRecordingFromHost\(\)/);
});
```

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test ../ui/screens/shell/tests/live-status.test.mjs` and expect a FAIL.

- [ ] **Step 2: Implement `live-status.ts`**

```ts
// Whether a live capture is running, for the app-wide banner. Set by the Live screen; restored from the host on boot
// (capture keeps running in the Rust host across a webview reload).
import { invokeHost } from "./host";

export interface LiveRecording { sessionId: string; startedAtMs: number; platform: string | null }

let current: LiveRecording | null = null;
const listeners = new Set<() => void>();

export function getLiveRecording(): LiveRecording | null {
  return current;
}

export function setLiveRecording(r: LiveRecording | null): void {
  current = r;
  for (const l of [...listeners]) l();
}

export function subscribeLiveRecording(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export async function syncLiveRecordingFromHost(invoke: (cmd: string) => Promise<unknown> = (c) => invokeHost<unknown>(c)): Promise<void> {
  let s: unknown;
  try {
    s = await invoke("capture_status");
  } catch {
    return; // keep whatever is shown; never hide the banner on a failed check
  }
  const r = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
  if (r.recording === true && typeof r.sessionId === "string") {
    setLiveRecording({ sessionId: r.sessionId.slice(0, 40), startedAtMs: typeof r.startedAtMs === "number" ? r.startedAtMs : Date.now(), platform: null });
  } else if (r.recording === false) setLiveRecording(null);
}
```

- [ ] **Step 3: Implement `LiveBanner.tsx`**

```tsx
// App-wide "recording" banner (privacy: capture is never invisible). Hidden only inside the Live section, which
// shows its own recording bar.
import { useSyncExternalStore } from "react";
import { getLiveRecording, subscribeLiveRecording } from "./live-status";

export function LiveBanner({ activeSection, onOpen }: { activeSection: string; onOpen(): void }) {
  const r = useSyncExternalStore(subscribeLiveRecording, getLiveRecording, getLiveRecording);
  if (!r || activeSection === "live") return null;
  const since = new Date(r.startedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="sh-notice" role="status" data-testid="live-banner">
      <p><span aria-hidden="true" style={{ color: "#d33" }}>● </span>Recording meeting captions since {since}. Caption text only, never audio.</p>
      <button type="button" className="sh-button" onClick={onOpen}>Open Live</button>
    </div>
  );
}
```

- [ ] **Step 4: Wire into `Shell.tsx`**

Add the imports `import { LiveBanner } from "./LiveBanner";` and `import { syncLiveRecordingFromHost } from "./live-status";`. Add `isHostAvailable` to the existing `./host` import. In the component body, next to the other mount effects, add:

```tsx
  useEffect(() => { if (isHostAvailable()) void syncLiveRecordingFromHost(); }, []);
```

As the first line inside `<main …>` (before `{crash && <CrashReportBanner …/>}`), add:

```tsx
          <LiveBanner activeSection={nav.active} onOpen={() => dispatch({ type: "select", id: "live" })} />
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test ../ui/screens/shell/tests/live-status.test.mjs && npm test`
Expected: PASS, and the full desktop suite stays green.

- [ ] **Step 6: Commit**

```bash
git add ui/screens/shell/live-status.ts ui/screens/shell/LiveBanner.tsx ui/screens/shell/tests/live-status.test.mjs ui/screens/shell/Shell.tsx ui/screens/live/index.tsx
git commit -m "feat(ui): app-wide recording banner while live capture runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Recovery of unfinished captures

**Files:**
- Modify: `ui/screens/live/RecoveryList.tsx` (replace the Task 10 stub)
- Create: `ui/screens/live/tests/recovery.test.mjs`

**Interfaces:**
- Consumes: `CaptureHost.recoverList / recoverFinish / recoverDiscard`, `captureErrorText`.
- Produces: `export function RecoveryList(props: { capture: CaptureHost; active: boolean; initial?: PartialSummary[] })`.

After a crash or force-quit, the partial stays in the app data folder (Task 7 `shutdown` or the kill). The Live screen offers to finish it into a note or move it to the Trash. Nothing is deleted without a second, confirming click.

- [ ] **Step 1: Write the failing test**

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = resolve(HERE, "..");
const req = createRequire(join(resolve(LIVE, "../../../desktop"), "package.json"));
const { createElement: h } = req("react");
const { renderToStaticMarkup: html } = req("react-dom/server");

let M;
before(async () => {
  const { build } = req("esbuild");
  const outfile = join(bundleDir("live-recovery"), "recovery.mjs");
  await build({ entryPoints: [join(LIVE, "RecoveryList.tsx")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent" });
  M = await import(pathToFileURL(outfile).href);
});

test("lists unfinished captures with Finish and Move to Trash, and says the text is kept", () => {
  const out = html(h(M.RecoveryList, { capture: {}, active: true, initial: [{ id: "m-a-b", startedAtMs: Date.UTC(2026, 10, 5, 9, 30), rows: 12 }] }));
  assert.match(out, /not finished/);
  assert.match(out, /12 lines/);
  assert.match(out, /Finish into a note/);
  assert.match(out, /Move to Trash/);
});

test("nothing to recover renders nothing", () => {
  assert.equal(html(h(M.RecoveryList, { capture: {}, active: true, initial: [] })), "");
});
```

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test ../ui/screens/live/tests/recovery.test.mjs` and expect a FAIL.

- [ ] **Step 2: Implement**

```tsx
// Unfinished captures left by a crash or quit (the host's own partial files). Finish writes the meeting note the
// normal way (verified); Move to Trash needs a second, confirming click and never deletes permanently.
import { useCallback, useEffect, useState } from "react";
import { captureErrorText, type CaptureHost, type PartialSummary } from "./host.ts";

export function RecoveryList({ capture, active, initial }: { capture: CaptureHost; active: boolean; initial?: PartialSummary[] }) {
  const [items, setItems] = useState<PartialSummary[]>(initial ?? []);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await capture.recoverList()); } catch { /* no host: nothing to show */ }
  }, [capture]);
  useEffect(() => { if (active && !initial) void load(); }, [active, initial, load]);

  if (items.length === 0 && !message) return null;
  return (
    <section className="sh-panel lv-card" aria-labelledby="lv-recover-title">
      <h2 id="lv-recover-title" className="sh-panel-title">Captures that were not finished</h2>
      <p className="sh-panel-text sh-muted">LLM-IDE closed during these captures. Their text is kept until you finish or remove them.</p>
      {message && <p className="sh-notice" role="status">{message}</p>}
      <ul className="lv-recover">
        {items.map((p) => (
          <li key={p.id}>
            <span>{new Date(p.startedAtMs).toLocaleString()} · {p.rows} lines</span>{" "}
            <button type="button" className="sh-button" disabled={busy !== null} onClick={async () => {
              setBusy(p.id);
              try {
                const r = await capture.recoverFinish(p.id, "");
                setMessage(r.note ? `Saved to Library: ${r.note.rel}` : captureErrorText(r.reason ?? "empty"));
              } catch (e) { setMessage(captureErrorText(e)); }
              finally { setBusy(null); void load(); }
            }}>Finish into a note</button>{" "}
            {confirming === p.id ? (
              <button type="button" className="sh-button" disabled={busy !== null} onClick={async () => {
                setBusy(p.id);
                try { await capture.recoverDiscard(p.id); setMessage("Moved to the Trash."); }
                catch (e) { setMessage(captureErrorText(e)); }
                finally { setBusy(null); setConfirming(null); void load(); }
              }}>Confirm: move to Trash</button>
            ) : (
              <button type="button" className="sh-button" onClick={() => setConfirming(p.id)}>Move to Trash…</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/dinsmallade/llm-ide/desktop && node --test ../ui/screens/live/tests/recovery.test.mjs ../ui/screens/live/tests/components.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/screens/live/RecoveryList.tsx ui/screens/live/tests/recovery.test.mjs
git commit -m "feat(ui): finish or trash unfinished live captures after a crash

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs: signing and entitlements, parity rows, plan state, manual checklist

**Files:**
- Create: `docs/how-to/desktop-live-capture.md`
- Modify: `docs/superpowers/plans/2026-10-31-tauri-parity-checklist.md` section 10 (rows 203-215)
- Modify: `docs/superpowers/MASTER-PLAN.md` S2 ("Live caption capture per OS" line and the K3 line "Live has none")
- Modify: `docs/superpowers/USER-NEEDS.md` UN-035 (add one sentence: "Desktop Live capture plan 2026-11-05 assumes no Swift helper; approving it changes only that plan's Task 5.")

- [ ] **Step 1: Write the how-to**

`docs/how-to/desktop-live-capture.md` must contain these sections, with this text:

1. **What it reads**: caption text from Zoom (`us.zoom.xos`) and new Teams (`com.microsoft.teams2`) windows through the macOS Accessibility API, at 800 ms, only after Start. It never reads audio, video or the screen. Browser meetings use the Chrome extension.
2. **Where data goes**: the partial at `~/Library/Application Support/<desktop data dir>/capture/<id>.partial.md` (mode 0600, removed after the note is verified); the note at `<notes root>/source/meetings/YYYY/MM/`; one index upsert to the local core; nothing to a model until Re-summarise.
3. **Signing, entitlements and TCC**:
   - Accessibility is a TCC permission, not an entitlement. There is no `Info.plist` usage key for it, and none is added. Do not add microphone, camera or screen-capture keys (`scripts/check-capture-privacy.test.mjs` fails the build).
   - The hardened runtime does not block AX client calls, and no `com.apple.security.*` entitlement is needed for them. The App Sandbox must stay off, because a sandboxed app cannot be an AX client of other apps. The desktop bundle has no sandbox today (no entitlements file; `desktop/PACKAGING.md`).
   - TCC stores the grant against the app's code-signing identity (designated requirement) and bundle id `com.llmide.desktop`. An ad-hoc signed local build gets a new identity on each rebuild, so the grant goes stale. Remove the old "LLM-IDE" entry and allow it again. A Developer ID-signed, notarised build keeps the grant across updates as long as the identity and bundle id stay the same (`docs/how-to/desktop-signing-decisions.md`).
   - Responsible process: a build started from Terminal, VS Code or `npm run tauri dev` is attributed to that launcher. Grant Accessibility to the launcher, or start the `.app` from Finder. The Live screen says this in debug builds (`devBuild`).
   - The OS prompt (`AXIsProcessTrustedWithOptions` with prompt) is shown only when the user clicks "Allow Accessibility…".
   - These attribution statements are assumptions until the manual checklist (E.1 to E.3) or Phase 7 spike 1 confirms them.
4. **Recording a fixture** (spike build only): `npm run tauri dev -- --features spike`, open the developer Spike section or call `capture_dump_tree("us.zoom.xos")` from its console, and find the JSON in `capture-fixtures/`. **Before committing**, replace every name and caption value with invented text that keeps the same structure, and add it under `desktop/src-tauri/tests/fixtures/captions/` together with a `raw` and `clean` expectation.
5. **Tests**: `cd desktop/src-tauri && cargo test --lib capture_`; `cd desktop && npm test`; `cd extension && node --test --experimental-strip-types tests/caption-validation-parity.test.ts`.

- [ ] **Step 2: Update the parity checklist section 10**

Replace the rows so they read:

| Row | Mac (source) | Tauri | Evidence |
|---|---|---|---|
| Capture engine (UN-035) | yes (`CaptionScraper`, `AXCaptionReader`) | ~ | pure Rust in the host, no helper binary (plan 2026-11-05 A.1); `capture_ax_macos.rs`, tests `cargo test --lib capture_` |
| Permission status and guidance, revoke stops capture and keeps text | yes (`PermissionsView`, `PermissionsService`) | ~ | `PermissionCard.tsx`, `capture_session` permission tests; real revoke: manual E.4 |
| Teams and Zoom captions at the 800 ms cadence with the same dedupe | yes (`CaptionDeltaState`, per-app scrapers) | ~ | `capture_delta.rs` (Swift cases ported), readers on JSON fixtures; real meetings: manual E.5 to E.7 |
| Live transcript windowed to 20k lines, text only | yes (`TranscriptView`) | ~ | `transcript.ts`, `components.test.mjs` |
| Library meeting detail take-over while live | yes (`LiveCaptureGate`) | defer | app-wide banner instead (Task 11); take-over later |
| Finalize writes the meeting file (+ ack) | yes (`MeetingFileStore`, `LiveSessionMirror`) | ~ | native path 3.6 A, verified read-back, index upsert; no ack (no server copy, plan A.2) |
| Crash recovery of a partial meeting, no duplicates | yes (`PartialRecovery`) | ~ | `capture_store` + `RecoveryList.tsx`; real kill: manual E.9 |
| Auto capture on meeting start | yes (`AutoCaptureService`) | defer | D5 |
| Meeting capture matrix view | yes (`MeetingCaptureMatrixView`) | defer | |

Also update row 12 (section switcher): "Live only while recording, no desktop live capture" becomes "Live listed (desktop has live capture; Mac shows it only while recording)".

- [ ] **Step 3: Update MASTER-PLAN S2**

Change `- [ ] Live caption capture per OS: macOS AX first, Windows next, Linux best-effort (Tauri plan risks) (me)` to `- [~] Live caption capture per OS: macOS built in Rust per [desktop live capture plan](plans/2026-11-05-desktop-live-capture.md) (no Swift helper unless UN-035 says so), real-meeting check waits for you (section E); Windows (UIA) and Linux (AT-SPI) are later phases (me)`. In the K3 line, change "Live has none (the shell maps `live` to no screen)" to "Live has a screen (`ui/screens/live/`)".

Only make these MASTER-PLAN and USER-NEEDS edits after Tasks 1 to 12 are merged, so the docs never claim more than the code does.

- [ ] **Step 4: Check the docs**

Run: `cd /Users/dinsmallade/llm-ide && make docs-check`
Expected: PASS (fix any broken relative link it reports).

- [ ] **Step 5: Commit**

```bash
git add docs/how-to/desktop-live-capture.md docs/superpowers/plans/2026-10-31-tauri-parity-checklist.md docs/superpowers/MASTER-PLAN.md docs/superpowers/USER-NEEDS.md
git commit -m "docs: desktop live capture how-to, signing and TCC notes, parity rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## D. Signing and entitlements notes (summary for reviewers)

- **No entitlement is needed for AX.** No `com.apple.security.device.*` key is added, because audio is never recorded. Task 8 enforces this.
- **App Sandbox: off** (required for an AX client; the desktop has no entitlements file today).
- **Hardened runtime and notarisation:** AX client calls need no exception. The existing plan for the JIT entitlement on the nested `node` executable (PACKAGING.md) is unaffected.
- **TCC identity:** the grant belongs to `com.llmide.desktop` plus its signing identity. Ad-hoc builds lose it on rebuild, and a Developer ID build keeps it. Dev runs are attributed to the launching terminal or editor. The UI says so in debug builds.
- **Prompt:** only on the user's click. The silent `AXIsProcessTrusted()` check is used everywhere else, and it is re-read once a second only while the permission card is on screen.
- **If UN-035 = yes:** add a second signed executable, `Contents/MacOS/llmide-capture`, with the same Developer ID, hardened runtime and notarisation. Its TCC attribution (helper or parent) must be proven before release.

## E. Manual checklist (the user, real meetings)

Run with a Finder-launched `.app`; for a dev run, grant Accessibility to the terminal. Use the Swift app side by side only where a row says so.

1. [ ] Fresh grant: Live shows "Allow Accessibility"; clicking it opens the macOS dialog; after turning LLM-IDE on in System Settings, "Check again" (or a relaunch) shows the Start card.
2. [ ] Denied: with the switch off, Start is not offered, and the text names System Settings → Privacy & Security → Accessibility.
3. [ ] Rebuild (ad-hoc): the old grant stops working. Removing and re-adding the entry fixes it. Write down whether a relaunch was needed.
4. [ ] Revoke mid-meeting: turn Accessibility off while recording. Within 1 s the screen says capture paused and the captured lines are still shown, and Stop and save writes a note with those lines.
5. [ ] Zoom desktop, captions on, 10+ minutes: lines appear about 1 s after Zoom shows them; a growing sentence stays one line; different speakers make different lines with real names; "Name & 2 others" shows as "Name"; a short Japanese "はい。" appears; no toolbar text, clock or meeting id appears.
6. [ ] Teams (new) desktop, Live captions on, 10+ minutes: same checks as row 5, plus the speaker label of a continued line is the previous speaker.
7. [ ] Side by side with the Swift app on one Zoom or Teams meeting (record in both): the desktop note and the Swift note have the same lines apart from timestamps. The Live screen showed the "Mac app is also running" warning.
8. [ ] Google Meet in Chrome: the desktop Live screen finds no captions ("No captions found yet") and the Chrome extension captures as before (D6).
9. [ ] Crash: `kill -9` the desktop app during a capture, then relaunch. Live lists "Captures that were not finished" with a line count, and "Finish into a note" writes it (lines up to about 3 s before the kill). "Move to Trash…" plus confirm puts it in the Trash.
10. [ ] Stop and save: the note appears in Library under `source/meetings/YYYY/MM/`. Frontmatter title, platform, participants and duration are right, the transcript equals what Live showed, and Library search finds it (index upsert). Re-summarise in Library works, and nothing was sent before you clicked it.
11. [ ] No audio: System Settings → Privacy & Security → Microphone and Screen Recording do not list LLM-IDE, and the orange microphone dot never appears.
12. [ ] Banner: while recording, switch to Explorer, Library and Chat; the red "Recording meeting captions" banner is visible in each, and "Open Live" returns. Reload the webview (Cmd+R in a dev build): the banner comes back.
13. [ ] Load: a 60-minute meeting stays responsive; Activity Monitor shows the app's average CPU (target under 5%), and the ax time per tick is noted if you can.
14. [ ] Optional: record one scrubbed fixture per app (how-to section 4) so the readers are pinned to the real builds.

## F. Later phases (listed, not detailed)

- **W. Windows (next):** a `SnapshotSource` over UI Automation (the `windows` crate, already a target dependency through `windows-sys`; `IUIAutomation` tree with `ControlType` Text and Group and the `Name` property mapped onto `AxNode`), readers keyed by process image name (`Zoom.exe`, `ms-teams.exe`) plus Windows fixtures, local time via `localtime_s`, and a UIPI integrity check (an elevated meeting app cannot be read). The UI copy changes to "Windows Accessibility"; no permission prompt exists.
- **L. Linux (best-effort):** AT-SPI over D-Bus (`atspi` crate, a new dependency needing review), Zoom for Linux only (Teams has no native Linux client, so the extension covers it), with the session-wide AT-SPI caveat stated in the UI.
- **Desktop as archivist for extension captures:** planned and built in [2026-11-07-desktop-capture-archivist.md](2026-11-07-desktop-capture-archivist.md). The Swift app is gone, so there is no "both apps" rule to decide; the open item is how the extension reaches the desktop core (D2 there).
- **Library meeting-detail take-over while live** (Mac `LiveCaptureGate`) and **auto-capture** (D5), after the manual flow is verified.

## G. Self-review

1. **Requirement coverage.** Accessibility permission flow (prompt, denied state, re-check): Tasks 5, 7, 10 and E.1 to E.4. Per-app readers with the extension invariants (per-speaker row state, send only on change, content validation, combined-speaker stripping): Tasks 1 to 3 and 6. Privacy (explicit start, visible banner, no audio): Tasks 7, 8, 10 and 11. Transcript store and the live-then-archive reuse: Task 4 and section A.2, with the ack path shown as decision D2. Tests: Rust tests on JSON fixtures in Tasks 1 to 7, UI tests in Tasks 9 to 12. Signing and entitlements: section D and Task 13. Manual checklist: section E. Decisions: A.3. Windows and Linux: section F.
2. **Placeholders.** No "TBD". Two steps carry compile-time checks instead: the `objc2` API probe (Task 5 step 1) and the `notes_write` field visibility check (Task 4 step 3). Each says exactly what to do with each possible result.
3. **Type consistency.** `CaptureEvent` (Rust, Task 6) matches `decodeEvent` (Task 9): fields `type`, `row`, `time`, `speaker`, `text` and `state` in snake_case. `StopResult`, `FinalizedNote` and `IndexUpsert` (Rust camelCase) match the TypeScript decoders. `PartialSummary` matches `decodePartials`. `CaptureStatus` matches `decodeStatus`, including `devBuild` and `macAppRunning`. `LiveRecording` is the same shape in `LiveScreen.tsx` and `live-status.ts`. `MAX_EMPTY_TICKS`, `PAGE_ROWS` and `MAX_DISPLAY_ROWS` are each defined once and used under the same names.
