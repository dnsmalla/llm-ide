# Help & Support Guided Tours (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided "spotlight tour" mechanism to both the desktop app and the Chrome extension's Help & Support, and ship one flagship live tour per surface: "issue → shipped change" on desktop, "record a meeting → generate notes" on the extension.

**Architecture:** Each surface implements its own small, parallel `TourStep`/`TourFlow` type shape and a pure step-advance reducer (unit-tested, no DOM), plus a `TourOverlay` React component (manually verified, matching this codebase's existing split between pure/tested model files and untested-but-manually-verified `.tsx` rendering — see `board-model.ts`/`Card.tsx` and `sections.ts`/`Shell.tsx`). Desktop reuses the existing `Floating`/`placeFloating` popup primitive for positioning; the extension writes its own, simpler one (single-column side panel, no existing primitive to reuse). Live elements are tagged with `data-tour-id` attributes; a coverage test on each surface checks every tour step's `screenId`/`targetId` against the real section/tab registry, the same pattern `help.test.mjs` already uses for `help.ts` against `sections.ts`.

**Tech Stack:** React 18 + TypeScript on both surfaces (Tauri/Vite desktop, Chrome-extension/Vite side panel). `node --test --experimental-strip-types` for all automated tests (desktop: `cd desktop && npm test`; extension: `cd extension && npm test`). Both surfaces' JSX files (`.tsx`) cannot be imported by this test runner — only plain `.ts` logic files are test-imported, matching the existing codebase convention.

**Spec:** [docs/superpowers/specs/2026-11-27-help-support-tours-design.md](../specs/2026-11-27-help-support-tours-design.md)

## Global Constraints

- Scope is desktop + Chrome extension only. Web app, iOS app, auto first-run popups, a searchable help-center, and an AI help assistant are explicitly out of scope for this phase.
- `extension/` and `ui/`/`desktop/` share zero code and zero cross-imports today — do not introduce any import across that boundary. Each surface gets its own implementation of the same type shape.
- Extension's remaining ~1600 lines of static `HelpPanel.tsx` content (everything except Overview) is left untouched this phase.
- No new runtime dependency may be added on either surface for positioning/overlay — desktop reuses `ui/screens/shell/Floating.tsx`; the extension writes new, dependency-free positioning math.
- A tour step whose target element never mounts must degrade (tooltip without a spotlight) — it must never hang or throw.
- Nothing is persisted across a tour exit (on-demand only, no "don't show again" state).

---

### Task 1: Desktop tour engine (pure model)

**Files:**
- Create: `ui/screens/shell/tour-model.ts`
- Test: `ui/screens/shell/tests/tour-model.test.mjs`

**Interfaces:**
- Consumes: `SectionId` from `ui/screens/shell/sections.ts`; `Placement` from `ui/screens/shell/floating-place.ts`.
- Produces: `TourStep { id: string; title: string; body: string; targetId?: string; screenId?: SectionId; placement?: Placement }`, `TourFlow { id: string; title: string; steps: readonly TourStep[] }`, `TourState { flow: TourFlow; index: number }`, `TourAction`, `tourReducer(state: TourState | null, action: TourAction): TourState | null`, `currentStep(state: TourState | null): TourStep | null`, `isLastStep(state: TourState | null): boolean` — all consumed by Task 2.

- [ ] **Step 1: Write the failing test**

```js
// ui/screens/shell/tests/tour-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tourReducer, currentStep, isLastStep } from "../tour-model.ts";

const flow = {
  id: "demo",
  title: "Demo tour",
  steps: [
    { id: "a", title: "A", body: "first" },
    { id: "b", title: "B", body: "second" },
    { id: "c", title: "C", body: "third" },
  ],
};

test("start sets the flow at step 0", () => {
  const s = tourReducer(null, { type: "start", flow });
  assert.equal(s.flow, flow);
  assert.equal(s.index, 0);
});

test("next advances and clamps at the last step", () => {
  let s = tourReducer(null, { type: "start", flow });
  s = tourReducer(s, { type: "next" });
  assert.equal(s.index, 1);
  s = tourReducer(s, { type: "next" });
  s = tourReducer(s, { type: "next" });
  s = tourReducer(s, { type: "next" });
  assert.equal(s.index, 2, "clamped at the last step, not past it");
});

test("back retreats and clamps at the first step", () => {
  let s = tourReducer(null, { type: "start", flow });
  s = tourReducer(s, { type: "back" });
  assert.equal(s.index, 0, "clamped at the first step, not negative");
});

test("skip ends the tour from any state", () => {
  let s = tourReducer(null, { type: "start", flow });
  s = tourReducer(s, { type: "next" });
  assert.equal(tourReducer(s, { type: "skip" }), null);
  assert.equal(tourReducer(null, { type: "skip" }), null);
});

test("next/back/skip on a null state stay null", () => {
  assert.equal(tourReducer(null, { type: "next" }), null);
  assert.equal(tourReducer(null, { type: "back" }), null);
});

test("currentStep and isLastStep read the active step", () => {
  assert.equal(currentStep(null), null);
  assert.equal(isLastStep(null), false);
  let s = tourReducer(null, { type: "start", flow });
  assert.equal(currentStep(s), flow.steps[0]);
  assert.equal(isLastStep(s), false);
  s = tourReducer(s, { type: "next" });
  s = tourReducer(s, { type: "next" });
  assert.equal(currentStep(s), flow.steps[2]);
  assert.equal(isLastStep(s), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/tour-model.test.mjs`
Expected: FAIL — `tour-model.ts` does not exist yet (module not found).

- [ ] **Step 3: Write the minimal implementation**

```ts
// ui/screens/shell/tour-model.ts
// A guided tour's pure state: which flow is active and which step it is on. No React, no DOM — tested with node,
// same split as sections.ts/Shell.tsx and board-model.ts/Card.tsx elsewhere in this app.
import type { SectionId } from "./sections";
import type { Placement } from "./floating-place";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** The data-tour-id of the live element this step points at; absent = no spotlight, card only. */
  targetId?: string;
  /** The section to switch to before looking for targetId; absent = stay on the current section. */
  screenId?: SectionId;
  placement?: Placement;
}

export interface TourFlow {
  id: string;
  title: string;
  steps: readonly TourStep[];
}

export interface TourState {
  flow: TourFlow;
  index: number;
}

export type TourAction = { type: "start"; flow: TourFlow } | { type: "next" } | { type: "back" } | { type: "skip" };

export function tourReducer(state: TourState | null, action: TourAction): TourState | null {
  switch (action.type) {
    case "start":
      return { flow: action.flow, index: 0 };
    case "skip":
      return null;
    case "next":
      return state ? { ...state, index: Math.min(state.flow.steps.length - 1, state.index + 1) } : state;
    case "back":
      return state ? { ...state, index: Math.max(0, state.index - 1) } : state;
    default:
      return state;
  }
}

export function currentStep(state: TourState | null): TourStep | null {
  return state ? state.flow.steps[state.index] : null;
}

export function isLastStep(state: TourState | null): boolean {
  return state ? state.index === state.flow.steps.length - 1 : false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/tour-model.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/screens/shell/tour-model.ts ui/screens/shell/tests/tour-model.test.mjs
git commit -m "feat(desktop): add the pure guided-tour step model"
```

---

### Task 2: Desktop `TourOverlay` + Shell wiring

**Files:**
- Create: `ui/screens/shell/TourOverlay.tsx`
- Modify: `ui/screens/shell/Shell.tsx:219` (add tour state), `Shell.tsx:547` (mount dialog/overlay siblings)

**Interfaces:**
- Consumes: `tourReducer`, `currentStep`, `isLastStep`, `TourFlow`, `TourState` from `./tour-model` (Task 1); `Floating`, `Portal` from `./Floating`; `SectionId` from `./sections`; `shellBus`/`onSelect`/`dispatch` already in `Shell.tsx`.
- Produces: `useTour()` returning `{ tour: TourState | null; start(flow): void; next(): void; back(): void; skip(): void }`, and `<TourOverlay tour activeSection onSelectSection onNext onBack onSkip />` — both consumed by Task 3's "Start tour" button and by `Shell.tsx`.

- [ ] **Step 1: Write `TourOverlay.tsx`**

```tsx
// ui/screens/shell/TourOverlay.tsx
// A guided tour: dims the screen, cuts a spotlight around the step's live element, and shows a tooltip card beside
// it via Floating. A step can ask to switch screens first; if its element never mounts, the card still shows,
// centered, without a spotlight — a step never hangs waiting for an element that will not appear.
import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { Floating, Portal } from "./Floating";
import { currentStep, isLastStep, tourReducer, type TourFlow, type TourState, type TourStep } from "./tour-model";
import type { SectionId } from "./sections";

const TARGET_WAIT_MS = 1500;

export function useTour(): { tour: TourState | null; start: (flow: TourFlow) => void; next: () => void; back: () => void; skip: () => void } {
  const [tour, dispatch] = useReducer(tourReducer, null);
  const start = useCallback((flow: TourFlow) => dispatch({ type: "start", flow }), []);
  const next = useCallback(() => dispatch({ type: "next" }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const skip = useCallback(() => dispatch({ type: "skip" }), []);
  return { tour, start, next, back, skip };
}

/** Finds `[data-tour-id="id"]` in the live DOM, re-checking while it is missing (a step may follow a screen switch
 * that is still rendering), and gives up after TARGET_WAIT_MS so a step with no match still shows its card. */
function useTourTarget(targetId: string | undefined): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(null);
    if (!targetId) return undefined;
    const find = () => document.querySelector<HTMLElement>(`[data-tour-id="${targetId}"]`);
    const found = find();
    if (found) { setEl(found); return undefined; }
    const mo = new MutationObserver(() => { const f = find(); if (f) { setEl(f); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => mo.disconnect(), TARGET_WAIT_MS);
    return () => { mo.disconnect(); window.clearTimeout(timeout); };
  }, [targetId]);
  return el;
}

export function TourOverlay({ tour, activeSection, onSelectSection, onNext, onBack, onSkip }: {
  tour: TourState;
  activeSection: SectionId;
  onSelectSection: (id: SectionId) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}): ReactNode {
  const step = currentStep(tour) as TourStep;
  const switching = step.screenId !== undefined && step.screenId !== activeSection;
  useEffect(() => {
    if (switching && step.screenId) onSelectSection(step.screenId);
  }, [switching, step.screenId, onSelectSection]);
  const target = useTourTarget(switching ? undefined : step.targetId);
  const last = isLastStep(tour);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onSkip(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);
  const rect = target?.getBoundingClientRect();
  return (
    <>
      <Portal>
        {rect ? (
          <div aria-hidden="true" className="tour-spotlight" style={{ position: "fixed", top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8, borderRadius: 8, boxShadow: "0 0 0 9999px rgba(10,10,14,0.55)", pointerEvents: "none", zIndex: 999 }} />
        ) : (
          <div aria-hidden="true" className="tour-backdrop" style={{ position: "fixed", inset: 0, background: "rgba(10,10,14,0.35)", pointerEvents: "none", zIndex: 999 }} />
        )}
      </Portal>
      <Floating anchor={target ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }} onDismiss={onSkip} placement="below-start" className="tour-card" role="dialog" aria-modal="true" aria-label={tour.flow.title}>
        <p className="tour-step-count">{tour.flow.title} · step {tour.index + 1} of {tour.flow.steps.length}</p>
        <h4 className="tour-title">{step.title}</h4>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="help-btn" onClick={onSkip}>Skip tour</button>
          <button type="button" className="help-btn" disabled={tour.index === 0} onClick={onBack}>← Back</button>
          <button type="button" className="help-btn help-btn-primary" onClick={last ? onSkip : onNext}>{last ? "Finish" : "Next →"}</button>
        </div>
      </Floating>
    </>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd desktop && npm run build -- --mode development 2>&1 | head -50` is slow; prefer the fast path: `cd desktop && npx tsc --noEmit`
Expected: no new type errors (pre-existing unrelated errors, if any, are not introduced by this file).

- [ ] **Step 3: Wire it into `Shell.tsx`**

In `ui/screens/shell/Shell.tsx`, add the import near the other local imports (after line 6's `GuideDialog` import):

```ts
import { TourOverlay, useTour } from "./TourOverlay";
```

Near `Shell.tsx:219` (right after `const [guideOpen, setGuideOpen] = useState(false);`), add:

```ts
  const { tour, start: startTour, next: nextTour, back: backTour, skip: skipTour } = useTour();
```

At `Shell.tsx:547`, change the `GuideDialog` line to also pass `onStartTour`, and add the `TourOverlay` as a new sibling right after it:

```tsx
      {guideOpen ? <GuideDialog onClose={() => setGuideOpen(false)} onNavigate={(section, anchor) => { setGuideOpen(false); if (anchor) shellBus.publish({ type: "goto-section", section, anchor }); else onSelect(section); }} onStartTour={(flow) => { setGuideOpen(false); startTour(flow); }} /> : null}
      {tour ? <TourOverlay tour={tour} activeSection={nav.active} onSelectSection={onSelect} onNext={nextTour} onBack={backTour} onSkip={skipTour} /> : null}
```

(`GuideDialog`'s new `onStartTour` prop is added in Task 3, alongside the "Start tour" button — until Task 3 lands, `tsc` will flag the extra prop as unknown; land Task 2 and Task 3 together if your type-check gate runs between tasks, or accept the transient type error for the span of this one commit since the next task fixes it immediately.)

- [ ] **Step 4: Commit**

```bash
git add ui/screens/shell/TourOverlay.tsx ui/screens/shell/Shell.tsx
git commit -m "feat(desktop): add the guided-tour overlay and mount it in Shell"
```

---

### Task 3: Desktop flagship tour — "issue → shipped change"

**Files:**
- Create: `ui/screens/welcome/tours.ts`
- Test: `ui/screens/welcome/tests/tours.test.mjs`
- Modify: `ui/screens/welcome/HelpGuide.tsx` (Start tour button + `onStartTour` prop)
- Modify: `ui/screens/issues/IssuesScreen.tsx` (tag the issue card)
- Modify: `ui/screens/issues/IssueDetail.tsx:251` (tag Send to Factory)
- Modify: `ui/screens/factory/LaneBoard.tsx:26` (tag each lane)
- Modify: `ui/screens/factory/Card.tsx:40,74-87` (tag Start/Resume and the Done MR link)

**Interfaces:**
- Consumes: `TourFlow` from `../shell/tour-model`; `HELP_TOPICS` from `./help` (to validate the tour matches a real topic id).
- Produces: `DESKTOP_TOURS: readonly TourFlow[]`, consumed by `HelpGuide.tsx`.

- [ ] **Step 1: Write the failing coverage test**

```js
// ui/screens/welcome/tests/tours.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_TOURS } from "../tours.ts";
import { HELP_TOPICS } from "../help.ts";
import { SECTIONS } from "../../shell/sections.ts";

test("every tour matches a real help topic and every step's screen is a real section", () => {
  const topicIds = new Set(HELP_TOPICS.map((t) => t.id));
  const sectionIds = new Set(SECTIONS.map((s) => s.id));
  assert.ok(DESKTOP_TOURS.length >= 1);
  for (const tour of DESKTOP_TOURS) {
    assert.ok(topicIds.has(tour.id), `tour ${tour.id} has no matching help topic`);
    assert.ok(tour.steps.length >= 2, `${tour.id} needs at least two steps`);
    const targetIds = new Set();
    for (const step of tour.steps) {
      assert.ok(step.targetId, `${tour.id}/${step.id} needs a targetId`);
      assert.ok(!targetIds.has(step.id), `${tour.id}: duplicate step id ${step.id}`);
      targetIds.add(step.id);
      if (step.screenId) assert.ok(sectionIds.has(step.screenId), `${tour.id}/${step.id}: unknown section ${step.screenId}`);
    }
  }
});

test("the issue tour covers Issues and Factory", () => {
  const tour = DESKTOP_TOURS.find((t) => t.id === "recipe-issue");
  assert.ok(tour, "recipe-issue tour missing");
  const screens = new Set(tour.steps.map((s) => s.screenId));
  assert.ok(screens.has("issues"));
  assert.ok(screens.has("conflicts"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/welcome/tests/tours.test.mjs`
Expected: FAIL — `../tours.ts` does not exist.

- [ ] **Step 3: Write `tours.ts`**

```ts
// ui/screens/welcome/tours.ts
// Live, click-through tours: the same recipes help.ts explains in text, walked step by step on the real screen.
import type { TourFlow } from "../shell/tour-model";

export const DESKTOP_TOURS: readonly TourFlow[] = [
  {
    id: "recipe-issue",
    title: "Issue → shipped change",
    steps: [
      { id: "open-issue", title: "Open an issue", body: "Click any issue card to open its details.", targetId: "issue-card", screenId: "issues" },
      { id: "send-to-factory", title: "Send it to Factory", body: "This puts the issue in Factory's Backlog, ready to run.", targetId: "send-to-factory", screenId: "issues" },
      { id: "backlog", title: "It lands in Backlog", body: "Factory — the Loop board — picks it up here.", targetId: "lane-backlog", screenId: "conflicts" },
      { id: "start", title: "Click Start", body: "The AI plans the change, then implements, tests and reviews it, each one a step in this row.", targetId: "card-action-start", screenId: "conflicts" },
      { id: "done", title: "Reaches Done — open the draft MR", body: "A draft merge request is opened for you. Review it, then merge.", targetId: "done-mr-link", screenId: "conflicts" },
    ],
  },
];
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/welcome/tests/tours.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Tag the live elements**

In `ui/screens/issues/IssuesScreen.tsx`, find the issue-card `<li>` (around line 297):

```tsx
<li key={i.id} className="iss-card" data-tour-id="issue-card">
```

In `ui/screens/issues/IssueDetail.tsx:251`:

```tsx
{onSendToFactory ? <button type="button" className="iss-btn" data-tour-id="send-to-factory" onClick={onSendToFactory}>Send to Factory</button> : null}
```

In `ui/screens/factory/LaneBoard.tsx:26`, add the lane id as a tour anchor:

```tsx
<section key={lane.id} className="fx-col" data-kind={kind} data-tour-id={`lane-${lane.id}`} data-running={running || undefined} role="group" aria-label={`${lane.label} (${lane.cards.length})`}>
```

In `ui/screens/factory/Card.tsx`, tag the Done lane's MR link (line 40):

```tsx
{view.request ? <button type="button" className="fx-link" data-tour-id="done-mr-link" onClick={() => onAction("openRequest")}>{view.request.label}</button> : null}
```

and tag each action button inside the `view.actions.map` (around line 75):

```tsx
{view.actions.map((a) => (
  <button key={a} type="button" data-tour-id={`card-action-${a}`} disabled={busy && a === "approve"} className={a === "start" || a === "ship" || a === "finishChecks" || a === "approve" ? "fx-btn fx-primary" : "fx-btn"} onClick={() => {
```

(only the `data-tour-id={...}` attribute is new on this line; the rest of the button is unchanged.)

- [ ] **Step 6: Add the "Start tour" entry point in `HelpGuide.tsx`**

Add the import near the top (after the existing `./help` import at line 5):

```ts
import { DESKTOP_TOURS } from "./tours";
import type { TourFlow } from "../shell/tour-model";
```

Change the `Topic` function signature and its footer (around lines 70 and 94-102):

```tsx
function Topic({ t, open, onOpen, onStartTour }: { t: HelpTopic; open: (id: string) => void; onOpen?: () => void; onStartTour?: (flow: TourFlow) => void }): ReactNode {
  const flow = topicFlow(t);
  const tour = DESKTOP_TOURS.find((x) => x.id === t.id);
  return (
    <>
      {/* ...unchanged... */}
      <div className="help-foot">
        {onOpen ? <button type="button" className="help-btn help-btn-primary" onClick={onOpen}>{t.group === "Settings" ? "Open Settings" : t.target ? `Open ${t.title.replace(/^Recipe: /, "")}` : "Open"} →</button> : null}
        {tour && onStartTour ? <button type="button" className="help-btn" onClick={() => onStartTour(tour)}>Start tour →</button> : null}
        {t.related && t.related.length > 0 ? (
          <nav className="help-related" aria-label="Read next">
            <span>Read next</span>
            {t.related.map((id) => { const r = byId.get(id); return r ? <button key={id} type="button" className="help-chip" onClick={() => open(id)}>{r.title}</button> : null; })}
          </nav>
        ) : null}
      </div>
    </>
  );
}
```

Update `GuideDialog`'s signature and its `<Topic>` call (around lines 150 and 204):

```tsx
export function GuideDialog({ onClose, onNavigate, onStartTour, initialTopic }: { onClose: () => void; onNavigate?: (target: NonNullable<HelpTopic["target"]>, settingsGroup?: string) => void; onStartTour?: (flow: TourFlow) => void; initialTopic?: string }): ReactNode {
```

```tsx
              ? <Topic key={active.id} t={active} open={open} onOpen={active.target && onNavigate ? () => onNavigate(active.target!, active.settingsGroup) : undefined} onStartTour={onStartTour} />
```

- [ ] **Step 7: Type-check**

Run: `cd desktop && npx tsc --noEmit`
Expected: clean (this also resolves the transient `onStartTour` type error left over from Task 2).

- [ ] **Step 8: Run the full desktop test suite**

Run: `cd desktop && npm test`
Expected: PASS, including the new `tour-model.test.mjs` and `tours.test.mjs`, and the pre-existing `help.test.mjs` unaffected.

- [ ] **Step 9: Manual click-through**

Run: `cd desktop && npm run tauri dev`. Open Help & Guide (Ctrl/Cmd+/ or account menu), search or navigate to "Recipe: issue to shipped change", click "Start tour →", and step through all five steps with Next/Back, confirming each spotlight lands on the right element and the Issues→Factory screen switch happens automatically. Confirm Esc and "Skip tour" both end it cleanly.

- [ ] **Step 10: Commit**

```bash
git add ui/screens/welcome/tours.ts ui/screens/welcome/tests/tours.test.mjs ui/screens/welcome/HelpGuide.tsx ui/screens/issues/IssuesScreen.tsx ui/screens/issues/IssueDetail.tsx ui/screens/factory/LaneBoard.tsx ui/screens/factory/Card.tsx
git commit -m "feat(desktop): ship the issue-to-shipped-change guided tour"
```

---

### Task 4: Extension tour engine (pure model) + tabs extraction

**Files:**
- Create: `extension/src/sidepanel/tabs.ts` (extracted from `App.tsx`)
- Modify: `extension/src/sidepanel/App.tsx:34-42` (import from `./tabs` instead of defining locally)
- Create: `extension/src/sidepanel/help/tour-model.ts`
- Test: `extension/tests/tour-model.test.mjs`

**Interfaces:**
- Produces: `Tab`, `TABS` (from `tabs.ts`); `TourStep { id; title; body; targetId?; screenId?: Tab }`, `TourFlow`, `TourState`, `TourAction`, `tourReducer`, `currentStep`, `isLastStep` (from `help/tour-model.ts`, same shape as desktop Task 1 but a separate file/implementation) — consumed by Task 5 and Task 6.

- [ ] **Step 1: Extract `tabs.ts` (no behavior change)**

```ts
// extension/src/sidepanel/tabs.ts
// The side panel's tab set, pulled out of App.tsx so pure (non-JSX) code — tests, tour content — can import the
// tab ids without importing a .tsx file (node's test runner strips types but cannot parse JSX).
export type Tab = 'transcript' | 'notes' | 'questions' | 'chat' | 'settings';

export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'notes', label: 'Notes' },
  { id: 'questions', label: 'Questions' },
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
];
```

In `App.tsx`, replace the local `type Tab = ...` and `const TABS = ...` block at lines 34-42 with:

```ts
import { TABS, type Tab } from './tabs';
```

(add this import near the other local imports, e.g. right after the `HelpPanel` import at line 26; delete the old inline `type Tab` and `const TABS` declarations entirely — nothing else in `App.tsx` changes, since `Tab`/`TABS` are used the same way.)

- [ ] **Step 2: Verify no behavior change**

Run: `cd extension && npx tsc --noEmit`
Expected: clean — this is a pure extraction, so no type errors.

- [ ] **Step 3: Write the failing test**

```js
// extension/tests/tour-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tourReducer, currentStep, isLastStep } from '../src/sidepanel/help/tour-model.ts';

const flow = {
  id: 'demo',
  title: 'Demo tour',
  steps: [
    { id: 'a', title: 'A', body: 'first' },
    { id: 'b', title: 'B', body: 'second' },
  ],
};

test('start sets the flow at step 0', () => {
  const s = tourReducer(null, { type: 'start', flow });
  assert.equal(s.flow, flow);
  assert.equal(s.index, 0);
});

test('next advances and clamps at the last step', () => {
  let s = tourReducer(null, { type: 'start', flow });
  s = tourReducer(s, { type: 'next' });
  s = tourReducer(s, { type: 'next' });
  s = tourReducer(s, { type: 'next' });
  assert.equal(s.index, 1, 'clamped at the last step, not past it');
});

test('back retreats and clamps at the first step', () => {
  let s = tourReducer(null, { type: 'start', flow });
  s = tourReducer(s, { type: 'back' });
  assert.equal(s.index, 0);
});

test('skip ends the tour from any state, and is a no-op from null', () => {
  let s = tourReducer(null, { type: 'start', flow });
  assert.equal(tourReducer(s, { type: 'skip' }), null);
  assert.equal(tourReducer(null, { type: 'skip' }), null);
});

test('currentStep and isLastStep read the active step', () => {
  assert.equal(currentStep(null), null);
  assert.equal(isLastStep(null), false);
  let s = tourReducer(null, { type: 'start', flow });
  assert.equal(currentStep(s), flow.steps[0]);
  s = tourReducer(s, { type: 'next' });
  assert.equal(isLastStep(s), true);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/tour-model.test.mjs`
Expected: FAIL — `src/sidepanel/help/tour-model.ts` does not exist.

- [ ] **Step 5: Write the minimal implementation**

```ts
// extension/src/sidepanel/help/tour-model.ts
// A guided tour's pure state for the side panel: which flow is active and which step it is on. No React, no DOM —
// a separate implementation of the same shape as the desktop's ui/screens/shell/tour-model.ts (the two builds
// share no code), tested the same way.
import type { Tab } from '../tabs';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** The data-tour-id of the live element this step points at; absent = no spotlight, card only. */
  targetId?: string;
  /** The tab to switch to before looking for targetId; absent = stay on the current tab. */
  screenId?: Tab;
}

export interface TourFlow {
  id: string;
  title: string;
  steps: readonly TourStep[];
}

export interface TourState {
  flow: TourFlow;
  index: number;
}

export type TourAction = { type: 'start'; flow: TourFlow } | { type: 'next' } | { type: 'back' } | { type: 'skip' };

export function tourReducer(state: TourState | null, action: TourAction): TourState | null {
  switch (action.type) {
    case 'start':
      return { flow: action.flow, index: 0 };
    case 'skip':
      return null;
    case 'next':
      return state ? { ...state, index: Math.min(state.flow.steps.length - 1, state.index + 1) } : state;
    case 'back':
      return state ? { ...state, index: Math.max(0, state.index - 1) } : state;
    default:
      return state;
  }
}

export function currentStep(state: TourState | null): TourStep | null {
  return state ? state.flow.steps[state.index] : null;
}

export function isLastStep(state: TourState | null): boolean {
  return state ? state.index === state.flow.steps.length - 1 : false;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/tour-model.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the full extension unit suite**

Run: `cd extension && npm test`
Expected: PASS (no regression from the `tabs.ts` extraction or the new test file).

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidepanel/tabs.ts extension/src/sidepanel/App.tsx extension/src/sidepanel/help/tour-model.ts extension/tests/tour-model.test.mjs
git commit -m "feat(ext): extract the tab registry and add the pure guided-tour step model"
```

---

### Task 5: Extension `TourOverlay` + App wiring

**Files:**
- Create: `extension/src/sidepanel/help/placement.ts` (pure positioning helper)
- Test: `extension/tests/help-placement.test.mjs`
- Create: `extension/src/sidepanel/help/TourOverlay.tsx`
- Modify: `extension/src/sidepanel/App.tsx` (mount the overlay, own tour state)

**Interfaces:**
- Consumes: `tourReducer`, `currentStep`, `isLastStep`, `TourFlow`, `TourState` from `./tour-model` (Task 4); `Tab`, `TABS` from `../tabs`.
- Produces: `placeCard(targetRect, cardSize, panelWidth, panelHeight): { top: number; left: number; side: "below" | "above" }` (pure, tested); `useTour()`; `<TourOverlay tour activeTab onSelectTab onNext onBack onSkip />` — consumed by Task 6 and 7.

- [ ] **Step 1: Write the failing placement test**

```js
// extension/tests/help-placement.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCard } from '../src/sidepanel/help/placement.ts';

test('places the card below the target when there is room', () => {
  const rect = { top: 100, left: 20, right: 220, bottom: 140, width: 200, height: 40 };
  const p = placeCard(rect, { width: 240, height: 120 }, 320, 800);
  assert.equal(p.side, 'below');
  assert.ok(p.top > rect.bottom);
});

test('flips above when there is no room below', () => {
  const rect = { top: 700, left: 20, right: 220, bottom: 740, width: 200, height: 40 };
  const p = placeCard(rect, { width: 240, height: 120 }, 320, 800);
  assert.equal(p.side, 'above');
  assert.ok(p.top + 120 <= rect.top);
});

test('clamps horizontally inside the panel width', () => {
  const rect = { top: 100, left: 280, right: 340, bottom: 140, width: 60, height: 40 };
  const p = placeCard(rect, { width: 240, height: 120 }, 320, 800);
  assert.ok(p.left >= 0);
  assert.ok(p.left + 240 <= 320);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/help-placement.test.mjs`
Expected: FAIL — `placement.ts` does not exist.

- [ ] **Step 3: Write `placement.ts`**

```ts
// extension/src/sidepanel/help/placement.ts
// Where a tour card goes next to its target inside the side panel: a single scrollable column, so (unlike the
// desktop's floating-place.ts) there is only one horizontal arrangement to worry about, just a below/above flip
// and a horizontal clamp to the panel's own width. Pure — no DOM — so node can test it.
export interface TargetRect { top: number; left: number; right: number; bottom: number; width: number; height: number }
export interface CardSize { width: number; height: number }
export interface PlacedCard { top: number; left: number; side: 'below' | 'above' }

const GAP = 8;
const MARGIN = 8;

export function placeCard(target: TargetRect, card: CardSize, panelWidth: number, panelHeight: number): PlacedCard {
  const below = panelHeight - target.bottom - GAP - MARGIN;
  const above = target.top - GAP - MARGIN;
  const side: 'below' | 'above' = card.height <= below || below >= above ? 'below' : 'above';
  const top = side === 'below' ? target.bottom + GAP : Math.max(MARGIN, target.top - GAP - card.height);
  const left = Math.max(MARGIN, Math.min(target.left, panelWidth - MARGIN - card.width));
  return { top, left, side };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/help-placement.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Write `TourOverlay.tsx`**

```tsx
// extension/src/sidepanel/help/TourOverlay.tsx
// A guided tour for the side panel: dims the panel, cuts a spotlight around the step's live element, and shows a
// tooltip card next to it (placeCard does the positioning math). A step can ask to switch tabs first; if its
// element never mounts, the card still shows, centered, without a spotlight.
import { useCallback, useEffect, useReducer, useState, type ReactNode } from 'react';
import { currentStep, isLastStep, tourReducer, type TourFlow, type TourState, type TourStep } from './tour-model';
import { placeCard } from './placement';
import type { Tab } from '../tabs';

const TARGET_WAIT_MS = 1500;

export function useTour(): { tour: TourState | null; start: (flow: TourFlow) => void; next: () => void; back: () => void; skip: () => void } {
  const [tour, dispatch] = useReducer(tourReducer, null);
  const start = useCallback((flow: TourFlow) => dispatch({ type: 'start', flow }), []);
  const next = useCallback(() => dispatch({ type: 'next' }), []);
  const back = useCallback(() => dispatch({ type: 'back' }), []);
  const skip = useCallback(() => dispatch({ type: 'skip' }), []);
  return { tour, start, next, back, skip };
}

function useTourTarget(targetId: string | undefined): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(null);
    if (!targetId) return undefined;
    const find = () => document.querySelector<HTMLElement>(`[data-tour-id="${targetId}"]`);
    const found = find();
    if (found) { setEl(found); return undefined; }
    const mo = new MutationObserver(() => { const f = find(); if (f) { setEl(f); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => mo.disconnect(), TARGET_WAIT_MS);
    return () => { mo.disconnect(); window.clearTimeout(timeout); };
  }, [targetId]);
  return el;
}

export default function TourOverlay({ tour, activeTab, onSelectTab, onNext, onBack, onSkip }: {
  tour: TourState;
  activeTab: Tab;
  onSelectTab: (id: Tab) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}): ReactNode {
  const step = currentStep(tour) as TourStep;
  const switching = step.screenId !== undefined && step.screenId !== activeTab;
  useEffect(() => {
    if (switching && step.screenId) onSelectTab(step.screenId);
  }, [switching, step.screenId, onSelectTab]);
  const target = useTourTarget(switching ? undefined : step.targetId);
  const last = isLastStep(tour);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onSkip(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onSkip]);

  const [cardSize, setCardSize] = useState({ width: 240, height: 140 });
  const rect = target?.getBoundingClientRect();
  const placed = rect ? placeCard(rect, cardSize, window.innerWidth, window.innerHeight) : null;

  return (
    <div className="tour-layer" aria-hidden={false}>
      {rect ? (
        <div aria-hidden="true" className="tour-spotlight" style={{ position: 'fixed', top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8, borderRadius: 8, boxShadow: '0 0 0 9999px rgba(10,10,14,0.55)', pointerEvents: 'none', zIndex: 999 }} />
      ) : (
        <div aria-hidden="true" className="tour-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,14,0.35)', pointerEvents: 'none', zIndex: 999 }} />
      )}
      <div
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-label={tour.flow.title}
        ref={(el) => { if (el && (el.offsetWidth !== cardSize.width || el.offsetHeight !== cardSize.height)) setCardSize({ width: el.offsetWidth, height: el.offsetHeight }); }}
        style={{ position: 'fixed', top: placed?.top ?? window.innerHeight / 2 - 70, left: placed?.left ?? 16, zIndex: 1000, width: 240 }}
      >
        <p className="tour-step-count">{tour.flow.title} · step {tour.index + 1} of {tour.flow.steps.length}</p>
        <h4 className="tour-title">{step.title}</h4>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="btn btn-sm" onClick={onSkip}>Skip tour</button>
          <button type="button" className="btn btn-sm" disabled={tour.index === 0} onClick={onBack}>← Back</button>
          <button type="button" className="btn btn-sm btn-generate" onClick={last ? onSkip : onNext}>{last ? 'Finish' : 'Next →'}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire it into `App.tsx`**

Add the import near the other local component imports (after the `HelpPanel` import at line 26):

```ts
import TourOverlay, { useTour } from './help/TourOverlay';
```

Near the `showHelp` state (line 123), add:

```ts
  const { tour, start: startTour, next: nextTour, back: backTour, skip: skipTour } = useTour();
```

At the end of the component's render, right after the `HelpPanel` line (line 783), add:

```tsx
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} onStartTour={(flow) => { setShowHelp(false); startTour(flow); }} />}
      {tour && <TourOverlay tour={tour} activeTab={activeTab} onSelectTab={setActiveTab} onNext={nextTour} onBack={backTour} onSkip={skipTour} />}
```

(`HelpPanel`'s new `onStartTour` prop is added in Task 7, which lands immediately after this task.)

- [ ] **Step 7: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: clean once Task 7 adds `onStartTour` to `HelpPanel`'s props (same transient-error note as desktop Task 2/3).

- [ ] **Step 8: Run the extension unit suite**

Run: `cd extension && npm test`
Expected: PASS, including the two new test files from this task and Task 4.

- [ ] **Step 9: Commit**

```bash
git add extension/src/sidepanel/help/placement.ts extension/tests/help-placement.test.mjs extension/src/sidepanel/help/TourOverlay.tsx extension/src/sidepanel/App.tsx
git commit -m "feat(ext): add the guided-tour overlay and mount it in the side panel"
```

---

### Task 6: Extension flagship tour — "record a meeting → generate notes"

**Files:**
- Create: `extension/src/sidepanel/help/tours.ts`
- Test: `extension/tests/help-tours.test.mjs`
- Modify: `extension/src/sidepanel/components/RecordingControls.tsx:46` (tag Start Recording)
- Modify: `extension/src/sidepanel/components/NotesView.tsx:18,41` (tag Generate Notes and the result)
- Modify: `extension/tests/render/cases.tsx` (extend the two existing render-case `expect` arrays)

**Interfaces:**
- Consumes: `TourFlow` from `./tour-model`; `TABS` from `../tabs`.
- Produces: `RECORD_NOTES_TOUR: TourFlow`, consumed by Task 7's "Start tour" button.

- [ ] **Step 1: Write the failing coverage test**

```js
// extension/tests/help-tours.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_NOTES_TOUR } from '../src/sidepanel/help/tours.ts';
import { TABS } from '../src/sidepanel/tabs.ts';

test('the record-notes tour has at least two steps, each with a targetId and a real tab', () => {
  const tabIds = new Set(TABS.map((t) => t.id));
  assert.ok(RECORD_NOTES_TOUR.steps.length >= 2);
  for (const step of RECORD_NOTES_TOUR.steps) {
    assert.ok(step.targetId, `${step.id} needs a targetId`);
    if (step.screenId) assert.ok(tabIds.has(step.screenId), `${step.id}: unknown tab ${step.screenId}`);
  }
});

test('the tour starts on recording and ends on the generated result', () => {
  assert.equal(RECORD_NOTES_TOUR.steps[0].targetId, 'start-recording');
  assert.equal(RECORD_NOTES_TOUR.steps[RECORD_NOTES_TOUR.steps.length - 1].targetId, 'notes-result');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/help-tours.test.mjs`
Expected: FAIL — `src/sidepanel/help/tours.ts` does not exist.

- [ ] **Step 3: Write `tours.ts`**

```ts
// extension/src/sidepanel/help/tours.ts
import type { TourFlow } from './tour-model';

export const RECORD_NOTES_TOUR: TourFlow = {
  id: 'record-notes',
  title: 'Record a meeting → generate notes',
  steps: [
    { id: 'start', title: 'Start recording', body: 'Click Start Recording to begin capturing the meeting.', targetId: 'start-recording' },
    { id: 'generate', title: 'Generate your notes', body: 'Once you have some transcript, switch to Notes and click Generate Notes.', targetId: 'generate-notes', screenId: 'notes' },
    { id: 'result', title: 'Your notes are ready', body: 'Summaries, decisions and action items appear here, pulled straight from the transcript.', targetId: 'notes-result', screenId: 'notes' },
  ],
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && node --test --experimental-strip-types tests/help-tours.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Tag the live elements**

In `extension/src/sidepanel/components/RecordingControls.tsx:46`:

```tsx
<button type="button" className="btn btn-start" data-tour-id="start-recording" onClick={onStart} aria-label="Start recording">
```

In `extension/src/sidepanel/components/NotesView.tsx`, tag the Generate button (line 18):

```tsx
<button
  className="btn btn-generate"
  data-tour-id="generate-notes"
  onClick={onGenerate}
  disabled={!hasTranscript}
  aria-label={hasTranscript ? 'Generate meeting notes from transcript' : 'Recording required first'}
>
```

and the result container (line 41):

```tsx
<div className="notes-content" data-tour-id="notes-result">
```

- [ ] **Step 6: Extend the existing render-smoke cases**

In `extension/tests/render/cases.tsx`, find the `RecordingControls` render case and add one `expect` entry for the new attribute (keep every existing entry):

```ts
      expect: [/* ...existing entries..., */ 'data-tour-id="start-recording"'],
```

Find the `NotesView` render case (the one that renders with a non-empty `notes` prop, if one exists — otherwise this attribute will only appear in a case that passes `notes`) and add:

```ts
      expect: [/* ...existing entries..., */ 'data-tour-id="notes-result"'],
```

If no existing `NotesView` case passes a non-empty `notes` string, add one minimal case for it instead of editing an existing one — follow the file's established `RenderCase` shape (`name`, `render`, `expect`), reusing the `noop` helper already defined there for the `onGenerate` prop.

- [ ] **Step 7: Run the render smoke check**

Run: `cd extension && npm run test:render`
Expected: PASS.

- [ ] **Step 8: Run the full extension unit suite**

Run: `cd extension && npm test`
Expected: PASS.

- [ ] **Step 9: Manual click-through**

Run: `cd extension && npm run dev` (or load the unpacked extension per `extension/README`/`start.sh`), open the side panel's Help ("?"), and once Task 7 lands the "Start tour" button, run the full record→notes tour end to end in a real meeting tab or with a manual transcript, confirming the Notes tab auto-switches and the final step lands on the generated result.

- [ ] **Step 10: Commit**

```bash
git add extension/src/sidepanel/help/tours.ts extension/tests/help-tours.test.mjs extension/src/sidepanel/components/RecordingControls.tsx extension/src/sidepanel/components/NotesView.tsx extension/tests/render/cases.tsx
git commit -m "feat(ext): ship the record-a-meeting-to-notes guided tour"
```

---

### Task 7: Extension Overview topic → structured content + "Start tour" entry point

**Files:**
- Create: `extension/src/sidepanel/help/topics.ts`
- Modify: `extension/src/sidepanel/components/HelpPanel.tsx` (`OverviewSection`, lines ~275-389; component props, line 193; `HelpPanel` call site type)

**Interfaces:**
- Consumes: `RECORD_NOTES_TOUR` from `./tours` (Task 6); `TourFlow` from `./tour-model` (Task 4).
- Produces: `OVERVIEW: OverviewContent` (structured replacement for the Overview section's copy), consumed by `OverviewSection()`.

- [ ] **Step 1: Write `topics.ts`, carrying over the Overview copy verbatim**

```ts
// extension/src/sidepanel/help/topics.ts
// Structured replacement for HelpPanel's Overview section — the first topic migrated out of static JSX prose, so
// the same copy can also host a "Start tour" entry point. The rest of HelpPanel's sections stay static prose this
// phase (see the Phase 1 design spec).
export interface OverviewPage { icon: string; name: string; body: string }
export interface OverviewFlowStep { title: string; body: string }
export interface OverviewContent {
  heading: string;
  intro: readonly string[];
  pagesHeading: string;
  pagesIntro: string;
  pages: readonly OverviewPage[];
  pagesHint: string;
  privacyHeading: string;
  privacy: readonly string[];
  flowHeading: string;
  flow: readonly OverviewFlowStep[];
}

export const OVERVIEW: OverviewContent = {
  heading: 'Welcome to LLM-IDE',
  intro: [
    "Meetings are where important things happen — decisions get made, tasks get assigned, ideas take shape. But keeping up with everything while you're actually in the conversation? That's almost impossible. That's exactly why LLM-IDE exists.",
    'LLM-IDE sits quietly beside your meeting, captures every word, and lets AI do the heavy lifting — summarizing, analyzing, and answering your questions. You focus on the conversation. We take care of the notes.',
  ],
  pagesHeading: 'Your five-tab workspace',
  pagesIntro: "LLM-IDE is organized into five pages. Each one handles a different part of the meeting workflow. Here's a quick map:",
  pages: [
    { icon: 'mic', name: 'Transcript', body: 'A live, scrolling record of everything being said. Words appear as people speak, grouped by who said them.' },
    { icon: 'note', name: 'Notes', body: 'One click turns your raw transcript into polished meeting notes with summaries, decisions, and action items.' },
    { icon: 'question', name: 'Questions', body: 'The AI reads between the lines and flags things that are vague, contradictory, or need follow-up.' },
    { icon: 'chat', name: 'Chat', body: 'Ask the AI anything about your meeting in plain English. "What did we decide about the timeline?"' },
    { icon: 'gear', name: 'Settings', body: 'Microphone setup, diagnostics, AI persona, connectors, and a searchable knowledge base of all your past meetings.' },
  ],
  pagesHint: 'Click any page name in the navigation above to see a detailed guide with examples and tips.',
  privacyHeading: "100% private — nothing leaves your machine",
  privacy: [
    "This isn't a cloud service. Your audio never gets uploaded. Your transcript never touches a remote server. Everything runs locally — the extension captures, a small server on localhost:3456 handles AI requests through your own Claude CLI credentials, and the knowledge base is a local SQLite file on your hard drive.",
    'No accounts with third parties. No data sharing. No subscriptions. Just your meetings, your notes, your machine.',
  ],
  flowHeading: 'A typical meeting flow',
  flow: [
    { title: 'Before the meeting', body: 'Make sure the server is running. Open LLM-IDE from the toolbar.' },
    { title: 'Start recording', body: 'Click Start. Words flow into the Transcript tab in real time.' },
    { title: 'During the meeting', body: 'Glance at the transcript, ask the Chat, or let the co-pilot flag gaps.' },
  ],
};
```

(Note: the current `OverviewSection()` JSX has a 4th flow step continuing past line 389 in the original file — when porting, read the full `OverviewSection()` body through its closing brace and carry every remaining flow step and any trailing card into `OVERVIEW` unchanged, rather than truncating at the 3 shown here; this plan shows the pattern, not the full text.)

- [ ] **Step 2: Rewrite `OverviewSection()` to render from `OVERVIEW`**

Replace the function body (lines 275-389) with a render driven by the data, keeping every existing CSS class name so no stylesheet changes are needed:

```tsx
function OverviewSection() {
  return (
    <div className="help-section">
      <h3>{OVERVIEW.heading}</h3>
      {OVERVIEW.intro.map((p, i) => <p key={i}>{p}</p>)}

      <div className="help-card">
        <h4>{OVERVIEW.pagesHeading}</h4>
        <p>{OVERVIEW.pagesIntro}</p>
        <div className="help-page-overview">
          {OVERVIEW.pages.map((page) => (
            <div key={page.name} className="help-page-pill">
              <span className="help-pill-icon" aria-hidden="true"><Icon name={page.icon as IconName} /></span>
              <strong>{page.name}</strong> &mdash; {page.body}
            </div>
          ))}
        </div>
        <p className="help-hint">{OVERVIEW.pagesHint}</p>
      </div>

      <div className="help-card help-card-highlight">
        <h4>{OVERVIEW.privacyHeading}</h4>
        {OVERVIEW.privacy.map((p, i) => <p key={i}>{p}</p>)}
      </div>

      <div className="help-card">
        <h4>{OVERVIEW.flowHeading}</h4>
        <div className="help-flow">
          {OVERVIEW.flow.map((step, i) => (
            <div key={step.title}>
              <div className={`help-flow-step${i < 2 ? ' active' : ''}`}>
                <div className="help-flow-icon">{i + 1}</div>
                <div className="help-flow-body"><h4>{step.title}</h4><p>{step.body}</p></div>
              </div>
              {i < OVERVIEW.flow.length - 1 ? <div className="help-flow-arrow">↓</div> : null}
            </div>
          ))}
        </div>
      </div>

      {RECORD_NOTES_TOUR ? (
        <div className="help-card">
          <button type="button" className="btn btn-generate" onClick={() => props.onStartTour(RECORD_NOTES_TOUR)}>Start tour →</button>
        </div>
      ) : null}
    </div>
  );
}
```

Since `OverviewSection` is a free function (not currently a prop-receiver), give it the tour callback explicitly: change its declaration to `function OverviewSection({ onStartTour }: { onStartTour: (flow: TourFlow) => void })`, update its one call site at `activeSection === 'overview' && <OverviewSection onStartTour={onStartTour} />` (replacing the current `<OverviewSection />` in the render block), and drop the stray `props.`/bare `RECORD_NOTES_TOUR ? …` guard above to just always render the tour button block (the import makes it always defined):

```tsx
function OverviewSection({ onStartTour }: { onStartTour: (flow: TourFlow) => void }) {
  return (
    <div className="help-section">
      {/* ...as above up through the flow card... */}
      <div className="help-card">
        <button type="button" className="btn btn-generate" onClick={() => onStartTour(RECORD_NOTES_TOUR)}>Start tour →</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire `HelpPanel`'s own props and its import**

Add the imports near the top of `HelpPanel.tsx` (alongside its existing imports):

```ts
import { OVERVIEW } from '../help/topics';
import { RECORD_NOTES_TOUR } from '../help/tours';
import type { TourFlow } from '../help/tour-model';
```

Change `HelpPanel`'s own props type and the `OverviewSection` call site (around line 193):

```tsx
interface Props {
  onClose: () => void;
  onStartTour: (flow: TourFlow) => void;
}

export default function HelpPanel({ onClose, onStartTour }: Props) {
```

```tsx
        {activeSection === 'overview' && <OverviewSection onStartTour={onStartTour} />}
```

- [ ] **Step 4: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: clean (this also resolves `App.tsx`'s `onStartTour` prop added in Task 5, since `HelpPanel` now declares it).

- [ ] **Step 5: Run the render smoke check**

Run: `cd extension && npm run test:render`
Expected: PASS. (`HelpPanel` itself is not in `cases.tsx` — it uses `document.addEventListener` in a `useEffect`, so per the file's own rule it does not belong in the no-DOM render harness; this step only confirms the two components already there, `RecordingControls`/`NotesView`, still render.)

- [ ] **Step 6: Run the full extension unit suite**

Run: `cd extension && npm test`
Expected: PASS.

- [ ] **Step 7: Manual verification**

Run: `cd extension && npm run dev`, open Help, confirm the Overview tab renders identically to before (same text, same layout) and now has a working "Start tour →" button that runs the Task 6 tour end to end.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidepanel/help/topics.ts extension/src/sidepanel/components/HelpPanel.tsx
git commit -m "feat(ext): migrate the Overview help topic to structured content with a tour entry point"
```

---

## Self-Review Notes

- **Spec coverage:** desktop tour engine (Task 1), desktop overlay/Shell wiring (Task 2), desktop flagship tour + data-tour-id hooks + coverage test + manual check (Task 3), extension tour engine + tabs extraction (Task 4), extension overlay/App wiring (Task 5), extension flagship tour + hooks + coverage test + render-case update + manual check (Task 6), extension Overview migration + tour entry point (Task 7). All spec sections are covered; nothing outside Phase 1 scope was added.
- **Type consistency checked:** `TourStep`/`TourFlow`/`TourState`/`TourAction`/`tourReducer`/`currentStep`/`isLastStep` names and shapes match exactly between Task 1↔Task 2↔Task 3 (desktop) and Task 4↔Task 5↔Task 6↔Task 7 (extension) — each surface's own copy, never cross-imported.
- **Known transient type errors:** Task 2 references `GuideDialog`'s `onStartTour` prop before Task 3 declares it; Task 5 references `HelpPanel`'s `onStartTour` prop before Task 7 declares it. Both are called out inline and resolve within the next task — execute Tasks 2→3 and 5→7 in order without a type-check gate in between, or accept the transient error for that one commit's span.
