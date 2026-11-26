# Help & Support: guided tours (Phase 1)

Status: approved by user, pending implementation plan.

## Problem

Help & Support content exists on four surfaces, at very different quality:

- **Desktop** (`ui/screens/welcome/help.ts` + `HelpGuide.tsx`) is already reasonably
  good: a structured topic/flow registry kept in sync with the live screen
  registry (`ui/screens/shell/sections.ts`) via tests, with search, clickable
  step-through flows, checklists, and deep-link buttons into the real screen.
  What it lacks: the flow steps are text + a "go there" button, not an overlay
  that highlights the live element on the live screen as you go.
- **Chrome extension** (`extension/src/sidepanel/components/HelpPanel.tsx`) is
  ~1617 lines of static hand-written prose in a tabbed modal. No search, no
  interactivity, no live-element guidance at all.
- **Web app** and **iOS app** have small, narrowly-scoped help pages focused on
  phone/desktop pairing; both already point users at the desktop's help as the
  canonical source. Out of scope for this work (per user decision).

`extension/` and `ui/`/`desktop/` share **zero code today** (confirmed: no root
workspace, no cross-imports, separate Vite builds). This spec does not
introduce a new shared package across that boundary — it defines one common
*type shape*, implemented twice.

## Scope (this phase)

In scope: **Desktop + Chrome extension**, guided in-app tours (spotlight
overlay walking the user through real UI, not just text), **hand-written**
structured content (no auto-generation from code).

Explicitly out of scope / future phases, not part of this plan:
- Web app, iOS app (both already defer to desktop's help as canonical)
- A searchable help-center article database, and an AI help assistant (the
  user picked "guided tours" as the primary mechanism for now; these were
  considered and parked)
- Auto-first-run popup triggers (Phase 1 is on-demand only, via the existing
  Help entry points on each surface)
- Migrating the extension's remaining ~1600 lines of static content into the
  new schema — Phase 1 migrates only the Overview topic plus the one flagship
  flow below; the rest stays as-is until Phase 2

This is explicitly **Phase 1 of a phased rollout**: prove the engine and
schema out on one flagship flow per surface, then (as separate follow-up work)
fill in the remaining topics/flows incrementally.

## Architecture

Each surface gets its own implementation of the same concept — no new
cross-surface package:

```ts
interface TourStep {
  id: string
  title: string
  body: string          // short, plain text/markdown
  targetId?: string      // data-tour-id of the live element; absent = no spotlight
  screenId?: string      // desktop: SectionId to navigate to; extension: TABS id to switch to
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto'
}

interface TourFlow {
  id: string
  title: string
  steps: TourStep[]
}
```

Each surface implements, in its own tree:
- A `TourOverlay` component: full-viewport layer. On each step, if
  `screenId` differs from the current screen/tab, switches to it first; then
  locates the element via `document.querySelector('[data-tour-id="..."]')`,
  waiting (via `MutationObserver`, capped timeout) for it to mount. Draws a
  spotlight cutout around its bounding rect (SVG mask) and a tooltip card
  (title, body, Back/Next/Skip, step N of M) positioned beside it. If no
  `targetId`, or the element never mounts within the timeout, shows the
  tooltip centered with no spotlight — never hangs, never crashes the tour.
  Repositions every frame on resize/scroll while active (`ResizeObserver` +
  scroll listener).
- A `useTour(flow: TourFlow)` hook: holds `currentStepIndex`, exposes
  `start()`, `next()`, `back()`, `skip()`. Pure state machine (index + flow),
  no DOM access itself — DOM/targeting lives in `TourOverlay`. This split is
  what makes the step-advance logic unit-testable without a DOM.

## Desktop implementation

- Extend specific existing entries in `HELP_FLOWS` (`ui/screens/welcome/help.ts`)
  with `targetId`/`screenId` per step, starting with the **"issue → shipped
  change"** flow (Issues → Factory/Loop → review → shipped) as the Phase 1
  flagship.
- Add `data-tour-id="..."` attributes to the real components that flow's steps
  already describe (Issues screen, Factory/Loop trigger, review view, etc.) —
  this is the bulk of the desktop-side file-touch count.
- In `HelpGuide.tsx`, add a "Start tour" action alongside the flow's existing
  read-only step view (does not replace it — a user who wants to just read the
  steps still can).
- Flows not retrofitted this phase keep working exactly as they do today
  (text + deep-link button); nothing regresses for them.

## Extension implementation

- Introduce the same `TourStep`/`TourFlow` shape under
  `extension/src/sidepanel/help/` (new small module, not reusing desktop code).
- Build the extension's own `TourOverlay`/`useTour` — same shape, separate
  component, because the side panel is single-pane: `screenId` here means
  switching the `TABS` value in `App.tsx` rather than cross-screen navigation.
- Migrate **only** the Overview topic out of `HelpPanel.tsx`'s static prose
  into the new structured catalog, and author one new flow: **"record a
  meeting → generate notes"** (start capture on the Transcript tab → Generate
  Notes → view the result) as the Phase 1 flagship, with `data-tour-id`s added
  to the relevant Transcript/Notes tab elements.
- All other existing `HelpPanel.tsx` tabs/content (Questions, Chat, Settings,
  Platforms, Shortcuts, Troubleshooting, etc.) are left untouched this phase.

## Edge cases

- Target element not mounted (wrong tab/timing): tooltip still renders after a
  bounded wait, without a spotlight — degrade, don't hang.
- Resize/scroll during a tour: reposition continuously via `ResizeObserver` +
  scroll listener.
- User manually navigates away mid-tour (clicks a different section/tab
  themselves): the tour auto-dismisses with a toast ("Tour ended — you
  navigated away") rather than trying to reconcile state. Simpler and safer
  for Phase 1; revisit only if it proves annoying in practice.
- Esc key and an explicit "Skip tour" button both exit immediately. Nothing is
  persisted across tour exits (on-demand only, no "don't show again" state
  needed yet since there's no auto-popup).

## Testing

- `useTour`'s step-advance state machine: pure unit tests (start/next/back/skip
  bounds, no DOM involved).
- Extend the existing registry-coverage tests (the ones already checking
  `help.ts` topics/flows against `ui/screens/shell/sections.ts`) to also assert
  every `targetId`/`screenId` used by a retrofitted step resolves to a real,
  current id — catches drift the same way the existing coverage test does.
  Add the equivalent coverage check on the extension side for its new catalog
  against `TABS` in `App.tsx` (no such check exists there today).
- Manual click-through of both flagship tours in the actually-running app
  (desktop + extension) before calling Phase 1 done, per repo convention for
  UI-affecting changes.

## Cleanup

Per standing project convention, this spec file (and any plan file written
from it) is removed from the repo as part of finishing this branch, not left
behind after merge.
