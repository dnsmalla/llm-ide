// A guided tour for the side panel: dims the panel, cuts a spotlight around the step's live element, and shows a
// tooltip card next to it (placeCard does the positioning math). A step can ask to switch tabs first; if its
// element never mounts, the card still shows, centered, without a spotlight.
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { currentStep, isLastStep, tourReducer, type TourFlow, type TourState, type TourStep } from './tour-model';
import { placeCard } from './placement';
import { pickTarget } from './tour-target';
import type { Tab } from '../tabs';

const TARGET_WAIT_MS = 1500;

export function useTour(): {
  tour: TourState | null;
  start: (flow: TourFlow) => void;
  next: () => void;
  back: () => void;
  skip: () => void;
} {
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
    // Not "live" once the step's own action unmounts it (Start Recording -> Stop Recording) or it
    // collapses to zero size — either way the spotlight must stop pinning on the stale reference.
    const isLive = (node: HTMLElement): boolean => {
      if (!node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    // Lock-on: once found, never jump to another match with the same id.
    let locked: HTMLElement | null = null;
    const check = () => {
      const candidates = locked ? [] : Array.from(document.querySelectorAll<HTMLElement>(`[data-tour-id="${targetId}"]`));
      const picked = pickTarget(locked, candidates, isLive);
      if (picked) locked = picked;
      setEl(picked);
    };
    check();
    // Never disconnects itself: a target missing at TARGET_WAIT_MS degrades to a spotlight-less card
    // for now (el stays null), but a slow target (e.g. notes still generating) can still be picked up
    // once it finally appears. A found target is locked: if it later unmounts the spotlight drops, no re-search.
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-tour-id'] });
    const timeout = window.setTimeout(check, TARGET_WAIT_MS);
    return () => {
      mo.disconnect();
      window.clearTimeout(timeout);
    };
  }, [targetId]);
  return el;
}

export default function TourOverlay({
  tour,
  activeTab,
  onSelectTab,
  onNext,
  onBack,
  onSkip,
}: {
  tour: TourState;
  activeTab: Tab;
  onSelectTab: (id: Tab) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}): ReactNode {
  const step = currentStep(tour) as TourStep;
  const switching = step.screenId !== undefined && step.screenId !== activeTab;
  // Switch to the step's own tab once, when the step begins. If the user then navigates away on
  // their own (e.g. to check something the step's copy referenced), honor that instead of snapping
  // them back on every render — end the tour rather than fight the user's navigation.
  const switchedForStep = useRef(false);
  useEffect(() => {
    switchedForStep.current = false;
  }, [tour.index]);
  useEffect(() => {
    if (!step.screenId) return;
    if (step.screenId === activeTab) {
      switchedForStep.current = true;
      return;
    }
    if (!switchedForStep.current) {
      switchedForStep.current = true;
      onSelectTab(step.screenId);
    } else {
      onSkip();
    }
  }, [step.screenId, activeTab, onSelectTab, onSkip]);
  const target = useTourTarget(switching ? undefined : step.targetId);
  const last = isLastStep(tour);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSkip();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onSkip]);

  const [cardSize, setCardSize] = useState({ width: 240, height: 140 });
  const rect = target?.getBoundingClientRect();
  const placed = rect ? placeCard(rect, cardSize, window.innerWidth, window.innerHeight) : null;

  return (
    <div className="tour-layer" aria-hidden={false}>
      {rect ? (
        <div
          aria-hidden="true"
          className="tour-spotlight"
          style={{
            position: 'fixed',
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            borderRadius: 8,
            boxShadow: '0 0 0 9999px rgba(10,10,14,0.55)',
            pointerEvents: 'none',
            zIndex: 999,
          }}
        />
      ) : (
        <div
          aria-hidden="true"
          className="tour-backdrop"
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,14,0.35)', pointerEvents: 'none', zIndex: 999 }}
        />
      )}
      <div
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-label={tour.flow.title}
        ref={(el) => {
          if (el && (el.offsetWidth !== cardSize.width || el.offsetHeight !== cardSize.height))
            setCardSize({ width: el.offsetWidth, height: el.offsetHeight });
        }}
        style={{
          position: 'fixed',
          top: placed?.top ?? window.innerHeight / 2 - 70,
          left: placed?.left ?? 16,
          zIndex: 1000,
          width: 240,
        }}
      >
        <p className="tour-step-count">
          {tour.flow.title} · step {tour.index + 1} of {tour.flow.steps.length}
        </p>
        <h4 className="tour-title">{step.title}</h4>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="btn btn-sm" onClick={onSkip}>
            Skip tour
          </button>
          <button type="button" className="btn btn-sm" disabled={tour.index === 0} onClick={onBack}>
            ← Back
          </button>
          <button type="button" className="btn btn-sm btn-generate" onClick={last ? onSkip : onNext}>
            {last ? 'Finish' : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  );
}
