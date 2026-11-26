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
