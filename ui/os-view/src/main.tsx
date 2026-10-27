import { createRoot } from 'react-dom/client';
import { mountOsView } from '@dnsmalla/graph-kit-web';
import { bootNative, type NativeSurface } from './boot';
import { hasNativeBridge, postToNative } from './bridge';
import { createDevHost } from './hosts';
import { DevConnect, type DevConnection } from './components/DevConnect';
// The page's own sheets come with the graph-kit import above; LLM-IDE's token sheet
// follows, so its values override graph-kit's defaults.
import './tokens.generated.css';
import './dev.css';

const root = document.getElementById('root');
if (!root) throw new Error('System view: #root is missing from index.html');

if (hasNativeBridge()) {
  // Native installs its callbacks on the window before it is told we are ready.
  bootNative(window as unknown as Partial<NativeSurface>, { root, post: postToNative });
} else {
  // Outside the app: the form connects straight to a server with a pasted token.
  const form = createRoot(root);
  const connect = (cfg: DevConnection) => {
    form.unmount();
    const host = createDevHost({
      conn: { baseURL: cfg.baseURL, token: cfg.token },
      fetch: (input, init) => fetch(input, init),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
    });
    mountOsView(root, host, { theme: cfg.theme, projectName: cfg.projectName ?? null });
  };
  form.render(<DevConnect onConnect={connect} />);
}
