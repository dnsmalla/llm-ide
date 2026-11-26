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
