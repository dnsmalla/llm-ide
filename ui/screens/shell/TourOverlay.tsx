// A guided tour: dims the screen, cuts a spotlight around the step's live element, and shows a tooltip card beside
// it via Floating. A step can ask to switch screens first; if its element never mounts, the card still shows,
// centered, without a spotlight — a step never hangs waiting for an element that will not appear.
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
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

/** Finds `[data-tour-id="id"]` in the live DOM for the whole life of the step: a target that arrives late (a run
 * reaching Done) or is replaced by the step's own click (Start) is picked up again; none found = card only. */
function useTourTarget(targetId: string | undefined): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(null);
    if (!targetId) return undefined;
    const find = () => document.querySelector<HTMLElement>(`[data-tour-id="${targetId}"]`);
    // A detached or zero-size node is stale (its own click unmounted it), so treat it as not found yet.
    const isLive = (node: HTMLElement | null): node is HTMLElement => {
      if (!node || !node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const check = () => {
      setEl((prev) => {
        if (isLive(prev)) return prev;
        const found = find();
        return isLive(found) ? found : null;
      });
    };
    // The desktop DOM churns constantly, so at most one layout read per frame.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; check(); });
    };
    check();
    // Never self-disconnects: the timeout only triggers one more check.
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const timeout = window.setTimeout(check, TARGET_WAIT_MS);
    return () => {
      mo.disconnect();
      window.clearTimeout(timeout);
      if (frame) window.cancelAnimationFrame(frame);
    };
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
  // Switch to the step's own screen once, when the step begins. If the user then navigates away on
  // their own (e.g. the tour's own call-to-action triggers a screen change), honor that instead of
  // snapping them back on every render — end the tour rather than fight the user's navigation.
  const switchedForStep = useRef(false);
  useEffect(() => { switchedForStep.current = false; }, [tour.index]);
  useEffect(() => {
    if (!step.screenId) return;
    if (step.screenId === activeSection) { switchedForStep.current = true; return; }
    if (!switchedForStep.current) {
      switchedForStep.current = true;
      onSelectSection(step.screenId);
    } else {
      onSkip();
    }
  }, [step.screenId, activeSection, onSelectSection, onSkip]);
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
      {/* No onDismiss: a tour step often asks the user to click something that is not the card itself
          (e.g. "click any issue card"), and Floating would end the tour on that very click. Skip/Next/
          Back and this file's own Escape listener below remain the ways out. */}
      <Floating anchor={target ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }} placement="below-start" className="tour-card" role="dialog" aria-modal="true" aria-label={tour.flow.title}>
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
