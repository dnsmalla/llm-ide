import { createRoot } from 'react-dom/client';
import { App } from './App';
import {
  NativeRequests,
  applyTheme,
  hasNativeBridge,
  postToNative,
  type NativeConfig,
  type NativeEvent,
  type NativeFeedStatus,
} from './bridge';
import { OsController } from './controller';
import './styles.css';

// Default is the dark theme; native sends the real one with llmideConfigure.
applyTheme(undefined, document.documentElement);

const native = hasNativeBridge();
const requests = new NativeRequests(
  (message) => postToNative(message),
  (fn, ms) => window.setTimeout(fn, ms),
  (handle) => window.clearTimeout(handle as number),
);

const controller = new OsController({
  mode: native ? 'native' : 'dev',
  requester: native ? (method, path, body) => requests.call(method, path, body) : undefined,
  fetch: (input, init) => fetch(input, init),
  post: (message) => postToNative(message),
  applyTheme: (theme) => {
    applyTheme(theme, document.documentElement);
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
});

// Native calls these; each is installed before "ready" is posted, so a configure
// sent straight back is not lost.
const bridge = window as unknown as {
  llmideConfigure: (cfg: NativeConfig) => void;
  llmideResponse: (id: string, reply: unknown) => void;
  llmideEvent: (event: NativeEvent) => void;
  llmideStatus: (status: { status: NativeFeedStatus; detail?: string }) => void;
};
bridge.llmideConfigure = (cfg) => {
  controller.configure(cfg);
};
bridge.llmideResponse = (id, reply) => {
  requests.settle(id, reply);
};
bridge.llmideEvent = (event) => {
  controller.nativeEvent(event);
};
bridge.llmideStatus = (status) => {
  if (status && typeof status === 'object') controller.nativeStatus(status.status, status.detail);
};

const root = document.getElementById('root');
if (!root) throw new Error('System view: #root is missing from index.html');
createRoot(root).render(<App controller={controller} />);

controller.start();
