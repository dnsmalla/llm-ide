# Desktop Notifications and Tray Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Tauri desktop app (macOS, Windows, Linux) shows a native notification when something needs the user (an approval is waiting, a long task finished or failed, sync needs attention, an update is available, the backend stopped). A click takes the user to the right section. The tray / menu-bar icon shows status, the pending-approval count and quick actions. Each category has its own switch in Settings. No notification ever carries user content.

**Architecture:** The Rust host owns every word. A new `desktop/src-tauri/src/notify.rs` holds a fixed table of 13 kinds, and each kind has its category, generic body text and click route. Pure rules decide whether a notification is shown: the category switch, whether the user is already looking (window focused on that section), de-duplication by an opaque key, and coalescing of bursts per kind. The webview calls `notify_user(kind, key?, count?)` and never sends text. The host itself raises `update_ready` (from `updater::check_now`) and `core_down` (from a 2 s in-memory watcher in `tray.rs`, because `core_host` raises no change event). The tray menu gets a status line, an approvals line and Start/Stop live capture / Pause-Resume sync items. They are computed by a pure `tray_view` function, and the webview reports the counts with `tray_report`. Tray clicks and notification "clicks" reach the webview as one `tray-action` event. The webview side (`ui/screens/shell/notify/`) rides the existing inbox (15 s) and activity (25 s) polls, so it adds no new timer.

**Tech Stack:** Rust (Tauri `=2.11.6` with `tray-icon`, `tauri-plugin-notification` `=2.4.0` — both already pinned in `desktop/src-tauri/Cargo.toml`; **no new dependency**), React 18 + TypeScript tested with `node --test --experimental-strip-types` + esbuild (`ui/screens/shell/tests/helpers.mjs`), Node core (`extension/`, one activity kind).

**Spec:** MASTER-PLAN S2 row "Tray / menu-bar presence and notifications" (`docs/superpowers/MASTER-PLAN.md`, the `[~]` row that names this plan), [Tauri desktop plan](2026-10-24-tauri-desktop-and-relay.md) ("Rust shell: window/tray/menus"), `desktop/PACKAGING.md` section "Project open, tray and notifications" (Linux `libayatana-appindicator3-1`, GNOME AppIndicator extension, Windows AppUserModelID, macOS first-use permission prompt), and the user's brief for this plan (scope items 1-4 and the constraints, restated below as Global Constraints and section A).

## Global Constraints

- Pinned versions only. `tauri =2.11.6`, `tauri-plugin-notification =2.4.0` (the newest that resolves against tauri 2.11.6; 2.5+ need tauri 2.12). Add **no** crate or npm package.
- The webview gets **no** `notification:*` permission. `desktop/scripts/check-capabilities.mjs` already forbids it, and `node scripts/check-capabilities.mjs --product` must pass after every task that touches commands.
- Every new host command goes into `desktop/src-tauri/build.rs` `COMMANDS`, `lib.rs` `product_handlers!`, and `capabilities/default.json` (`allow-<kebab-name>`). The old `notify` command is removed from all three.
- Notification text comes only from the Rust table in `notify.rs`. Title `LLM-IDE`, body ≤ 80 characters. It never contains chat text, file paths, project names, meeting captions, tokens, account names, host names or device names. The webview may send a kind, an opaque key (≤ 64 chars, `[A-Za-z0-9_.:-]`, used only for de-duplication, never shown) and a count (clamped to 999 and shown as at most "99+").
- The webview cannot raise the `update_ready` or `core_down` kinds: those facts come from the host only.
- No notification while the main window is focused on the kind's own place. The approvals inbox and the backend-down panel are visible from every section, so those two kinds are silent whenever the window is focused.
- One notification per de-dup key. Bursts are coalesced to at most one notification per kind per 10 s (`COALESCE_MS = 10_000`).
- No polling loop where an event exists. The only new timer is the host's 2 s watcher, which reads `CoreHost::status()` and `capture_host::is_recording()` (in-memory mutexes, no IO), because neither module raises a change event. The webview reuses the inbox and activity polls.
- Never hold a Rust lock across a menu, tray or window call. Sync commands run on the main thread, and a menu `set_text` from another thread waits for the main thread, so holding a lock there deadlocks. Clone out first, then call.
- A missing tray (Linux without a StatusNotifier host) never panics. The app runs without it, the watcher still raises `core_down`, and the Settings card shows a note.
- All three OSes are covered by unit tests on pure logic (kind table, text, routes, suppression, gate, tray view, tray-action parsing). The GUI behaviour is in the manual check rows (Task 9 and section C).
- Conventional Commits, on `main`, one concern per commit, not pushed. Each commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Settings files are edited in one place only: `ui/screens/settings/index.tsx` (one import line). The card lives in `ui/screens/shell/notify/`; `ui/screens/settings/sync-model.ts` and `ui.tsx` are imported read-only.

---

## A. Decisions for the user (secure default first)

| # | Question | Default built (secure / least surprising first) | Alternative |
|---|---|---|---|
| D1 | How does a notification click open the right section? `tauri-plugin-notification` 2.4 reports **no click on desktop**. | The host remembers the last notification's route for 2 minutes. It hands the route to the webview once, when the main window next gains focus or is opened from the tray. On macOS the app also handles Dock reopen. | Per-OS native click handlers (mac-notification-sys, WinRT toast activation, D-Bus actions): three code paths that cannot be tested in CI. |
| D2 | Default state of the five category switches | All on. The text is generic, and macOS asks for permission on first use. | All off until the user opts in. |
| D3 | Quiet hours | None. The OS Focus / Do Not Disturb setting applies on all three OSes. | A built-in time window (needs local-time handling: not trivial). |
| D4 | Source for "sync needs attention" | The existing activity feed: a new `sync_attention` row plus the existing `sync_device_removed` row, read on the bell's 25 s poll. That poll pauses while the window is hidden. | A new `/kb/sync/status` poll that also runs while the window is hidden. |
| D5 | Which "done/failed" events notify | Loop runs (not user-cancelled ones), Auto Tasks (built-in and custom), a Graph screen Generate, and Doc Gen documents. No notification for background graph auto-updates, Visual generations or loop-internal graph stages. | Also notify for auto-updates and Visual. |
| D6 | Tray sync item | A toggle: Pause sync / Resume sync. It is greyed out when sync is unavailable. | Pause only. Resume stays in Settings. |
| D7 | Where the count shows | The tray menu line on every OS, plus a count next to the menu-bar icon (macOS, Linux) and in the tooltip (Windows). No Dock or taskbar badge. | Add a Dock/taskbar badge (`set_badge_count`). |
| D8 | The old `notify(kind, detail)` command | Removed: no free-text detail reaches a notification. | Keep it for compatibility (nothing else calls it). |

## B. File structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `desktop/src-tauri/src/prefs.rs` | Modify | `NotifyPrefs` (5 switches, default on, applies at once) in `Prefs` + `PrefsPatch` |
| `ui/screens/shell/host-prefs.ts` | Modify | `NotifyPrefs` type + `decodeNotifyPrefs`, `HostPrefs.notifications` |
| `ui/screens/shell/tests/host-prefs.test.mjs` | Modify | fixture gets `notifications`; decoder test |
| `desktop/src-tauri/src/notify.rs` | Create | kind table, text, routes, suppression, gate, route hand-off, `notify_user` / `notify_focus`, `fire_host`, `on_main_focused` |
| `desktop/src-tauri/src/lib.rs` | Modify | `mod notify;`, handlers, `Focused(true)` hook, macOS `Reopen` |
| `desktop/src-tauri/build.rs` | Modify | `COMMANDS`: drop `notify`, add `notify_user`, `notify_focus`, `tray_report` |
| `desktop/src-tauri/capabilities/default.json` | Modify | same grants |
| `desktop/src-tauri/src/updater.rs` | Modify | `update_ready` after a check finds an update |
| `desktop/src-tauri/src/tray.rs` | Modify | drop template notify; `show_main`; `TrayView` / `tray_view` / `core_went_down`; new menu items; `tray_report`; watcher |
| `desktop/src-tauri/src/capture_host.rs` | Modify | `is_recording()` |
| `ui/screens/shell/approvals/inbox-store.ts` | Modify | notify with `{ key, count }` through `notify_user` (`approval_job`) |
| `ui/screens/shell/tests/bus-inbox.test.mjs` | Modify | expect `{ key, count }` |
| `extension/kb/activity.mjs`, `extension/routes/sync/scheduler.mjs` | Modify | `sync_attention` activity row when sync turns itself off |
| `extension/tests/sync-routes.test.mjs` | Modify | test for the row |
| `ui/screens/shell/notify/notify.ts` | Create | pure helpers: kinds, `notifyUser`, `notifyTask`, `reportSection`, `trayAction`, `syncReport`, `syncAlerts`, `generationEnded`, `NOTIFY_SWITCHES`, `trayNote` |
| `ui/screens/shell/notify/bridge.ts` | Create | `installNotifyBridge(deps)`: stores → `tray_report` / `notify_user`, `tray-action` → navigation |
| `ui/screens/shell/bus.ts` | Modify | sticky `live-capture` event |
| `ui/screens/shell/tests/notify.test.mjs` | Create | pure helpers, Rust drift checks, bridge with fakes |
| `ui/screens/shell/Shell.tsx` | Modify | install the bridge, report the active section |
| `ui/screens/shell/approvals/BusInbox.tsx` | Modify | open on `llmide:open-inbox` |
| `ui/screens/live/LiveScreen.tsx`, `ui/screens/live/index.tsx` | Modify | tray Start/Stop through `onToggleRequest` |
| `ui/screens/loop/native/NativeLoopScreen.tsx` | Modify | `notifyTask("loop", …)` |
| `ui/screens/autotasks/native/NativeAutoTasksScreen.tsx` | Modify | `notifyTask("autotask", …)` |
| `ui/screens/graph/index.tsx` | Modify | `notifyTask("graph", …)` |
| `ui/screens/docgen/section.tsx` | Modify | `notifyTask("docgen", …)` on the `doc` surface |
| `ui/screens/shell/notify/NotificationsCard.tsx` | Create | Settings card: 5 switches + tray note |
| `ui/screens/shell/notify/register-card.ts` | Create | registers the card in Settings > General |
| `ui/screens/settings/index.tsx` | Modify | **one line**: `import "../shell/notify/register-card.ts";` |
| `desktop/PACKAGING.md`, `docs/superpowers/MASTER-PLAN.md`, `docs/superpowers/USER-CHECKLIST.md` | Modify | docs + per-OS manual checks |

Test commands used below (run from the repo root `/Users/dinsmallade/llm-ide`):
- Rust: `cd desktop/src-tauri && cargo test <filter>` (if the sandbox reports "Operation not permitted" or "Invalid manifest", rerun outside the sandbox).
- UI: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/<file>.test.mjs`.
- Core: `cd extension && node --test --experimental-strip-types tests/<file>.test.mjs`.

---

### Task 1: Notification switches in host prefs (~20 min)

**Files:**
- Modify: `desktop/src-tauri/src/prefs.rs` (struct `Prefs` ~line 105, `Default` ~135, `PrefsPatch` ~148, `patched` ~180, `parse` ~227, `view` ~349, tests module end)
- Modify: `ui/screens/shell/host-prefs.ts`
- Test: `ui/screens/shell/tests/host-prefs.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (Rust): `pub struct NotifyPrefs { pub approvals: bool, pub tasks: bool, pub sync: bool, pub updates: bool, pub core: bool }` (`Copy`, `PartialEq`, `Default` = all true). `Prefs.notifications: NotifyPrefs`, `PrefsPatch.notifications: Option<NotifyPrefs>`. `crate::prefs::stored().notifications` is the live value.
- Produces (TS): `export interface NotifyPrefs { approvals; tasks; sync; updates; core: boolean }`, `DEFAULT_NOTIFY_PREFS`, `decodeNotifyPrefs(raw: unknown): NotifyPrefs`, `HostPrefs.notifications: NotifyPrefs`.

- [ ] **Step 1: Write the failing Rust test** — append inside `mod tests` at the end of `prefs.rs`:

```rust
    #[test]
    fn notification_switches_default_on_patch_whole_and_never_need_a_restart() {
        assert_eq!(Prefs::default().notifications, NotifyPrefs::default());
        let d = NotifyPrefs::default();
        assert!(d.approvals && d.tasks && d.sync && d.updates && d.core);
        let off = NotifyPrefs { tasks: false, ..NotifyPrefs::default() };
        let p = Prefs::default().patched(&PrefsPatch { notifications: Some(off), ..Default::default() });
        assert_eq!(p.notifications, off);
        assert_eq!(parse(&serde_json::to_string(&p).unwrap()).notifications, off);
        assert!(parse(r#"{"ltaMode":"off"}"#).notifications.approvals, "an old file keeps the defaults");
        assert_eq!(parse(r#"{"notifications":{"approvals":false,"evil":true}}"#), Prefs::default(), "an unknown key refuses the file");
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"notifications":{"approvals":"no"}}"#).is_err());
        assert!(!view(Prefs { notifications: off, ..Prefs::default() }, true).restart_needed, "applies at once");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && cargo test notification_switches_default_on`
Expected: FAIL to compile with "cannot find type `NotifyPrefs`".

- [ ] **Step 3: Implement in `prefs.rs`**

Above `pub struct Prefs`, add:

```rust
/// Which native notifications the host may show (Settings > General > Notifications). Applies at once.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct NotifyPrefs {
    /// A tool approval in Chat or a bus job (phone, web app, schedule) is waiting.
    pub approvals: bool,
    /// A Loop run, Auto Task, code graph generation or Doc Gen finished or failed.
    pub tasks: bool,
    /// Sync turned itself off or removed a device.
    pub sync: bool,
    /// A signed update is available.
    pub updates: bool,
    /// The backend stopped unexpectedly.
    pub core: bool,
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self { approvals: true, tasks: true, sync: true, updates: true, core: true }
    }
}
```

In `pub struct Prefs`, after `pub update_checks: bool,` add:

```rust
    /// Per-category notification switches. Applies at once.
    pub notifications: NotifyPrefs,
```

In `impl Default for Prefs`, change `graph_auto_update_minutes: 0, update_checks: true,` to `graph_auto_update_minutes: 0, update_checks: true, notifications: NotifyPrefs::default(),`.

In `pub struct PrefsPatch`, after `pub update_checks: Option<bool>,` add `pub notifications: Option<NotifyPrefs>,`.

In `patched`, after the `update_checks` block add:

```rust
        if let Some(v) = p.notifications {
            n.notifications = v;
        }
```

In `parse`, change `update_checks: Some(p.update_checks),` to `update_checks: Some(p.update_checks), notifications: Some(p.notifications),`.

In `view`, change the `restart_needed` line to:

```rust
    let restart_needed = Prefs { theme: launch.theme, loop_defaults: launch.loop_defaults.clone(), graph_auto_update_minutes: launch.graph_auto_update_minutes, update_checks: launch.update_checks, notifications: launch.notifications, ..stored.clone() } != launch;
```

- [ ] **Step 4: Run the Rust prefs tests**

Run: `cd desktop/src-tauri && cargo test prefs::`
Expected: PASS (all prefs tests, including the new one).

- [ ] **Step 5: Write the failing TS test** — in `ui/screens/shell/tests/host-prefs.test.mjs`, change the `P` constant to end with `updateChecks: true, notifications: { approvals: true, tasks: true, sync: true, updates: true, core: true } };` and add:

```js
test("notification switches decode with every missing or bad value on", () => {
  assert.deepEqual(m.decodeNotifyPrefs({ approvals: false, tasks: "no" }), { approvals: false, tasks: true, sync: true, updates: true, core: true });
  assert.deepEqual(m.decodeNotifyPrefs("x"), m.DEFAULT_NOTIFY_PREFS);
  assert.deepEqual(m.decodePrefs({ ...P, notifications: undefined }).notifications, m.DEFAULT_NOTIFY_PREFS, "an old host without the key");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/host-prefs.test.mjs`
Expected: FAIL (`m.decodeNotifyPrefs is not a function`; the round-trip test fails on the missing `notifications` key).

- [ ] **Step 7: Implement in `host-prefs.ts`**

After `DEFAULT_LOOP_DEFAULTS`, add:

```ts
/** Per-category notification switches (desktop prefs::NotifyPrefs). Apply at once. */
export interface NotifyPrefs { approvals: boolean; tasks: boolean; sync: boolean; updates: boolean; core: boolean }

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = Object.freeze({ approvals: true, tasks: true, sync: true, updates: true, core: true });

/** Defensive decode: anything but an explicit `false` reads as on (the host default). */
export function decodeNotifyPrefs(raw: unknown): NotifyPrefs {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { approvals: r.approvals !== false, tasks: r.tasks !== false, sync: r.sync !== false, updates: r.updates !== false, core: r.core !== false };
}
```

In `interface HostPrefs`, after `updateChecks: boolean;` add:

```ts
  /** Per-category notification switches; apply at once. */
  notifications: NotifyPrefs;
```

In `decodePrefs`, change the return line's ending `graphAutoUpdateMinutes, updateChecks };` to `graphAutoUpdateMinutes, updateChecks, notifications: decodeNotifyPrefs(raw.notifications) };`.

- [ ] **Step 8: Run the TS test to verify it passes**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/host-prefs.test.mjs`
Expected: PASS (including "the prefs keys match the Rust schema").

- [ ] **Step 9: Commit**

```bash
git add desktop/src-tauri/src/prefs.rs ui/screens/shell/host-prefs.ts ui/screens/shell/tests/host-prefs.test.mjs
git commit -m "feat(desktop): notification switches in host prefs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fixed notification table, gate and routing rules (~30 min)

**Files:**
- Create: `desktop/src-tauri/src/notify.rs` (pure part only in this task)
- Modify: `desktop/src-tauri/src/lib.rs` (add `mod notify;` before `mod tray;`, ~line 57)

**Interfaces:**
- Consumes: `crate::prefs::NotifyPrefs` (Task 1).
- Produces: `pub enum Kind { ApprovalChat, ApprovalJob, LoopDone, LoopFailed, AutoTaskDone, AutoTaskFailed, GraphDone, GraphFailed, DocGenDone, DocGenFailed, SyncAttention, UpdateReady, CoreDown }` with `Kind::ALL`, `wire() -> &'static str`, `from_webview(&str) -> Option<Kind>`, `group() -> Group`, `route() -> &'static str`, `body(count: u32) -> String`. Also `pub enum Group { Approvals, Tasks, Sync, Updates, Core }`, `pub fn enabled(Kind, &NotifyPrefs) -> bool`, `pub fn suppressed(Kind, focused: bool, active: &str) -> bool`, `pub struct Gate` + `admit(&mut self, Kind, Option<&str>, now_ms: u64) -> bool`, `pub fn take_route(&mut Option<(&'static str, u64)>, now: u64) -> Option<&'static str>`, `pub fn valid_key(&str) -> bool`, `pub fn section_id(&str) -> Option<&'static str>`, and the consts `SECTIONS: [&str; 15]`, `TITLE`, `COALESCE_MS`, `ROUTE_TTL_MS`, `KEY_MAX`, `SEEN_MAX`.
- Wire names (the TS side uses these exact strings): `approval_chat`, `approval_job`, `loop_done`, `loop_failed`, `autotask_done`, `autotask_failed`, `graph_done`, `graph_failed`, `docgen_done`, `docgen_failed`, `sync_attention`, `update_ready`, `core_down`.
- Routes: `chat`, `inbox`, `loop`, `autotasks`, `graph`, `docgen`, `settings:mobile`, `settings:updates`, `settings:server`.

- [ ] **Step 1: Write the file with the tests first** — create `desktop/src-tauri/src/notify.rs` containing only the test module below (it references items not written yet, so it fails to compile), and add `mod notify;` to `lib.rs` just before `mod tray;`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::prefs::NotifyPrefs;

    #[test]
    fn every_kind_has_a_unique_wire_name() {
        let wires: std::collections::HashSet<_> = Kind::ALL.iter().map(|k| k.wire()).collect();
        assert_eq!(wires.len(), Kind::ALL.len());
    }

    #[test]
    fn the_webview_cannot_raise_host_only_kinds() {
        assert_eq!(Kind::from_webview("approval_chat"), Some(Kind::ApprovalChat));
        assert_eq!(Kind::from_webview("docgen_failed"), Some(Kind::DocGenFailed));
        assert_eq!(Kind::from_webview("update_ready"), None);
        assert_eq!(Kind::from_webview("core_down"), None);
        assert_eq!(Kind::from_webview("approval_needed"), None, "the old template names are gone");
        assert_eq!(Kind::from_webview(""), None);
    }

    #[test]
    fn bodies_are_short_generic_and_counted() {
        assert_eq!(Kind::ApprovalChat.body(1), "A tool is waiting for your approval in Chat.");
        assert_eq!(Kind::ApprovalChat.body(0), "A tool is waiting for your approval in Chat.");
        assert_eq!(Kind::ApprovalJob.body(3), "3 jobs are waiting for your approval.");
        assert_eq!(Kind::ApprovalJob.body(500), "99+ jobs are waiting for your approval.");
        assert_eq!(Kind::LoopFailed.body(1), "A Loop run did not pass.");
        for k in Kind::ALL {
            let b = k.body(2);
            assert!(!b.is_empty() && b.chars().count() <= 80, "{b}");
            assert!(!b.contains('/') && !b.contains('\\') && !b.contains('@') && !b.contains("://"), "{b}");
        }
    }

    #[test]
    fn routes_point_at_known_sections_or_the_inbox() {
        for k in Kind::ALL {
            let r = k.route();
            assert!(r == "inbox" || SECTIONS.contains(&r.split(':').next().unwrap()), "{r}");
        }
        assert_eq!(Kind::SyncAttention.route(), "settings:mobile");
        assert_eq!(Kind::CoreDown.route(), "settings:server");
    }

    #[test]
    fn each_switch_silences_its_own_kinds_only() {
        let on = NotifyPrefs::default();
        for k in Kind::ALL {
            assert!(enabled(k, &on), "{k:?}");
        }
        let no_tasks = NotifyPrefs { tasks: false, ..on };
        assert!(!enabled(Kind::LoopFailed, &no_tasks) && !enabled(Kind::GraphDone, &no_tasks) && !enabled(Kind::AutoTaskDone, &no_tasks));
        assert!(enabled(Kind::ApprovalChat, &no_tasks) && enabled(Kind::CoreDown, &no_tasks));
        assert!(!enabled(Kind::ApprovalJob, &NotifyPrefs { approvals: false, ..on }));
        assert!(!enabled(Kind::SyncAttention, &NotifyPrefs { sync: false, ..on }));
        assert!(!enabled(Kind::UpdateReady, &NotifyPrefs { updates: false, ..on }));
        assert!(!enabled(Kind::CoreDown, &NotifyPrefs { core: false, ..on }));
    }

    #[test]
    fn a_focused_window_on_the_place_is_silent() {
        assert!(suppressed(Kind::ApprovalChat, true, "chat"));
        assert!(!suppressed(Kind::ApprovalChat, true, "explorer"));
        assert!(!suppressed(Kind::ApprovalChat, false, "chat"), "a hidden or unfocused window always notifies");
        assert!(suppressed(Kind::ApprovalJob, true, "graph"), "the inbox is on every section");
        assert!(suppressed(Kind::CoreDown, true, "loop"), "the core-down panel covers every section");
        assert!(suppressed(Kind::UpdateReady, true, "settings"));
        assert!(!suppressed(Kind::UpdateReady, true, "chat"));
        assert!(suppressed(Kind::DocGenDone, true, "docgen"));
    }

    #[test]
    fn the_gate_shows_each_key_once_and_coalesces_bursts_per_kind() {
        let mut g = Gate::default();
        let t = 1_000_000;
        assert!(g.admit(Kind::ApprovalJob, Some("a"), t));
        assert!(!g.admit(Kind::ApprovalJob, Some("a"), t + 60_000), "same approval: never twice");
        assert!(!g.admit(Kind::ApprovalJob, Some("b"), t + 1_000), "a burst is coalesced");
        assert!(!g.admit(Kind::ApprovalJob, Some("b"), t + 20_000), "b was seen in the burst; the next new one carries the count");
        assert!(g.admit(Kind::ApprovalJob, Some("c"), t + 20_000));
        assert!(g.admit(Kind::LoopDone, None, t + 20_001), "kinds coalesce separately");
        assert!(!g.admit(Kind::LoopDone, None, t + 25_000));
        assert!(g.admit(Kind::LoopDone, None, t + 31_000));
    }

    #[test]
    fn the_seen_list_is_bounded() {
        let mut g = Gate::default();
        for i in 0..(SEEN_MAX as u64 + 10) {
            g.admit(Kind::ApprovalJob, Some(&format!("k{i}")), 1_000_000 + i * COALESCE_MS * 2);
        }
        assert_eq!(g.seen.len(), SEEN_MAX);
    }

    #[test]
    fn a_route_is_taken_once_and_only_while_fresh() {
        let mut p = Some(("chat", 1_000));
        assert_eq!(take_route(&mut p, 1_000 + ROUTE_TTL_MS), Some("chat"));
        assert_eq!(take_route(&mut p, 2_000), None, "taken once");
        let mut old = Some(("loop", 1_000));
        assert_eq!(take_route(&mut old, 1_001 + ROUTE_TTL_MS), None);
        assert!(old.is_none(), "a stale route is dropped");
    }

    #[test]
    fn keys_and_sections_are_validated() {
        assert!(valid_key("7c1d2e3f-0000-4000-8000-0000000000a2"));
        assert!(valid_key("activity:12"));
        assert!(!valid_key(""));
        assert!(!valid_key(&"a".repeat(KEY_MAX + 1)));
        assert!(!valid_key("a b"));
        assert!(!valid_key("../x/y"));
        assert_eq!(section_id("loop"), Some("loop"));
        assert_eq!(section_id("Loop"), None);
        assert_eq!(section_id("inbox"), None, "the inbox is a route, not a section");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop/src-tauri && cargo test notify::`
Expected: FAIL to compile ("cannot find type `Kind`").

- [ ] **Step 3: Write the implementation** — put this above the test module in `notify.rs`:

```rust
//! Native notifications: a fixed table of kinds, host-built generic text, and the rules that decide whether one is
//! shown (category switch, focus, de-duplication, coalescing) and where a click leads.
//!
//! Privacy: a notification never carries chat text, file paths, captions, tokens, project, account or device names.
//! The webview names a KIND plus an opaque de-dup key and a count; the host builds the words from this table. The
//! webview cannot raise `update_ready` or `core_down` (host-only facts).
//!
//! Clicks: tauri-plugin-notification 2.4 reports no click on desktop. The host keeps the last notification's route
//! for `ROUTE_TTL_MS` and hands it to the webview once, when the main window next gains focus (a click on the
//! notification activates the app) or when the tray opens the window.

use std::collections::{HashMap, VecDeque};

use crate::prefs::NotifyPrefs;

pub const TITLE: &str = "LLM-IDE";
/// At most one notification per kind in this window; later ones in a burst are dropped (the next carries the count).
pub const COALESCE_MS: u64 = 10_000;
/// How long a shown notification's route waits for the window to be focused.
pub const ROUTE_TTL_MS: u64 = 120_000;
pub const KEY_MAX: usize = 64;
pub const SEEN_MAX: usize = 256;

/// The section ids the webview may report (`SectionId` in ui/screens/shell/sections.ts; a TS test keeps them in step).
pub const SECTIONS: [&str; 15] = [
    "welcome", "chat", "explorer", "library", "live", "settings", "graph", "issues", "gantt", "loop", "docgen", "visual",
    "autotasks", "conflicts", "spike",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    ApprovalChat,
    ApprovalJob,
    LoopDone,
    LoopFailed,
    AutoTaskDone,
    AutoTaskFailed,
    GraphDone,
    GraphFailed,
    DocGenDone,
    DocGenFailed,
    SyncAttention,
    UpdateReady,
    CoreDown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Approvals,
    Tasks,
    Sync,
    Updates,
    Core,
}

impl Kind {
    pub const ALL: [Kind; 13] = [
        Kind::ApprovalChat, Kind::ApprovalJob, Kind::LoopDone, Kind::LoopFailed, Kind::AutoTaskDone, Kind::AutoTaskFailed,
        Kind::GraphDone, Kind::GraphFailed, Kind::DocGenDone, Kind::DocGenFailed, Kind::SyncAttention, Kind::UpdateReady,
        Kind::CoreDown,
    ];

    pub fn wire(self) -> &'static str {
        match self {
            Kind::ApprovalChat => "approval_chat",
            Kind::ApprovalJob => "approval_job",
            Kind::LoopDone => "loop_done",
            Kind::LoopFailed => "loop_failed",
            Kind::AutoTaskDone => "autotask_done",
            Kind::AutoTaskFailed => "autotask_failed",
            Kind::GraphDone => "graph_done",
            Kind::GraphFailed => "graph_failed",
            Kind::DocGenDone => "docgen_done",
            Kind::DocGenFailed => "docgen_failed",
            Kind::SyncAttention => "sync_attention",
            Kind::UpdateReady => "update_ready",
            Kind::CoreDown => "core_down",
        }
    }

    /// A kind the webview may raise; `update_ready` and `core_down` come from the host only.
    pub fn from_webview(s: &str) -> Option<Kind> {
        Self::ALL.into_iter().find(|k| k.wire() == s && !matches!(k, Kind::UpdateReady | Kind::CoreDown))
    }

    pub fn group(self) -> Group {
        match self {
            Kind::ApprovalChat | Kind::ApprovalJob => Group::Approvals,
            Kind::SyncAttention => Group::Sync,
            Kind::UpdateReady => Group::Updates,
            Kind::CoreDown => Group::Core,
            _ => Group::Tasks,
        }
    }

    /// Where a click leads: a section id, `section:anchor` (a Settings group), or `inbox` (the status-bar inbox).
    pub fn route(self) -> &'static str {
        match self {
            Kind::ApprovalChat => "chat",
            Kind::ApprovalJob => "inbox",
            Kind::LoopDone | Kind::LoopFailed => "loop",
            Kind::AutoTaskDone | Kind::AutoTaskFailed => "autotasks",
            Kind::GraphDone | Kind::GraphFailed => "graph",
            Kind::DocGenDone | Kind::DocGenFailed => "docgen",
            Kind::SyncAttention => "settings:mobile",
            Kind::UpdateReady => "settings:updates",
            Kind::CoreDown => "settings:server",
        }
    }

    /// The body: fixed words from this table. `count` is how many are waiting (approvals only).
    pub fn body(self, count: u32) -> String {
        let n = if count > 99 { "99+".to_string() } else { count.to_string() };
        let many = count > 1;
        match self {
            Kind::ApprovalChat if many => format!("{n} tools are waiting for your approval in Chat."),
            Kind::ApprovalChat => "A tool is waiting for your approval in Chat.".into(),
            Kind::ApprovalJob if many => format!("{n} jobs are waiting for your approval."),
            Kind::ApprovalJob => "A job is waiting for your approval.".into(),
            Kind::LoopDone => "A Loop run passed.".into(),
            Kind::LoopFailed => "A Loop run did not pass.".into(),
            Kind::AutoTaskDone => "An Auto Task finished.".into(),
            Kind::AutoTaskFailed => "An Auto Task did not complete.".into(),
            Kind::GraphDone => "The code graph is ready.".into(),
            Kind::GraphFailed => "Code graph generation failed.".into(),
            Kind::DocGenDone => "A generated document is ready.".into(),
            Kind::DocGenFailed => "Document generation failed.".into(),
            Kind::SyncAttention => "Sync needs your attention in Settings.".into(),
            Kind::UpdateReady => "An LLM-IDE update is available.".into(),
            Kind::CoreDown => "The LLM-IDE backend stopped. Open the app to restart it.".into(),
        }
    }
}

/// The category switch for `kind`.
pub fn enabled(kind: Kind, p: &NotifyPrefs) -> bool {
    match kind.group() {
        Group::Approvals => p.approvals,
        Group::Tasks => p.tasks,
        Group::Sync => p.sync,
        Group::Updates => p.updates,
        Group::Core => p.core,
    }
}

/// True when the user is already looking: the main window is focused and shows the kind's place. The approvals
/// inbox and the backend-down panel are visible from every section.
pub fn suppressed(kind: Kind, focused: bool, active: &str) -> bool {
    focused
        && match kind.route() {
            "inbox" | "settings:server" => true,
            r => r.split(':').next() == Some(active),
        }
}

/// De-duplication (each key once) and per-kind coalescing.
#[derive(Default)]
pub struct Gate {
    seen: VecDeque<(Kind, String)>,
    last: HashMap<Kind, u64>,
}

impl Gate {
    /// True when this notification may be shown now. A key is remembered even when the burst rule drops it.
    pub fn admit(&mut self, kind: Kind, key: Option<&str>, now: u64) -> bool {
        if let Some(k) = key {
            if self.seen.iter().any(|(sk, sv)| *sk == kind && sv == k) {
                return false;
            }
            self.seen.push_back((kind, k.to_string()));
            if self.seen.len() > SEEN_MAX {
                self.seen.pop_front();
            }
        }
        if self.last.get(&kind).is_some_and(|t| now.saturating_sub(*t) < COALESCE_MS) {
            return false;
        }
        self.last.insert(kind, now);
        true
    }
}

/// The pending route, once, while it is fresh; a stale one is dropped.
pub fn take_route(pending: &mut Option<(&'static str, u64)>, now: u64) -> Option<&'static str> {
    pending.take().filter(|(_, at)| now.saturating_sub(*at) <= ROUTE_TTL_MS).map(|(r, _)| r)
}

/// An opaque de-dup key: short, plain ASCII, never shown.
pub fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= KEY_MAX && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

/// The fixed section id equal to `s`, or None.
pub fn section_id(s: &str) -> Option<&'static str> {
    SECTIONS.iter().copied().find(|x| *x == s)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test notify::`
Expected: PASS, 10 tests. (Dead-code warnings for unused pub items are fine until Task 3.)

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/notify.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): fixed notification table, gate and routing rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `notify_user` and `notify_focus` replace the template `notify` command (~35 min)

**Files:**
- Modify: `desktop/src-tauri/src/notify.rs` (append the process state + commands)
- Modify: `desktop/src-tauri/src/tray.rs` (remove template notify, add `show_main`)
- Modify: `desktop/src-tauri/src/lib.rs` (`product_handlers!` ~line 381, `on_window_event` ~509, `app.run` ~575)
- Modify: `desktop/src-tauri/build.rs` (~line 101), `desktop/src-tauri/capabilities/default.json` (~line 114)
- Modify: `desktop/src-tauri/src/updater.rs` (`check_now`)
- Modify: `ui/screens/shell/approvals/inbox-store.ts`
- Test: `ui/screens/shell/tests/bus-inbox.test.mjs`

**Interfaces:**
- Consumes: everything from Task 2; `crate::prefs::stored()`; `crate::confirm::now_ms()`.
- Produces (host commands): `notify_user(kind: String, key: Option<String>, count: Option<u32>) -> Result<bool, String>` (JS args `{ kind, key, count }`; `Ok(true)` = shown). `notify_focus(section: String) -> Result<(), String>` (JS `{ section }`).
- Produces (Rust): `pub fn fire_host(app: &AppHandle, kind: Kind, key: Option<&str>)`, `pub fn on_main_focused(app: &AppHandle)`, `tray::show_main(app: &AppHandle)`.
- Produces (event): `tray-action` with a string payload `route:<route>` (later tasks add `capture_toggle`, `sync_toggle`).
- Produces (TS): `InboxDeps.notify(info: { key: string; count: number })`.

- [ ] **Step 1: Update the inbox test first** — in `ui/screens/shell/tests/bus-inbox.test.mjs`, replace the test `"inbox: notifies once per new pending id with our own kind title; a 403 is a quiet error"` with:

```js
test("inbox: notifies once per new pending id with an opaque key and the pending count, never server text; a 403 is a quiet error", async () => {
  let list = [item()];
  const notes = [];
  const s = inbox.createInboxStore({ approvals: async () => list, notify: (n) => { notes.push(n); } });
  await s.refresh(); await s.refresh();
  assert.deepEqual(notes, [{ key: "7c1d2e3f-0000-4000-8000-0000000000a2", count: 1 }], "once per id");
  list = [item(), item({ id: "7c1d2e3f-0000-4000-8000-0000000000b9", kind: "evil‮" }), item({ id: "7c1d2e3f-0000-4000-8000-0000000000c9" })];
  await s.refresh();
  assert.deepEqual(notes.at(-1), { key: "7c1d2e3f-0000-4000-8000-0000000000b9", count: 3 });
  assert.equal(s.getSnapshot().items.length, 3);
  const denied = inbox.createInboxStore({ approvals: async () => { throw new api.BusCallError(403, "TIER_DENIED"); }, notify: () => assert.fail("no notification") });
  await denied.refresh();
  assert.deepEqual(denied.getSnapshot(), { items: [], error: "TIER_DENIED" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: FAIL (notes hold strings like `"Sync connected sources"`).

- [ ] **Step 3: Change `inbox-store.ts`**

Replace the header comment's first two lines with:

```ts
// The pending bus approvals, polled while the status-bar inbox is mounted. A NEW pending id raises the host's
// `approval_job` notification with that id as an opaque de-dup key and the pending count; the host builds the words.
```

Remove `import { kindTitle } from "./summary";`. Change the `InboxDeps` line to:

```ts
export interface InboxDeps { approvals(): Promise<PendingApproval[]>; notify(info: { key: string; count: number }): void | Promise<void> }
```

Change the notify call inside `refresh` to:

```ts
        try { await d.notify({ key: fresh[0].id, count: items.length }); } catch { /* notifications are best effort */ }
```

Change the default store's `notify` line to:

```ts
  notify: async ({ key, count }) => { if (isHostAvailable()) await invokeHost("notify_user", { kind: "approval_job", key, count }); },
```

- [ ] **Step 4: Run the inbox test to verify it passes**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: PASS.

- [ ] **Step 5: Append the process state and commands to `notify.rs`** (above `#[cfg(test)]`):

```rust
// ---- process state and commands --------------------------------------------------------------------------------

use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

static GATE: Mutex<Option<Gate>> = Mutex::new(None);
static ACTIVE_SECTION: Mutex<&'static str> = Mutex::new("welcome");
static PENDING_ROUTE: Mutex<Option<(&'static str, u64)>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn main_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

/// Shows `kind` unless its switch is off, the user is already looking, or the gate drops it. Ok(true) = shown.
/// No lock is held across a window or notification call.
fn fire(app: &AppHandle, kind: Kind, key: Option<&str>, count: u32) -> Result<bool, String> {
    if !enabled(kind, &crate::prefs::stored().notifications) {
        return Ok(false);
    }
    let focused = main_focused(app);
    let active = *lock(&ACTIVE_SECTION);
    if suppressed(kind, focused, active) {
        return Ok(false);
    }
    let now = crate::confirm::now_ms();
    if !lock(&GATE).get_or_insert_with(Gate::default).admit(kind, key, now) {
        return Ok(false);
    }
    let n = app.notification();
    let mut state = n.permission_state().map_err(|e| e.to_string())?;
    if state == PermissionState::Prompt || state == PermissionState::PromptWithRationale {
        state = n.request_permission().map_err(|e| e.to_string())?;
    }
    if state != PermissionState::Granted {
        return Err("notification permission not granted".into());
    }
    n.builder().title(TITLE).body(kind.body(count)).show().map_err(|e| e.to_string())?;
    if !focused {
        *lock(&PENDING_ROUTE) = Some((kind.route(), now));
    }
    Ok(true)
}

/// A host-side fact (update found, backend down). Failures are logged, never raised.
pub fn fire_host(app: &AppHandle, kind: Kind, key: Option<&str>) {
    if let Err(e) = fire(app, kind, key, 1) {
        eprintln!("notify: {}: {e}", kind.wire());
    }
}

/// The webview names a kind (never text), an optional opaque de-dup key and a count.
#[tauri::command]
pub fn notify_user(app: AppHandle, kind: String, key: Option<String>, count: Option<u32>) -> Result<bool, String> {
    let k = Kind::from_webview(&kind).ok_or("unknown notification kind")?;
    if key.as_deref().is_some_and(|x| !valid_key(x)) {
        return Err("invalid notification key".into());
    }
    fire(&app, k, key.as_deref(), count.unwrap_or(1).min(999))
}

/// The section the main window shows (for "already looking" suppression).
#[tauri::command]
pub fn notify_focus(section: String) -> Result<(), String> {
    *lock(&ACTIVE_SECTION) = section_id(&section).ok_or("unknown section")?;
    Ok(())
}

/// The main window gained focus or the tray opened it: hand a fresh notification's route to the webview once.
pub fn on_main_focused(app: &AppHandle) {
    let route = take_route(&mut lock(&PENDING_ROUTE), crate::confirm::now_ms());
    if let Some(r) = route {
        let _ = app.emit("tray-action", format!("route:{r}"));
    }
}
```

Move the two `use std::collections…` / `use crate::prefs::NotifyPrefs;` lines and these new `use` lines together at the top of the file if `cargo fmt` or clippy asks; behaviour is the same.

- [ ] **Step 6: Strip the template notifications from `tray.rs`**

1. Delete `pub const DETAIL_MAX_CHARS`, `const MIN_NOTIFY_INTERVAL_MS`, `static LAST_NOTIFY_MS`, `fn looks_like_url`, `pub fn sanitize_detail`, `pub fn notification_text`, `fn now_ms`, and the whole `#[tauri::command] pub fn notify`. Remove `AtomicU64` from the atomics import and the `use tauri_plugin_notification::…` line. **Keep** `pub(crate) fn is_invisible_format`: `attach.rs`, `os_open.rs`, `git_scm.rs` and `updater.rs` use it.
2. Replace the module doc's "Notifications:" bullet with: `//! - Notifications live in notify.rs; this module only shows the window and hands it a pending route.`
3. Add after `toggle_main_window`:

```rust
/// Shows, restores and focuses the main window, then hands it a fresh notification's route (notify.rs).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    crate::notify::on_main_focused(app);
}
```

4. In `toggle_main_window`, replace the `else { show; unminimize; set_focus }` branch body with `show_main(app);`, and in `build`'s `on_menu_event`, replace the `"tray_show" => { … }` arm with `"tray_show" => show_main(app),`.
5. In `mod tests`, delete `templates_are_fixed_and_unknown_kinds_rejected`, `detail_is_capped_and_has_no_markup_or_control_chars` and `detail_has_no_bidi_controls_or_links`, and add:

```rust
    #[test]
    fn invisible_format_characters_are_detected() {
        for c in ['\u{202E}', '\u{200B}', '\u{2066}', '\u{FEFF}', '\u{E0041}'] {
            assert!(is_invisible_format(c), "{c:?}");
        }
        for c in ['a', ' ', 'é', '日'] {
            assert!(!is_invisible_format(c), "{c:?}");
        }
    }
```

- [ ] **Step 7: Wire the commands**

`lib.rs` `product_handlers!`: replace `tray::notify,` with:

```rust
                notify::notify_user,
                notify::notify_focus,
```

`lib.rs` `.on_window_event(|window, event| {`: add as the first statement inside the closure:

```rust
            if let tauri::WindowEvent::Focused(true) = event {
                if window.label() == "main" {
                    notify::on_main_focused(window.app_handle());
                }
            }
```

`lib.rs` `app.run(|app_handle, event| match event {`: add before `_ => {}`:

```rust
        // macOS: a Dock click (or an app activation that finds no visible window) brings the hidden window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => tray::show_main(app_handle),
```

`build.rs` `COMMANDS`: replace `"notify",` with `"notify_user",` and `"notify_focus",`.

`capabilities/default.json`: replace `"allow-notify",` with `"allow-notify-user",` and `"allow-notify-focus",`. In `description`, replace `tray + fixed-template notifications (no notification plugin permission)` with `tray + host-built notifications from a fixed kind table (no notification plugin permission)`.

`updater.rs` `check_now`: just before the final `Ok(snapshot())`, add:

```rust
    // One notification per offered version (notify.rs de-duplicates by key).
    if let Some(v) = with(|s| s.pending.as_ref().map(|u| u.version.clone())) {
        crate::notify::fire_host(app, crate::notify::Kind::UpdateReady, Some(&v));
    }
```

- [ ] **Step 8: Run the host checks**

Run: `cd desktop/src-tauri && cargo test notify:: tray:: updater::`
Expected: PASS.
Run: `cd desktop && node scripts/check-capabilities.mjs --product && node --test scripts/check-capabilities.test.mjs`
Expected: exit 0, no problems listed; tests PASS.
Run: `cd desktop/src-tauri && cargo build`
Expected: builds (no "unknown permission allow-notify").

- [ ] **Step 9: Commit**

```bash
git add desktop/src-tauri/src/notify.rs desktop/src-tauri/src/tray.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/build.rs desktop/src-tauri/capabilities/default.json desktop/src-tauri/src/updater.rs ui/screens/shell/approvals/inbox-store.ts ui/screens/shell/tests/bus-inbox.test.mjs
git commit -m "feat(desktop): notify_user and notify_focus replace the template notify command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Tray status, approvals count and quick actions (~35 min)

**Files:**
- Modify: `desktop/src-tauri/src/tray.rs`
- Modify: `desktop/src-tauri/src/capture_host.rs` (after `fn take_active`)
- Modify: `desktop/src-tauri/src/lib.rs` (handlers; `setup` after `tray::setup(app.handle());`)
- Modify: `desktop/src-tauri/build.rs`, `desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `crate::core_host::{CoreHost, Phase}` (`Phase::{Starting, Ready, Restarting, Failed, Stopped}`), `crate::capture_ax_macos::SUPPORTED`, `notify::{fire_host, Kind::CoreDown}`, `tray::show_main`.
- Produces (host command): `tray_report(chat_approvals: u32, job_approvals: u32, sync: String) -> Result<(), String>`. JS args are `{ chatApprovals, jobApprovals, sync }` with `sync` ∈ `"unknown" | "on" | "paused"`.
- Produces (events): `tray-action` payloads `capture_toggle`, `sync_toggle`, `route:chat`, `route:inbox`.
- Produces (Rust): `capture_host::is_recording() -> bool`, `tray::start_watch(app: AppHandle)`, the pure functions `tray::tray_view`, `tray::approvals_route`, `tray::core_went_down` and `tray::count_text`, and `tray::SyncState::parse`.

- [ ] **Step 1: Write the failing tests** — append inside `tray.rs` `mod tests`:

```rust
    use crate::core_host::Phase;

    #[test]
    fn the_status_line_names_the_backend_and_recording_only() {
        assert_eq!(tray_view(Phase::Ready, false, true, 0, 0, SyncState::On).status, "Backend ready");
        assert_eq!(tray_view(Phase::Ready, true, true, 0, 0, SyncState::On).status, "Backend ready · Recording");
        assert_eq!(tray_view(Phase::Failed, false, true, 0, 0, SyncState::On).status, "Backend stopped");
        assert_eq!(tray_view(Phase::Stopped, false, true, 0, 0, SyncState::On).status, "Backend stopped");
        assert_eq!(tray_view(Phase::Restarting, false, true, 0, 0, SyncState::On).status, "Backend restarting");
    }

    #[test]
    fn the_approval_count_shows_in_the_menu_title_and_tooltip() {
        let none = tray_view(Phase::Ready, false, true, 0, 0, SyncState::Unknown);
        assert_eq!((none.approvals.as_str(), none.approvals_enabled, none.title.clone(), none.tooltip.as_str()), ("No approvals waiting", false, None, "LLM-IDE"));
        let one = tray_view(Phase::Ready, false, true, 1, 0, SyncState::Unknown);
        assert_eq!((one.approvals.as_str(), one.title.as_deref()), ("1 approval waiting", Some("1")));
        let many = tray_view(Phase::Ready, false, true, 2, 150, SyncState::Unknown);
        assert_eq!((many.approvals.as_str(), many.title.as_deref(), many.tooltip.as_str()), ("99+ approvals waiting", Some("99+"), "LLM-IDE: 99+ approvals waiting"));
        assert_eq!(approvals_route(1), "chat");
        assert_eq!(approvals_route(0), "inbox");
    }

    #[test]
    fn capture_and_sync_items_follow_their_state() {
        let mac = tray_view(Phase::Ready, false, true, 0, 0, SyncState::On);
        assert_eq!((mac.capture, mac.capture_enabled, mac.sync, mac.sync_enabled), ("Start live capture", true, "Pause sync", true));
        let rec = tray_view(Phase::Ready, true, true, 0, 0, SyncState::Paused);
        assert_eq!((rec.capture, rec.sync), ("Stop live capture", "Resume sync"));
        let other = tray_view(Phase::Ready, false, false, 0, 0, SyncState::Unknown);
        assert_eq!((other.capture, other.capture_enabled, other.sync, other.sync_enabled), ("Live capture (macOS only)", false, "Sync unavailable", false));
        assert_eq!(SyncState::parse("paused"), Some(SyncState::Paused));
        assert_eq!(SyncState::parse("off"), None);
    }

    #[test]
    fn only_an_unexpected_stop_counts_as_down() {
        assert!(core_went_down(Phase::Ready, Phase::Restarting));
        assert!(core_went_down(Phase::Ready, Phase::Failed));
        assert!(core_went_down(Phase::Starting, Phase::Failed));
        assert!(!core_went_down(Phase::Ready, Phase::Stopped), "a user Stop is not news");
        assert!(!core_went_down(Phase::Restarting, Phase::Failed), "already told at Ready -> Restarting");
        assert!(!core_went_down(Phase::Ready, Phase::Ready));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd desktop/src-tauri && cargo test tray::`
Expected: FAIL to compile ("cannot find function `tray_view`").

- [ ] **Step 3: Implement the pure part in `tray.rs`** (new section after the tray settings section):

```rust
// ---- tray view (pure) ---------------------------------------------------------------------------------------------

use crate::core_host::Phase;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncState {
    /// Not set up, signed out, or not readable by this UI.
    Unknown,
    On,
    Paused,
}

impl SyncState {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "unknown" => Some(Self::Unknown),
            "on" => Some(Self::On),
            "paused" => Some(Self::Paused),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayView {
    pub status: String,
    pub approvals: String,
    pub approvals_enabled: bool,
    pub capture: &'static str,
    pub capture_enabled: bool,
    pub sync: &'static str,
    pub sync_enabled: bool,
    /// Text beside the menu-bar icon (macOS, Linux); None hides it.
    pub title: Option<String>,
    pub tooltip: String,
}

pub fn count_text(n: u32) -> String {
    if n > 99 { "99+".into() } else { n.to_string() }
}

pub fn tray_view(core: Phase, recording: bool, capture_supported: bool, chat: u32, jobs: u32, sync: SyncState) -> TrayView {
    let backend = match core {
        Phase::Ready => "Backend ready",
        Phase::Starting => "Backend starting",
        Phase::Restarting => "Backend restarting",
        Phase::Failed | Phase::Stopped => "Backend stopped",
    };
    let status = if recording { format!("{backend} · Recording") } else { backend.to_string() };
    let total = chat.saturating_add(jobs);
    let approvals = match total {
        0 => "No approvals waiting".to_string(),
        1 => "1 approval waiting".to_string(),
        n => format!("{} approvals waiting", count_text(n)),
    };
    let (capture, capture_enabled) = if !capture_supported {
        ("Live capture (macOS only)", false)
    } else if recording {
        ("Stop live capture", true)
    } else {
        ("Start live capture", true)
    };
    let (sync_text, sync_enabled) = match sync {
        SyncState::Unknown => ("Sync unavailable", false),
        SyncState::On => ("Pause sync", true),
        SyncState::Paused => ("Resume sync", true),
    };
    let tooltip = if total == 0 { "LLM-IDE".to_string() } else { format!("LLM-IDE: {approvals}") };
    TrayView {
        status,
        approvals_enabled: total > 0,
        approvals,
        capture,
        capture_enabled,
        sync: sync_text,
        sync_enabled,
        title: (total > 0).then(|| count_text(total)),
        tooltip,
    }
}

/// The approvals line opens Chat when a chat tool waits, else the status-bar inbox.
pub fn approvals_route(chat: u32) -> &'static str {
    if chat > 0 { "chat" } else { "inbox" }
}

/// An unexpected stop: a crash or a failed start. A user Stop and a restart that then fails are not reported twice.
pub fn core_went_down(prev: Phase, next: Phase) -> bool {
    matches!((prev, next), (Phase::Ready, Phase::Restarting | Phase::Failed) | (Phase::Starting, Phase::Failed))
}
```

- [ ] **Step 4: Run the pure tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test tray::`
Expected: PASS.

- [ ] **Step 5: Add `is_recording` to `capture_host.rs`** (after `fn take_active`):

```rust
/// True while a capture runs (the tray's status line and Start/Stop item).
pub fn is_recording() -> bool {
    ACTIVE.lock().map(|g| g.is_some()).unwrap_or(false)
}
```

- [ ] **Step 6: Build the live tray in `tray.rs`**

Add to the imports: `use std::sync::atomic::AtomicU32;`, `use std::time::Duration;`, `use tauri::Emitter;`. Add the statics next to the others:

```rust
static CHAT_PENDING: AtomicU32 = AtomicU32::new(0);
static JOB_PENDING: AtomicU32 = AtomicU32::new(0);
static SYNC: Mutex<SyncState> = Mutex::new(SyncState::Unknown);
static ITEMS: Mutex<Option<Items>> = Mutex::new(None);
static LAST_VIEW: Mutex<Option<TrayView>> = Mutex::new(None);
const WATCH_EVERY: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct Items {
    status: MenuItem<Wry>,
    approvals: MenuItem<Wry>,
    capture: MenuItem<Wry>,
    sync: MenuItem<Wry>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
```

Add the live functions:

```rust
/// Pushes a changed view to the menu and the icon. Locks are released before any menu call (they may wait for the
/// main thread, which runs sync commands).
fn apply(app: &AppHandle, v: &TrayView) {
    let items = lock(&ITEMS).clone();
    if let Some(i) = items {
        let _ = i.status.set_text(&v.status);
        let _ = i.approvals.set_text(&v.approvals);
        let _ = i.approvals.set_enabled(v.approvals_enabled);
        let _ = i.capture.set_text(v.capture);
        let _ = i.capture.set_enabled(v.capture_enabled);
        let _ = i.sync.set_text(v.sync);
        let _ = i.sync.set_enabled(v.sync_enabled);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(v.title.as_deref());
        let _ = tray.set_tooltip(Some(&v.tooltip));
    }
}

/// Recomputes the view from the host's in-memory state; applies it only when it changed. Returns the core phase.
pub fn refresh(app: &AppHandle) -> Phase {
    let phase = app.state::<crate::core_host::CoreHost>().status().state;
    let sync = *lock(&SYNC);
    let v = tray_view(phase, crate::capture_host::is_recording(), crate::capture_ax_macos::SUPPORTED, CHAT_PENDING.load(Ordering::Relaxed), JOB_PENDING.load(Ordering::Relaxed), sync);
    let changed = {
        let mut last = lock(&LAST_VIEW);
        if last.as_ref() == Some(&v) { false } else { *last = Some(v.clone()); true }
    };
    if changed {
        apply(app, &v);
    }
    phase
}

/// The webview's counts and sync state (it owns the session and the polls that know them).
#[tauri::command]
pub fn tray_report(app: AppHandle, chat_approvals: u32, job_approvals: u32, sync: String) -> Result<(), String> {
    let s = SyncState::parse(&sync).ok_or("unknown sync state")?;
    CHAT_PENDING.store(chat_approvals.min(999), Ordering::Relaxed);
    JOB_PENDING.store(job_approvals.min(999), Ordering::Relaxed);
    *lock(&SYNC) = s;
    refresh(&app);
    Ok(())
}

/// core_host and capture_host keep their state in memory and raise no change event, so one thread reads both every
/// 2 s (no IO) to keep the tray in step and to notice the backend going down. It runs without a tray too.
pub fn start_watch(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("llmide-tray-watch".into()).spawn(move || {
        let mut prev = Phase::Starting;
        loop {
            let phase = refresh(&app);
            if core_went_down(prev, phase) {
                crate::notify::fire_host(&app, crate::notify::Kind::CoreDown, None);
            }
            prev = phase;
            std::thread::sleep(WATCH_EVERY);
        }
    });
    if let Err(e) = spawned {
        eprintln!("tray: status watcher not started: {e}");
    }
}
```

In `fn build`, replace the item and menu construction with:

```rust
    let status = MenuItem::with_id(app, "tray_status", "Backend starting", false, None::<&str>)?;
    let approvals = MenuItem::with_id(app, "tray_approvals", "No approvals waiting", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray_show", "Show window", true, None::<&str>)?;
    let project = MenuItem::with_id(app, "tray_project", NO_PROJECT_LABEL, false, None::<&str>)?;
    let capture = MenuItem::with_id(app, "tray_capture", "Start live capture", false, None::<&str>)?;
    let sync = MenuItem::with_id(app, "tray_sync", "Sync unavailable", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &approvals, &sep1, &show, &project, &capture, &sync, &sep2, &quit])?;
    if let Ok(mut g) = PROJECT_ITEM.lock() {
        *g = Some(project);
    }
    *lock(&ITEMS) = Some(Items { status, approvals, capture, sync });
```

and replace the `on_menu_event` closure's match with:

```rust
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main(app),
            "tray_approvals" => {
                show_main(app);
                let _ = app.emit("tray-action", format!("route:{}", approvals_route(CHAT_PENDING.load(Ordering::Relaxed))));
            }
            "tray_capture" => {
                show_main(app);
                let _ = app.emit("tray-action", "capture_toggle");
            }
            "tray_sync" => {
                let _ = app.emit("tray-action", "sync_toggle");
            }
            "tray_quit" => app.exit(0),
            _ => {}
        })
```

Update the module doc's first bullet to: `//! - Tray menu: backend status (+ "Recording"), approvals waiting, Show window, the active project (label), Start/Stop live capture, Pause/Resume sync, Quit. The count also shows beside the menu-bar icon (macOS, Linux) and in the tooltip.`

- [ ] **Step 7: Wire it**

`lib.rs` `product_handlers!`: after `tray::tray_set_icon_visible,` add `tray::tray_report,`. In `setup`, after `tray::setup(app.handle());` add `tray::start_watch(app.handle().clone());`.
`build.rs` `COMMANDS`: after `"tray_set_icon_visible",` add `"tray_report",`.
`capabilities/default.json`: after `"allow-tray-set-icon-visible",` add `"allow-tray-report",`.

- [ ] **Step 8: Run the host checks**

Run: `cd desktop/src-tauri && cargo test tray:: capture_host::`
Expected: PASS.
Run: `cd desktop && node scripts/check-capabilities.mjs --product`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add desktop/src-tauri/src/tray.rs desktop/src-tauri/src/capture_host.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/build.rs desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): tray status, approvals count and quick actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The core records `sync_attention` when sync turns itself off (~15 min)

**Files:**
- Modify: `extension/kb/activity.mjs` (`ACTIVITY_KINDS`, ~line 12)
- Modify: `extension/routes/sync/scheduler.mjs` (imports; `recordCycleFailure`, ~line 110)
- Test: `extension/tests/sync-routes.test.mjs`

**Interfaces:**
- Consumes: `recordActivity({ userId, kind, title, detail })`, `listActivity(userId, opts)` from `extension/kb/activity.mjs`.
- Produces: an activity row `kind: "sync_attention"`, title `Sync was turned off and needs your attention in Settings`, `detail: { code }`. It is written once for each setup failure (`SYNC_AUTH_FAILED`, `SYNC_MFA_REQUIRED`, `SYNC_HOST_KEY_CHANGED`), never for a transient one. The webview (Task 6) reads `sync_attention` and `sync_device_removed`.

- [ ] **Step 1: Write the failing test** — in `extension/tests/sync-routes.test.mjs`, add `const { listActivity } = await import('../kb/activity.mjs');` after the other imports, and add:

```js
test('a setup failure records one sync_attention activity row with no account or host in it; a transient one records none', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
  st.setSyncEnabled(u, true);
  const backoff = new Map();
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_UNREACHABLE' }), { now: 1000, backoff });
  assert.equal(listActivity(u, {}).filter((r) => r.kind === 'sync_attention').length, 0);
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_CHANGED' }), { now: 2000, backoff });
  const rows = listActivity(u, {}).filter((r) => r.kind === 'sync_attention');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Sync was turned off and needs your attention in Settings');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/sync-routes.test.mjs`
Expected: FAIL (`rows.length` is 0).

- [ ] **Step 3: Implement**

In `extension/kb/activity.mjs` `ACTIVITY_KINDS`, after `'sync_device_removed',` add `'sync_attention',`.
In `extension/routes/sync/scheduler.mjs`, add `import { recordActivity } from '../../kb/activity.mjs';` after the `sync-state.mjs` import. In `recordCycleFailure`, inside `if (SETUP_ERRORS.has(code)) {`, after `setSyncEnabled(userId, false);` add:

```js
    // The desktop turns this row into a generic "Sync needs your attention" notification; the code says why.
    recordActivity({ userId, kind: 'sync_attention', title: 'Sync was turned off and needs your attention in Settings', detail: { code } });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/sync-routes.test.mjs tests/sync-registry.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/kb/activity.mjs extension/routes/sync/scheduler.mjs extension/tests/sync-routes.test.mjs
git commit -m "feat(server): record a sync_attention activity when sync turns itself off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Notification and tray bridge in the shell (~35 min)

**Files:**
- Create: `ui/screens/shell/notify/notify.ts`, `ui/screens/shell/notify/bridge.ts`
- Modify: `ui/screens/shell/bus.ts` (`ShellEvent`, `STICKY`)
- Test: `ui/screens/shell/tests/notify.test.mjs`

**Interfaces:**
- Consumes: host commands `notify_user`, `notify_focus`, `tray_report` and the event `tray-action` (Tasks 3-4); `SECTIONS` / `SectionId` (`ui/screens/shell/sections.ts`); `NotifyPrefs` (Task 1); `ShellEvent` (`bus.ts`).
- Produces (`notify.ts`): `type Invoke`, `defaultInvoke`, `WEBVIEW_KINDS`, `type NotifyKind`, `type TaskSource = "loop" | "autotask" | "graph" | "docgen"`, `taskKind(source, ok)`, `notifyUser(kind, { key?, count? }?, invoke?)`, `notifyTask(source, ok)`, `reportSection(section, invoke?)`, `type TrayAction`, `trayAction(payload)`, `type SyncReport`, `syncReport(status)`, `SYNC_ACTIVITY_KINDS`, `syncAlerts(items, sinceId)`, `generationEnded(prev, next)`, `NOTIFY_SWITCHES`, `trayNote(rawTrayStatus)`.
- Produces (`bridge.ts`): `interface BridgeDeps`, `installNotifyBridge(deps): () => void`.
- Produces (`bus.ts`): `ShellEvent` member `{ type: "live-capture" }` (sticky).

- [ ] **Step 1: Write the failing test** — create `ui/screens/shell/tests/notify.test.mjs`:

```js
// The webview side of notifications and the tray: pure helpers, drift checks against the Rust tables, and the bridge
// with fake stores. The host side has its own tests (desktop/src-tauri/src/notify.rs, tray.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load, SHELL } from "./helpers.mjs";

const REPO = resolve(SHELL, "../../..");
const n = await load("notify/notify.ts");
const b = await load("notify/bridge.ts");
const sec = await load("sections.ts");
const bus = await load("bus.ts");
const notifyRs = readFileSync(join(REPO, "desktop/src-tauri/src/notify.rs"), "utf8");
const prefsRs = readFileSync(join(REPO, "desktop/src-tauri/src/prefs.rs"), "utf8");

test("the webview kinds are exactly the Rust table minus the host-only kinds", () => {
  const wireFn = notifyRs.slice(notifyRs.indexOf("pub fn wire"), notifyRs.indexOf("pub fn from_webview"));
  const rust = [...wireFn.matchAll(/Kind::\w+ => "([a-z_]+)"/g)].map((m) => m[1]).filter((k) => k !== "update_ready" && k !== "core_down");
  assert.deepEqual([...n.WEBVIEW_KINDS].sort(), rust.sort());
  for (const s of ["loop", "autotask", "graph", "docgen"]) for (const ok of [true, false]) assert.ok(n.WEBVIEW_KINDS.includes(n.taskKind(s, ok)));
});

test("the host's section list matches the shell's", () => {
  const list = notifyRs.match(/pub const SECTIONS: \[&str; \d+\] = \[([^\]]*)\]/)[1];
  assert.deepEqual([...list.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort(), sec.SECTIONS.map((s) => s.id).sort());
});

test("the Settings switches are exactly the Rust NotifyPrefs fields", () => {
  const body = prefsRs.match(/pub struct NotifyPrefs \{([\s\S]*?)\}/)[1];
  assert.deepEqual([...body.matchAll(/pub (\w+):/g)].map((m) => m[1]).sort(), n.NOTIFY_SWITCHES.map((s) => s.key).sort());
});

test("tray actions: only fixed payloads and known sections pass", () => {
  assert.deepEqual(n.trayAction("capture_toggle"), { type: "capture" });
  assert.deepEqual(n.trayAction("sync_toggle"), { type: "sync" });
  assert.deepEqual(n.trayAction("route:inbox"), { type: "inbox" });
  assert.deepEqual(n.trayAction("route:loop"), { type: "goto", section: "loop" });
  assert.deepEqual(n.trayAction("route:settings:updates"), { type: "goto", section: "settings", anchor: "updates" });
  for (const bad of ["route:nowhere", "route:../x", "route:settings:a:b", "route:settings:Bad Anchor", "route:inbox:x", "open", 3, null, `route:${"a".repeat(90)}`]) assert.equal(n.trayAction(bad), null, String(bad));
});

test("sync report, sync alerts and generation ends", () => {
  assert.equal(n.syncReport(null), "unknown");
  assert.equal(n.syncReport({ configured: false, enabled: false }), "unknown");
  assert.equal(n.syncReport({ configured: true, enabled: true }), "on");
  assert.equal(n.syncReport({ configured: true, enabled: false }), "paused");
  assert.deepEqual(n.syncAlerts([{ id: 7, kind: "sync_attention" }, { id: 6, kind: "loop_engineering_done" }, { id: 4, kind: "sync_device_removed" }], 5), { ids: [7], lastId: 7 });
  assert.deepEqual(n.syncAlerts([], 5), { ids: [], lastId: 5 });
  assert.equal(n.generationEnded("generating", "done"), true);
  assert.equal(n.generationEnded("reading", "error"), false);
  assert.equal(n.generationEnded("generating", "idle"), null, "a cancel is not news");
  assert.equal(n.generationEnded("done", "done"), null);
});

test("notifyUser sends a kind, an opaque key and a count, never text", async () => {
  const calls = [];
  await n.notifyUser("approval_chat", { count: 2 }, async (cmd, args) => { calls.push([cmd, args]); });
  await n.notifyUser("loop_done", {}, async () => { throw new Error("permission"); });
  assert.deepEqual(calls, [["notify_user", { kind: "approval_chat", key: null, count: 2 }]]);
  assert.equal(n.trayNote({ available: true }), null);
  assert.match(n.trayNote({ available: false }), /libayatana-appindicator3-1/);
});

test("live-capture is sticky so a late Live screen still gets the tray's request", () => {
  const sb = bus.createShellBus(() => 0);
  sb.publish({ type: "live-capture" });
  assert.deepEqual(sb.takePending("live-capture"), { type: "live-capture" });
  assert.equal(sb.takePending("live-capture"), null);
});

function store(v) {
  const ls = new Set();
  return { getSnapshot: () => v, subscribe: (l) => { ls.add(l); return () => ls.delete(l); }, set(next) { v = next; for (const l of [...ls]) l(); } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("bridge: approvals, sync alerts and tray actions", async () => {
  const calls = [];
  const published = [];
  let emit = null;
  let opened = 0;
  const chat = store(0);
  const inbox = store({ items: [] });
  const activity = store({ loaded: true, feed: { lastId: 5, items: [] } });
  const session = store({ signedIn: true });
  let syncOn = true;
  const off = b.installNotifyBridge({
    invoke: async (cmd, args) => { calls.push([cmd, args]); return null; },
    listen: async (_event, cb) => { emit = cb; return () => {}; },
    chatApprovals: chat, inbox, activity, session,
    syncStatus: async () => ({ configured: true, enabled: syncOn }),
    setSyncEnabled: async (on) => { syncOn = on; return { configured: true, enabled: on }; },
    publish: (ev) => published.push(ev),
    openInbox: () => { opened += 1; },
  });
  await tick();
  assert.deepEqual(calls.filter(([c]) => c === "tray_report").at(-1)[1], { chatApprovals: 0, jobApprovals: 0, sync: "on" });

  chat.set(1); await tick();
  assert.deepEqual(calls.filter(([c]) => c === "notify_user").at(-1)[1], { kind: "approval_chat", key: null, count: 1 });
  chat.set(0); chat.set(0); await tick();
  assert.equal(calls.filter(([c]) => c === "notify_user").length, 1, "a falling count never notifies");
  const reports = calls.filter(([c]) => c === "tray_report").length;
  inbox.set({ items: [] }); await tick();
  assert.equal(calls.filter(([c]) => c === "tray_report").length, reports, "an unchanged report is not resent");
  inbox.set({ items: [{}, {}] }); await tick();
  assert.equal(calls.filter(([c]) => c === "tray_report").at(-1)[1].jobApprovals, 2);

  activity.set({ loaded: true, feed: { lastId: 6, items: [{ id: 6, kind: "sync_attention" }] } }); await tick();
  assert.deepEqual(calls.filter(([c]) => c === "notify_user").at(-1)[1], { kind: "sync_attention", key: "activity:6", count: null });

  emit("route:settings:updates");
  emit("route:inbox");
  emit("capture_toggle");
  emit("route:../evil");
  assert.deepEqual(published, [{ type: "goto-section", section: "settings", anchor: "updates" }, { type: "goto-section", section: "live" }, { type: "live-capture" }]);
  assert.equal(opened, 1);
  emit("sync_toggle"); await tick(); await tick();
  assert.equal(syncOn, false);
  assert.equal(calls.filter(([c]) => c === "tray_report").at(-1)[1].sync, "paused");

  session.set({ signedIn: false }); await tick();
  assert.equal(calls.filter(([c]) => c === "tray_report").at(-1)[1].sync, "unknown", "signed out: sync unavailable");
  off();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/notify.test.mjs`
Expected: FAIL (esbuild cannot resolve `notify/notify.ts`).

- [ ] **Step 3: Add the sticky bus event** — in `ui/screens/shell/bus.ts`, add to `ShellEvent` after the `project-changed` member:

```ts
  /** Start or stop live capture (the tray's quick action); the Live screen toggles its own Start/Stop. */
  | { type: "live-capture" };
```

(move the trailing `;` from the `project-changed` line), and change `STICKY` to `new Set<ShellEventType>(["open-file", "goto-section", "live-capture"])`.

- [ ] **Step 4: Create `ui/screens/shell/notify/notify.ts`**

```ts
// Native notifications and the tray, webview side. The HOST builds every word a notification shows from a fixed
// table (desktop/src-tauri/src/notify.rs). This side names only a kind, an opaque de-dup key and a count, so chat
// text, paths, captions, tokens and device names cannot reach a notification. Pure helpers; wiring is in bridge.ts.
import { invokeHost, isHostAvailable } from "../host";
import type { NotifyPrefs } from "../host-prefs";
import { SECTIONS, type SectionId } from "../sections";

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The host bridge, or a no-op outside the desktop app (plain browser, tests). */
export const defaultInvoke: Invoke = (cmd, args) => (isHostAvailable() ? invokeHost<unknown>(cmd, args) : Promise.resolve(null));

/** Kinds the webview may raise (`Kind::from_webview` in notify.rs; a test keeps both lists in step). */
export const WEBVIEW_KINDS = [
  "approval_chat", "approval_job", "loop_done", "loop_failed", "autotask_done", "autotask_failed",
  "graph_done", "graph_failed", "docgen_done", "docgen_failed", "sync_attention",
] as const;
export type NotifyKind = (typeof WEBVIEW_KINDS)[number];
export type TaskSource = "loop" | "autotask" | "graph" | "docgen";

export const taskKind = (source: TaskSource, ok: boolean): NotifyKind => `${source}_${ok ? "done" : "failed"}` as NotifyKind;

/** Best effort: no host, a switched-off category, a refused permission or a missing notification daemon is silent. */
export async function notifyUser(kind: NotifyKind, opts: { key?: string; count?: number } = {}, invoke: Invoke = defaultInvoke): Promise<void> {
  try {
    await invoke("notify_user", { kind, key: opts.key ?? null, count: opts.count ?? null });
  } catch {
    // best effort
  }
}

/** A long task ended (Loop, Auto Task, Graph, Doc Gen). */
export const notifyTask = (source: TaskSource, ok: boolean): Promise<void> => notifyUser(taskKind(source, ok));

/** Tells the host which section the window shows (no notification for the place the user is looking at). */
export async function reportSection(section: SectionId, invoke: Invoke = defaultInvoke): Promise<void> {
  try {
    await invoke("notify_focus", { section });
  } catch {
    // best effort
  }
}

export type TrayAction = { type: "capture" } | { type: "sync" } | { type: "inbox" } | { type: "goto"; section: SectionId; anchor?: string };

const IDS: ReadonlySet<string> = new Set(SECTIONS.map((s) => s.id));
const ANCHOR = /^[a-z][a-z0-9-]{0,40}$/;

/** A `tray-action` payload from the host -> what the shell does; anything else is ignored. */
export function trayAction(payload: unknown): TrayAction | null {
  if (payload === "capture_toggle") return { type: "capture" };
  if (payload === "sync_toggle") return { type: "sync" };
  if (typeof payload !== "string" || payload.length > 80 || !payload.startsWith("route:")) return null;
  const [section, anchor, extra] = payload.slice("route:".length).split(":");
  if (section === "inbox") return anchor === undefined ? { type: "inbox" } : null;
  if (!IDS.has(section) || extra !== undefined || (anchor !== undefined && !ANCHOR.test(anchor))) return null;
  return anchor === undefined ? { type: "goto", section: section as SectionId } : { type: "goto", section: section as SectionId, anchor };
}

export type SyncReport = "unknown" | "on" | "paused";

/** The tray's sync item from a decoded `/kb/sync/status` (null = unavailable). */
export const syncReport = (s: { configured: boolean; enabled: boolean } | null): SyncReport => (!s || !s.configured ? "unknown" : s.enabled ? "on" : "paused");

/** Activity kinds that mean "sync needs the user" (extension/kb/activity.mjs). */
export const SYNC_ACTIVITY_KINDS: ReadonlySet<string> = new Set(["sync_attention", "sync_device_removed"]);

/** New sync rows after `sinceId`, and the new high-water mark. */
export function syncAlerts(items: readonly { id: number; kind: string | null }[], sinceId: number): { ids: number[]; lastId: number } {
  const fresh = items.filter((i) => i.id > sinceId);
  return {
    ids: fresh.filter((i) => i.kind !== null && SYNC_ACTIVITY_KINDS.has(i.kind)).map((i) => i.id),
    lastId: fresh.reduce((m, i) => Math.max(m, i.id), sinceId),
  };
}

/** A Doc Gen run's end from two phases: true = done, false = failed, null = not an end (a cancel goes to idle). */
export function generationEnded(prev: string, next: string): boolean | null {
  if (prev !== "generating" && prev !== "reading") return null;
  return next === "done" ? true : next === "error" ? false : null;
}

/** The Settings card's switches (keys = desktop prefs::NotifyPrefs fields; a test keeps them in step). */
export const NOTIFY_SWITCHES: ReadonlyArray<{ key: keyof NotifyPrefs; label: string; hint: string }> = [
  { key: "approvals", label: "Approvals waiting", hint: "A tool in Chat, or a job from your phone, the web app or a schedule, waits for you." },
  { key: "tasks", label: "Long tasks finished", hint: "A Loop run, an Auto Task, a code graph generation or a Doc Gen document finished or failed." },
  { key: "sync", label: "Sync needs attention", hint: "Sync turned itself off (login or server identity problem) or removed a device." },
  { key: "updates", label: "Update available", hint: "A signed LLM-IDE update can be installed." },
  { key: "core", label: "Backend stopped", hint: "The local backend stopped unexpectedly." },
];

/** The tray-missing note for a `tray_status` answer, or null when the tray works. */
export function trayNote(raw: unknown): string | null {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!r || r.available !== false) return null;
  return "The menu-bar / tray icon is not available on this desktop, so approvals and status show only in the window. On Linux, install libayatana-appindicator3-1; on GNOME, also enable the AppIndicator extension, then restart LLM-IDE.";
}
```

- [ ] **Step 5: Create `ui/screens/shell/notify/bridge.ts`**

```ts
// Wires the shell's stores to the host's notifications and tray: approval counts -> `tray_report` and the
// `approval_chat` notification, new sync activity rows -> `sync_attention`, the host's `tray-action` events ->
// navigation, Live capture and the sync switch. No timer of its own: it rides the inbox and activity polls.
import type { ShellEvent } from "../bus";
import { notifyUser, syncAlerts, syncReport, trayAction, type Invoke, type SyncReport } from "./notify";

export interface Store<S> { getSnapshot(): S; subscribe(l: () => void): () => void }
type SyncStatus = { configured: boolean; enabled: boolean } | null;

export interface BridgeDeps {
  invoke: Invoke;
  /** Subscribe to a host event; resolves to the unsubscribe function. */
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;
  chatApprovals: Store<number>;
  inbox: Store<{ items: readonly unknown[] }>;
  activity: Store<{ loaded: boolean; feed: { lastId: number; items: readonly { id: number; kind: string | null }[] } }>;
  session: Store<{ signedIn: boolean }>;
  /** GET /kb/sync/status, decoded (throws when unavailable). */
  syncStatus(): Promise<SyncStatus>;
  setSyncEnabled(on: boolean): Promise<SyncStatus>;
  publish(ev: ShellEvent): void;
  openInbox(): void;
}

export function installNotifyBridge(d: BridgeDeps): () => void {
  let chat = d.chatApprovals.getSnapshot();
  let sync: SyncReport = "unknown";
  let sent = "";
  const a0 = d.activity.getSnapshot();
  let since: number | null = a0.loaded ? a0.feed.lastId : null;
  let signedIn = d.session.getSnapshot().signedIn;
  let gone = false;
  let offListen: (() => void) | null = null;

  const report = () => {
    const args = { chatApprovals: d.chatApprovals.getSnapshot(), jobApprovals: d.inbox.getSnapshot().items.length, sync };
    const key = JSON.stringify(args);
    if (key === sent) return;
    sent = key;
    d.invoke("tray_report", args).catch(() => { sent = ""; });
  };
  const readSync = async (p: Promise<SyncStatus>) => {
    try { sync = syncReport(await p); } catch { sync = "unknown"; }
    if (!gone) report();
  };

  const offChat = d.chatApprovals.subscribe(() => {
    const next = d.chatApprovals.getSnapshot();
    if (next > chat) void notifyUser("approval_chat", { count: next }, d.invoke);
    chat = next;
    report();
  });
  const offInbox = d.inbox.subscribe(report);
  const offActivity = d.activity.subscribe(() => {
    const s = d.activity.getSnapshot();
    if (!s.loaded) return;
    if (since === null) { since = s.feed.lastId; return; } // rows that existed before this launch never notify
    const a = syncAlerts(s.feed.items, since);
    since = a.lastId;
    if (a.ids.length) {
      void notifyUser("sync_attention", { key: `activity:${a.ids[a.ids.length - 1]}` }, d.invoke);
      void readSync(d.syncStatus());
    }
  });
  const offSession = d.session.subscribe(() => {
    const now = d.session.getSnapshot().signedIn;
    if (now === signedIn) return;
    signedIn = now;
    if (now) void readSync(d.syncStatus());
    else { sync = "unknown"; report(); }
  });

  d.listen("tray-action", (payload) => {
    const a = trayAction(payload);
    if (!a) return;
    if (a.type === "capture") { d.publish({ type: "goto-section", section: "live" }); d.publish({ type: "live-capture" }); }
    else if (a.type === "sync") { if (sync !== "unknown") void readSync(d.setSyncEnabled(sync !== "on")); }
    else if (a.type === "inbox") d.openInbox();
    else d.publish(a.anchor === undefined ? { type: "goto-section", section: a.section } : { type: "goto-section", section: a.section, anchor: a.anchor });
  }).then((un) => { if (gone) un(); else offListen = un; }, () => undefined);

  if (signedIn) void readSync(d.syncStatus());
  report();
  return () => { gone = true; offChat(); offInbox(); offActivity(); offSession(); offListen?.(); };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/notify.test.mjs ../ui/screens/shell/tests/bus-paths.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/screens/shell/notify/notify.ts ui/screens/shell/notify/bridge.ts ui/screens/shell/bus.ts ui/screens/shell/tests/notify.test.mjs
git commit -m "feat(ui): notification and tray bridge in the shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Raise task, approval and capture events from the screens (~30 min)

**Files:**
- Modify: `ui/screens/shell/Shell.tsx` (imports; effects after the `app-menu` effect, ~line 253)
- Modify: `ui/screens/shell/approvals/BusInbox.tsx` (after the `inboxStore.start()` effect)
- Modify: `ui/screens/live/LiveScreen.tsx` (`LiveDeps`; after the `const stop=useCallback(` line)
- Modify: `ui/screens/live/index.tsx` (deps object)
- Modify: `ui/screens/loop/native/NativeLoopScreen.tsx` (`executeLoop`, ~lines 660-668)
- Modify: `ui/screens/autotasks/native/NativeAutoTasksScreen.tsx` (`runTask` ~188-192, `runCustom` ~254-258)
- Modify: `ui/screens/graph/index.tsx` (~line 43)
- Modify: `ui/screens/docgen/section.tsx` (`storeFor`, ~line 35)

**Interfaces:**
- Consumes: `installNotifyBridge`, `BridgeDeps` (Task 6); `notifyTask`, `reportSection`, `generationEnded` (Task 6); `decodeSyncStatus` (`ui/screens/settings/sync-model.ts`, read only); `inboxStore` (`approvals/inbox-store.ts`), `activityStore` and `core` (`runtime.ts`), `chatApprovalStore` (`chat-approvals.ts`); `shellBus.takePending("live-capture")`.
- Produces: `LiveDeps.onToggleRequest?(run: () => void): () => void`; the window event `llmide:open-inbox` opens the status-bar inbox.

- [ ] **Step 1: Shell wiring** — in `Shell.tsx`, change the runtime import to `import { activityStore, core, coreStatusStore, trustGate } from "./runtime";` and add:

```ts
import { inboxStore } from "./approvals/inbox-store";
import { decodeSyncStatus } from "../settings/sync-model.ts";
import { installNotifyBridge } from "./notify/bridge";
import { reportSection } from "./notify/notify";
```

After the `app-menu` `useEffect`, add:

```tsx
  // Notifications and the tray (desktop only): counts and sync state to the host, tray actions back to the shell.
  useEffect(() => {
    if (!shellHost.isAvailable()) return undefined;
    return installNotifyBridge({
      invoke: (cmd, args) => invokeHost<unknown>(cmd, args),
      listen: (event, cb) => import("@tauri-apps/api/event").then(({ listen }) => listen<unknown>(event, (ev) => cb(ev.payload))),
      chatApprovals: { getSnapshot: chatApprovalStore.get, subscribe: chatApprovalStore.subscribe },
      inbox: inboxStore,
      activity: activityStore,
      session: core,
      syncStatus: async () => decodeSyncStatus(await core.request("/kb/sync/status")),
      setSyncEnabled: async (on) => decodeSyncStatus(await core.request("/kb/sync/enabled", { method: "POST", body: { enabled: on } })),
      publish: (ev) => shellBus.publish(ev),
      openInbox: () => globalThis.dispatchEvent?.(new Event("llmide:open-inbox")),
    });
  }, []);
  useEffect(() => { if (shellHost.isAvailable()) void reportSection(nav.active); }, [nav.active]);
```

- [ ] **Step 2: Inbox opens on request** — in `BusInbox.tsx`, after the effect that calls `inboxStore.start()`, add:

```tsx
  // The tray's approvals line and an approval notification's click open this inbox.
  useEffect(() => {
    const show = () => setOpen(true);
    globalThis.addEventListener?.("llmide:open-inbox", show);
    return () => globalThis.removeEventListener?.("llmide:open-inbox", show);
  }, []);
```

- [ ] **Step 3: Live toggle** — in `LiveScreen.tsx`, change the `LiveDeps` interface line to end with `indexNote?(note: FinalizedNote): Promise<"indexed" | "skipped" | "failed">; /** The tray's Start/Stop: register a toggle; returns the unsubscribe. */ onToggleRequest?(run: () => void): () => void }`. Directly after the line that begins ` const stop=useCallback(`, insert:

```tsx
 const toggleRef=useRef<(()=>void)|null>(null);
 toggleRef.current=phase==="recording"?()=>void stop():phase==="idle"||phase==="done"?()=>void start():null;
 useEffect(()=>deps.onToggleRequest?.(()=>toggleRef.current?.()),[deps]);
```

In `ui/screens/live/index.tsx`, add this property to the `deps` object, after `onRecordingChange: setLiveRecording,`:

```ts
    onToggleRequest: (run) => {
      if (shellBus.takePending("live-capture")) run(); // the tray asked before this screen mounted
      return shellBus.subscribe("live-capture", () => { shellBus.takePending("live-capture"); run(); });
    },
```

- [ ] **Step 4: Loop** — in `NativeLoopScreen.tsx` add `import { notifyTask } from "../../shell/notify/notify";`. In `executeLoop`, right after the `setNotice(outcome.cancelled ? … : outcome.statusSummary);` line, add:

```ts
      if (!outcome.cancelled) void notifyTask("loop", outcome.passed);
```

and in its `catch (e) {` block, after `setNotice(…"The loop could not run.");`, add `void notifyTask("loop", false);`.

- [ ] **Step 5: Auto Tasks** — in `NativeAutoTasksScreen.tsx` add `import { notifyTask } from "../../shell/notify/notify";`. In `runTask`: after `setNotice(ok ? \`${t.label} completed.\` : \`${t.label} did not complete.\`);` add `void notifyTask("autotask", ok);`. In its catch, after `setNotice(e instanceof Error ? e.message : "The task could not run.");` add `void notifyTask("autotask", false);`. In `runCustom`: after the `setNotice(result.ok ? …)` line add `void notifyTask("autotask", result.ok);`. In its catch, after `setNotice(e instanceof Error ? e.message : "The custom task could not run.");` add `void notifyTask("autotask", false);`.

- [ ] **Step 6: Graph** — in `ui/screens/graph/index.tsx` add `import { notifyTask } from "../shell/notify/notify";` and replace the `onGenerate` prop with:

```tsx
      onGenerate={async (mode, target) => {
        try { await invokeHost("graph_generate", { mode, target: target || null }); void notifyTask("graph", true); }
        catch (e) { void notifyTask("graph", false); throw e; }
      }}
```

- [ ] **Step 7: Doc Gen** — in `ui/screens/docgen/section.tsx` add `import { generationEnded, notifyTask } from "../shell/notify/notify";`. In `storeFor`, after `stores.set(surface, s);`, add:

```ts
    if (surface === "doc") {
      // Doc Gen only: a Visual generation stays silent (decision D5).
      const run = s.run;
      let prev: string = run.getSnapshot().phase;
      run.subscribe(() => {
        const next = run.getSnapshot().phase;
        const ended = generationEnded(prev, next);
        prev = next;
        if (ended !== null) void notifyTask("docgen", ended);
      });
    }
```

- [ ] **Step 8: Typecheck and run the affected suites**

Run: `cd desktop && npx tsc --noEmit`
Expected: no errors.
Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/*.test.mjs ../ui/screens/live/tests/*.test.* ../ui/screens/loop/tests/*.test.* ../ui/screens/autotasks/tests/*.test.* ../ui/screens/graph/tests/*.test.* ../ui/screens/docgen/tests/*.test.*`
Expected: PASS (no test regressions; existing Live tests render without `onToggleRequest`).

- [ ] **Step 9: Commit**

```bash
git add ui/screens/shell/Shell.tsx ui/screens/shell/approvals/BusInbox.tsx ui/screens/live/LiveScreen.tsx ui/screens/live/index.tsx ui/screens/loop/native/NativeLoopScreen.tsx ui/screens/autotasks/native/NativeAutoTasksScreen.tsx ui/screens/graph/index.tsx ui/screens/docgen/section.tsx
git commit -m "feat(ui): raise task, approval and capture events from the screens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Notifications card in Settings > General (~20 min)

**Files:**
- Create: `ui/screens/shell/notify/NotificationsCard.tsx`, `ui/screens/shell/notify/register-card.ts`
- Modify: `ui/screens/settings/index.tsx` (**one import line**, after the existing imports)
- Test: `ui/screens/shell/tests/notify.test.mjs` (add a render test)

**Interfaces:**
- Consumes: `NOTIFY_SWITCHES`, `trayNote` (Task 6); `decodePrefsView`, `NotifyPrefs` (`host-prefs.ts`, Task 1); host commands `get_prefs`, `set_prefs` (`{ patch: { notifications: NotifyPrefs } }`), `tray_status`; `Switch`, `ErrorText` from `ui/screens/settings/ui.tsx` (read only); `settingsRegistry.registerCard` (`ui/screens/settings/registry-default.ts`).
- Produces: `export default function NotificationsCard()` and `export function NotificationsBody({ prefs, note, error, onChange })` (pure, for the test). It is a card `general/notifications` in the Settings registry.

- [ ] **Step 1: Write the failing render test** — append to `ui/screens/shell/tests/notify.test.mjs` (add `React, renderToStaticMarkup` to the `helpers.mjs` import):

```js
test("the Notifications card lists the five switches, the privacy line and the tray note", async () => {
  const card = await load("notify/NotificationsCard.tsx");
  const prefs = { approvals: true, tasks: false, sync: true, updates: true, core: true };
  const html = renderToStaticMarkup(React.createElement(card.NotificationsBody, { prefs, note: n.trayNote({ available: false }), error: null, onChange() {} }));
  for (const s of n.NOTIFY_SWITCHES) assert.ok(html.includes(s.label), s.label);
  assert.match(html, /never chat text, file names, meeting captions or device names/);
  assert.match(html, /libayatana-appindicator3-1/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/notify.test.mjs`
Expected: FAIL (cannot resolve `notify/NotificationsCard.tsx`).

- [ ] **Step 3: Create `NotificationsCard.tsx`**

```tsx
// Settings > General > Notifications: one switch per category (host prefs `notifications`, applies at once) and the
// tray-missing note. A Settings card (register-card.ts), so no Settings section file changes.
import { useEffect, useState } from "react";
import { invokeHost, isHostAvailable } from "../host";
import { decodePrefsView, type NotifyPrefs } from "../host-prefs";
import { ErrorText, Switch } from "../../settings/ui.tsx";
import { NOTIFY_SWITCHES, trayNote } from "./notify";

export function NotificationsBody({ prefs, note, error, onChange }: { prefs: NotifyPrefs | null; note: string | null; error: string | null; onChange(key: keyof NotifyPrefs, on: boolean): void }) {
  return (
    <div className="st-stack">
      <p className="st-hint">Notifications say only what happened, for example “A Loop run passed.”, and never chat text, file names, meeting captions or device names. Your system’s Focus or Do Not Disturb setting still applies.</p>
      {prefs ? NOTIFY_SWITCHES.map((s) => <Switch key={s.key} label={s.label} hint={s.hint} checked={prefs[s.key]} onChange={(v) => onChange(s.key, v)} />) : null}
      {note ? <p className="st-hint" role="status">{note}</p> : null}
      {error ? <ErrorText text={error} /> : null}
    </div>
  );
}

export default function NotificationsCard() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isHostAvailable()) { setError("Notifications need the LLM-IDE desktop app."); return undefined; }
    let live = true;
    invokeHost<unknown>("get_prefs").then((v) => { const p = decodePrefsView(v); if (live) setPrefs(p ? p.stored.notifications : null); }, () => { if (live) setError("Notification settings are not available."); });
    invokeHost<unknown>("tray_status").then((v) => { if (live) setNote(trayNote(v)); }, () => undefined);
    return () => { live = false; };
  }, []);
  const onChange = async (key: keyof NotifyPrefs, on: boolean) => {
    if (!prefs) return;
    setError(null);
    try {
      const v = decodePrefsView(await invokeHost<unknown>("set_prefs", { patch: { notifications: { ...prefs, [key]: on } } }));
      if (v) setPrefs(v.stored.notifications);
    } catch {
      setError("The setting was not saved.");
    }
  };
  return <NotificationsBody prefs={prefs} note={note} error={error} onChange={(k, v) => void onChange(k, v)} />;
}
```

- [ ] **Step 4: Create `register-card.ts`**

```ts
// Adds the Notifications card to Settings > General through the registry's card slot. Imported once by the Settings
// entry (ui/screens/settings/index.tsx), so the card loads only with Settings.
import { settingsRegistry, type SectionComponent } from "../../settings/registry-default.ts";

settingsRegistry.registerCard("general", {
  id: "notifications",
  title: "Notifications",
  order: 10,
  load: () => import("./NotificationsCard.tsx") as unknown as Promise<{ default: SectionComponent }>,
});
```

- [ ] **Step 5: The one Settings edit** — in `ui/screens/settings/index.tsx`, after `import type { ThemeChoice } from "./host.ts";` add:

```ts
import "../shell/notify/register-card.ts";
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/notify.test.mjs ../ui/screens/settings/tests/*.test.*`
Expected: PASS.
Run: `cd desktop && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/screens/shell/notify/NotificationsCard.tsx ui/screens/shell/notify/register-card.ts ui/screens/settings/index.tsx ui/screens/shell/tests/notify.test.mjs
git commit -m "feat(ui): Notifications card in Settings > General

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, per-OS manual checks and the full gate (~20 min)

**Files:**
- Modify: `desktop/PACKAGING.md` (section "Project open, tray and notifications": the "Tray and notifications" paragraph, the per-OS caveats, and the `Notification detail also drops bidi…` line under the security list)
- Modify: `docs/superpowers/MASTER-PLAN.md` (the `[~] Tray / menu-bar presence and notifications` row)
- Modify: `docs/superpowers/USER-CHECKLIST.md` (new section E)

**Interfaces:**
- Consumes: everything above.
- Produces: docs only.

- [ ] **Step 1: Rewrite the PACKAGING paragraph** — replace the paragraph that starts `**Tray and notifications** (\`src-tauri/src/tray.rs\`).` and ends `There is no auto-start.` with:

```markdown
**Tray and notifications** (`src-tauri/src/tray.rs`, `src-tauri/src/notify.rs`). Tauri `tray-icon` feature plus
`tauri-plugin-notification` 2.4.0 (newest release that resolves against the pinned `tauri` 2.11.6; 2.5+ require
tauri 2.12), used from Rust only: no `notification:*` permission is granted and `check-capabilities` forbids it.
Tray menu: backend status (+ "Recording"), approvals waiting (opens Chat or the inbox), Show window, the active
project (label), Start/Stop live capture (macOS), Pause/Resume sync, Quit; left-click toggles the window. The count
also shows beside the menu-bar icon (macOS, Linux) and in the tooltip (Windows). Close-to-tray is off by default
(`tray-settings.json`) and refused without a tray icon. Notifications: the webview calls `notify_user(kind, key?,
count?)` with a kind from a fixed table (approvals, Loop / Auto Task / graph / Doc Gen done or failed, sync
attention); the host raises `update_ready` and `core_down` itself. The host writes every word (generic, ≤ 80
chars, no content, paths or names), skips a kind whose Settings switch is off (`prefs.json` `notifications`) or
whose place the focused window already shows, shows each de-dup key once and at most one per kind per 10 s. The
plugin reports no click on desktop, so the last notification's route is handed to the window when it next gains
focus or opens from the tray (2 min). A 2 s in-memory watcher keeps the tray in step and notices the backend going
down. There is no auto-start.
```

Replace the per-OS bullet for Linux with:

```markdown
- **Linux**: the tray needs `libayatana-appindicator3-1` (a deb dependency; the `-dev` package is in every CI apt
  step). GNOME needs the AppIndicator extension, otherwise the tray is absent, the app runs without it (close-to-tray
  stays off), and Settings > General > Notifications says so. Tray menus do not receive left-click events on most
  Linux hosts. Notifications use D-Bus; without a notification daemon they are dropped silently.
```

Replace the macOS bullet with:

```markdown
- **macOS**: the first notification triggers the system permission prompt; the lock screen shows the app name only
  unless the user allows previews. Clicking a notification activates the app; the Dock reopen handler shows a window
  hidden to the tray. The menu-bar icon is a color icon unless a template image is supplied (icon polish open).
```

Replace the security-list line that starts `- Notification detail also drops bidi/format characters and links;` with `- Notifications carry no webview text at all (a kind, an opaque key and a count); \`secrets_status\` is cached for 60 s (invalidated when secrets are created) so the webview cannot hammer the OS credential store.`

- [ ] **Step 2: Update the MASTER-PLAN row** — replace the whole `- [~] Tray / menu-bar presence and notifications (…) (me)` row with:

```markdown
- [~] Tray / menu-bar presence and notifications ([plan](plans/2026-11-07-desktop-notifications-tray.md)): host-built notifications from a fixed 13-kind table (approvals in Chat and the bus inbox, Loop / Auto Task / graph / Doc Gen done or failed, sync attention, update available, backend down), per-category switches in Settings > General (prefs `notifications`, default on), focus suppression, de-dup + 10 s coalescing, click route on next focus; tray status line, approvals count (menu, menu-bar title, tooltip), Start/Stop live capture, Pause/Resume sync; no webview notification permission, no new dependency; unit tests on all pure logic. Open: the per-OS manual checks in USER-CHECKLIST section E (me)
```

- [ ] **Step 3: Add USER-CHECKLIST section E** — append:

```markdown
## E. Desktop notifications and tray (about 10 minutes per OS)

Build and open the app (`desktop/RUN-ON-MAC.md`; on Windows the NSIS-installed build, on Linux the .deb). Sign in and open a project.

| # | OS | Do | Expect |
|---|---|---|---|
| E1 | all | Click Graph > Generate, then switch to another app before it ends | One notification "The code graph is ready." (title LLM-IDE); no project or file name |
| E2 | all | Same, but stay on the Graph section | No notification |
| E3 | all | Click the E1 notification (or focus the window within 2 minutes) | The Graph section opens |
| E4 | all | Settings > General > Notifications: turn "Long tasks finished" off, repeat E1 | No notification; turn it back on |
| E5 | all | From the iPhone or web app, queue a job that needs approval while the window is in the background | "A job is waiting for your approval."; the tray says "1 approval waiting" (macOS/Linux: "1" beside the icon; Windows: tooltip); its menu line opens the inbox |
| E6 | all | Ask Chat for an edit in Ask mode, switch to Explorer before the tool prompt | "A tool is waiting for your approval in Chat."; tray line opens Chat |
| E7 | all | Kill the core child process (`kill <pid>` from Settings > Server diagnostics) with the window in the background | "The LLM-IDE backend stopped. Open the app to restart it."; tray status "Backend restarting", then "Backend ready" |
| E8 | all | Tray: Pause sync (sync set up), then Resume sync | Settings shows sync off, then on; the item text flips |
| E9 | macOS | Tray: Start live capture with a Zoom meeting open; then Stop live capture | Window opens on Live and records; tray status shows "· Recording"; Stop saves the note |
| E10 | macOS | First notification after a fresh install | The system permission prompt appears once; the lock screen shows no content preview by default |
| E11 | macOS | Turn on close-to-tray, close the window, click a notification, then the Dock icon | The Dock click shows the window |
| E12 | Windows | Installed (NSIS) build: E1 | The notification is attributed to LLM-IDE (not the exe name) |
| E13 | Linux (GNOME without AppIndicator) | Launch | No tray, no crash; Settings > General > Notifications shows the AppIndicator note; E1 still notifies (D-Bus) |
| E14 | all | Turn on OS Focus / Do Not Disturb, repeat E1 | The OS holds the notification (no quiet-hours setting in the app by design) |
```

- [ ] **Step 4: Run the full gate**

Run: `cd desktop/src-tauri && cargo test`
Expected: PASS (all host tests).
Run: `cd desktop && node scripts/check-capabilities.mjs --product && npm test`
Expected: exit 0; all node suites PASS.
Run: `cd desktop && npx tsc --noEmit`
Expected: no errors.
Run: `cd extension && node --test --experimental-strip-types tests/sync-routes.test.mjs tests/sync-registry.test.mjs`
Expected: PASS.
Run: `grep -rn "approval_needed\|allow-notify\"\|tray::notify\|sanitize_detail" desktop/src-tauri/src desktop/src-tauri/build.rs desktop/src-tauri/capabilities ui/screens`
Expected: no output (the old template path is gone).

- [ ] **Step 5: Commit**

```bash
git add desktop/PACKAGING.md docs/superpowers/MASTER-PLAN.md docs/superpowers/USER-CHECKLIST.md
git commit -m "docs(desktop): tray and notifications, per-OS checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## C. Known limits (stated, not hidden)

- A notification "click" is approximate (D1). If the user ignores a notification and focuses the window within 2 minutes for another reason, the window still jumps to that notification's section once.
- Sync-attention notifications ride the activity poll, which pauses while the window is hidden (D4). A hidden-to-tray app reports them when it is shown again. The bus inbox poll and the chat count keep running, but a hidden WKWebView may throttle timers, so manual row E5 covers this.
- Phone- or web-initiated **chat** turns whose tool prompts are answered on the phone are not desktop approvals. They notify only if they surface in the desktop Chat or the bus inbox.
- The tray Start/Stop drives the Live screen's own Start/Stop, so the note is indexed exactly as with the button. If a capture is already running when the Live screen first mounts, the first tray press shows "A capture is already running" until the status read adopts it.

## D. Self-review

1. **Spec coverage.** (1) Notifications for approvals (chat → Tasks 3/6/7; bus jobs from Loop / Auto Tasks / phone / web → Task 3), long tasks (Loop, Auto Task, graph, Doc Gen → Task 7), sync attention (setup error and host key changed → Task 5; device removed → existing row → Task 6), update ready and core down (Tasks 3/4), click → section (D1, Tasks 3/6). (2) Tray status, quick actions and badge → Task 4 plus the Task 6 actions and the Task 7 Live toggle. (3) Per-category switches stored like other prefs → Tasks 1 and 8; quiet hours declined (D3). (4) Privacy: a fixed Rust text table, no detail parameter, the old `notify` removed → Tasks 2-3, with a test that bodies carry no `/`, `\`, `@` or `://`. Constraints: a host command (not a plugin permission) → Task 3; dedupe and coalescing → Task 2; focused-section suppression → Tasks 2-3 and 7 (`reportSection`); Linux tray failure → existing degrade path, the watcher still runs, the card shows the note (Tasks 4, 8); pure tests for all three OSes → Tasks 2, 4 and 6; manual rows → Task 9; pinned versions, no new dependency.
2. **Placeholder scan.** No TBD or TODO. Every code step shows its code. The edit anchors quote the existing lines.
3. **Type consistency.** Wire names are identical in `notify.rs` `wire()`, `WEBVIEW_KINDS` and `taskKind` (drift test). `tray_report` args `chatApprovals` / `jobApprovals` / `sync` match the Rust `chat_approvals` / `job_approvals` / `sync`. The `notify_user` args are `{ kind, key, count }`. `NotifyPrefs` fields match in Rust, TS and `NOTIFY_SWITCHES` (drift test). `SECTIONS` matches in Rust and TS (drift test). The `tray-action` payloads `capture_toggle`, `sync_toggle` and `route:<route>` match between `tray.rs`, `notify.rs` and `trayAction`. Doc Gen's surface id is `"doc"` (model.ts `Surface`), routed to section `docgen`.
