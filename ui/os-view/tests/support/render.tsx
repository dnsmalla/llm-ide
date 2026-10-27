// Test-only helper, loaded through Vite's SSR loader (see tests/os-view.test.mjs).
import { renderToString } from 'react-dom/server';
import { DevConnect } from '../../src/components/DevConnect';

export function renderDevConnect(): string {
  return renderToString(<DevConnect onConnect={() => undefined} />);
}
