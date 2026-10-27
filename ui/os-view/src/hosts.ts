// The two OsHost implementations LLM-IDE supplies to graph-kit's System page.
//
//   native  inside the Mac app. Every call goes over the bridge; native holds the
//           token and its own allowlist. The change feed is a subscribe/unsubscribe
//           pair, and its events arrive through nativeEvent / nativeStatus, which
//           llmideEvent / llmideStatus call.
//   dev     `npm run dev`. Calls and the change feed go straight to the server with
//           a pasted token (see DevConnect).
//
// The page itself (graph-kit web/) has no transport. Native supplies the project
// graph and routines (native-only data, `{type:'native'}`); skills come from the
// server's skill library, through native in the app and direct in dev.
import {
  OsAuthError,
  type OsCancel,
  type OsHost,
  type OsLiveStatus,
  type OsOpenTarget,
  type OsRange,
  type OsRoutine,
  type OsSkill,
  type OsSnapshot,
} from '@dnsmalla/graph-kit-web';
import {
  HttpError,
  directRequester,
  fetchOsState,
  fetchSkills,
  sendCancel,
  toOsRoutines,
  type Connection,
  type FetchLike,
  type Requester,
} from './api';
import type { NativeEvent, NativeFeedStatus, NativeReply, NativeRequests, ToNative } from './bridge';
import { OsStream } from './stream';

/** Maps the server's 401 to the error graph-kit reads as "session refused". Other errors pass through. */
async function refusedAsAuthError<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) throw new OsAuthError();
    throw err;
  }
}

/** A native-only reply: 200 with the body, 401 when the session is refused, anything else is a failure. */
function nativeBody(reply: NativeReply, what: string): unknown {
  if (reply.status === 401) throw new OsAuthError();
  if (reply.status !== 200) throw new Error(`${what} could not be loaded (${reply.error ?? reply.status})`);
  return reply.body ?? null;
}

export type NativeHostDeps = {
  /** The bridge's request/response map. */
  requests: Pick<NativeRequests, 'call' | 'native'>;
  /** Posts one message to native. false when there is no bridge. */
  post: (message: ToNative) => boolean;
};

export type NativeHost = OsHost & {
  /** Forwards one change event from llmideEvent. `hello` is ignored; anything else means "state changed". */
  nativeEvent(event: NativeEvent): void;
  /** Forwards the feed's state from llmideStatus. */
  nativeStatus(status: NativeFeedStatus, detail?: string): void;
};

type Watch = { onChange: () => void; onStatus: (status: OsLiveStatus, detail?: string) => void };

export function createNativeHost({ requests, post }: NativeHostDeps): NativeHost {
  const requester: Requester = (method, path, body) => requests.call(method, path, body);
  let current: Watch | null = null;

  return {
    loadState: (range: OsRange): Promise<OsSnapshot> => refusedAsAuthError(fetchOsState(requester, range)),
    cancel: (request: NonNullable<OsCancel>): Promise<void> => refusedAsAuthError(sendCancel(requester, request)),
    watch(onChange, onStatus) {
      const mine: Watch = { onChange, onStatus };
      current = mine;
      post({ type: 'subscribe' });
      return () => {
        if (current !== mine) return;
        current = null;
        post({ type: 'unsubscribe' });
      };
    },
    open: (target: OsOpenTarget): boolean => post({ type: 'open', target }),
    loadProjectGraph: async (): Promise<unknown | null> =>
      nativeBody(await requests.native('projectGraph'), 'The project graph'),
    loadSkills: (): Promise<OsSkill[]> => refusedAsAuthError(fetchSkills(requester)),
    loadRoutines: async (): Promise<OsRoutine[]> =>
      toOsRoutines(nativeBody(await requests.native('routines'), 'The routines')),
    nativeEvent(event) {
      if (!event || typeof event.type !== 'string' || event.type === 'hello') return;
      current?.onChange();
    },
    nativeStatus(status, detail) {
      current?.onStatus(status, detail);
    },
  };
}

export type DevHostDeps = {
  conn: Connection;
  fetch: FetchLike;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

export function createDevHost({ conn, fetch, setTimer, clearTimer }: DevHostDeps): OsHost {
  const requester = directRequester(conn, fetch);
  return {
    loadState: (range: OsRange): Promise<OsSnapshot> => refusedAsAuthError(fetchOsState(requester, range)),
    cancel: (request: NonNullable<OsCancel>): Promise<void> => refusedAsAuthError(sendCancel(requester, request)),
    watch(onChange, onStatus) {
      const stream = new OsStream({
        fetch,
        setTimer,
        clearTimer,
        onStatus: (live, detail) => onStatus(live, detail),
        onEvent: () => onChange(),
        // The stream stops on a 401. Reporting a change makes graph-kit re-fetch, and that
        // fetch is the one that comes back 401 and shows the signed-out notice.
        onAuthError: () => {
          onStatus('stopped');
          onChange();
        },
      });
      stream.start(conn);
      return () => stream.stop();
    },
    open: (): boolean => false,
    loadSkills: (): Promise<OsSkill[]> => refusedAsAuthError(fetchSkills(requester)),
  };
}
