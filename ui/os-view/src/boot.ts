// Start-up for the native mode, kept out of main.tsx so the order of operations
// can be tested. main.tsx only chooses the mode.
import { mountOsView, type MountOptions, type OsHost, type OsViewHandle } from '@dnsmalla/graph-kit-web';
import { NativeRequests, type NativeConfig, type NativeEvent, type NativeFeedStatus, type ToNative } from './bridge';
import { createNativeHost, type NativeHost } from './hosts';

export const WAITING_TEXT = 'Waiting for LLM-IDE to send the connection.';
export const SIGNED_OUT_NOTICE = 'Your LLM-IDE session has ended. Sign in to LLM-IDE again.';
export const OPEN_FALLBACK_NOTICE = 'Open this in the LLM-IDE app.';

/** The functions native calls. Each must exist before "ready" is posted. */
export type NativeSurface = {
  llmideConfigure: (cfg: NativeConfig) => void;
  llmideResponse: (id: string, reply: unknown) => void;
  llmideEvent: (event: NativeEvent) => void;
  llmideStatus: (status: { status: NativeFeedStatus; detail?: string }) => void;
};

export type MountFn = (root: HTMLElement, host: OsHost, opts: MountOptions) => OsViewHandle;

export type NativeBootDeps = {
  root: HTMLElement;
  post: (message: ToNative) => boolean;
  /** Defaults to the real mountOsView; tests pass a fake. */
  mount?: MountFn;
  /** Defaults to a NativeRequests on the window timers. */
  requests?: NativeRequests;
};

/**
 * Inside the Mac app. Installs the llmide* functions on `scope`, then posts
 * "ready" so a configure sent straight back is never lost. The first configure
 * mounts the page; later ones reconfigure it.
 */
export function bootNative(scope: Partial<NativeSurface> & object, deps: NativeBootDeps): NativeHost {
  const { root, post } = deps;
  const mount = deps.mount ?? mountOsView;
  const requests =
    deps.requests ??
    new NativeRequests(
      (message) => post(message),
      (fn, ms) => window.setTimeout(fn, ms),
      (handle) => window.clearTimeout(handle as number),
    );
  const host = createNativeHost({ requests, post });

  root.textContent = WAITING_TEXT;
  let handle: OsViewHandle | null = null;

  const s = scope as NativeSurface;
  s.llmideConfigure = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    if (handle) {
      handle.configure(cfg);
      return;
    }
    handle = mount(root, host, {
      theme: cfg.theme,
      projectName: cfg.projectName ?? null,
      signedOutNotice: SIGNED_OUT_NOTICE,
      openFallbackNotice: OPEN_FALLBACK_NOTICE,
    });
  };
  s.llmideResponse = (id, reply) => requests.settle(id, reply);
  s.llmideEvent = (event) => host.nativeEvent(event);
  s.llmideStatus = (status) => {
    if (status && typeof status === 'object') host.nativeStatus(status.status, status.detail);
  };

  post({ type: 'ready' });
  return host;
}

