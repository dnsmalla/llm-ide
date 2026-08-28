// Render cases for the React runtime smoke check (`npm run test:render`).
//
// WHY THIS EXISTS: the main suite runs on node's test runner with
// --experimental-strip-types, which handles .ts but NOT .tsx — so no test
// there can import a component, and type-check + build + lint passing says
// nothing about whether React actually renders. A dependabot PR once bumped
// react to 19 while leaving react-dom at 18: types compiled, the bundle
// built, 1287 tests passed, and the dependency tree was invalid. This file
// is the coverage that would have caught it.
//
// Deliberately dependency-free: rendered through react-dom/server with the
// vite pipeline the app already uses. No jsdom, no testing-library.
//
// Only components that touch no browser APIs belong here. renderToString
// runs useState initialisers but never useEffect, so a component reaching for
// chrome.* / window.* / fetch belongs in a real DOM harness instead.
import { renderToString } from 'react-dom/server';
import { version as reactVersion } from 'react';
import LanguageSelector from '../../src/sidepanel/components/LanguageSelector';
import LoginView from '../../src/sidepanel/components/LoginView';
import RecordingControls from '../../src/sidepanel/components/RecordingControls';
import NotesView from '../../src/sidepanel/components/NotesView';

export interface RenderCase {
  name: string;
  /** Lazy so the runner can catch a throw and name the case that threw. */
  render: () => string;
  /** Substrings the render MUST contain, so an empty render cannot pass. */
  expect: string[];
}

const noop = () => {};

export function getCases(): { reactVersion: string; cases: RenderCase[] } {
  const cases: RenderCase[] = [
    {
      name: 'LanguageSelector (stateless, props-driven)',
      render: () =>
        renderToString(
          <LanguageSelector
            primaryLang="en"
            secondaryLang="ja"
            bilingual={false}
            onChangePrimary={noop}
            onChangeSecondary={noop}
            onToggleBilingual={noop}
          />,
        ),
      expect: ['<select', '<option', 'language-selector'],
    },
    {
      // 4 useState hooks — exercises React's hook dispatcher, not just
      // element creation.
      name: 'LoginView (4 useState hooks)',
      render: () =>
        renderToString(
          <LoginView
            onLogin={async () => true}
            onRegister={async () => true}
            busy={false}
            error={null}
            registrationOpen
          />,
        ),
      expect: ['<input', '<button'],
    },
    {
      name: 'RecordingControls (conditional branches)',
      render: () => renderToString(<RecordingControls isRecording={false} elapsed={0} onStart={noop} onStop={noop} />),
      expect: ['<button'],
    },
    {
      name: 'NotesView (error + empty states)',
      render: () =>
        renderToString(
          <NotesView notes="" isGenerating={false} error={null} onGenerate={noop} hasTranscript={false} />,
        ),
      expect: ['<button'],
    },
  ];
  return { reactVersion, cases };
}
