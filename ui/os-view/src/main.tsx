import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, hasNativeBridge, postToNative, type NativeConfig } from './bridge';
import { OsController } from './controller';
import './styles.css';

// Default is the dark theme; native sends the real one with llmideConfigure.
applyTheme(undefined, document.documentElement);

const controller = new OsController({
  fetch: (input, init) => fetch(input, init),
  post: (message) => postToNative(message),
  mode: hasNativeBridge() ? 'native' : 'dev',
  applyTheme: (theme) => {
    applyTheme(theme, document.documentElement);
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
});

// Installed before "ready" is posted, so a configure sent straight back is not lost.
(window as unknown as { llmideConfigure: (cfg: NativeConfig) => void }).llmideConfigure = (cfg) => {
  controller.configure(cfg);
};

const root = document.getElementById('root');
if (!root) throw new Error('System view: #root is missing from index.html');
createRoot(root).render(<App controller={controller} />);

controller.start();
