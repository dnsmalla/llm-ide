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
