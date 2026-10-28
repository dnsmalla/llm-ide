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
  type OsFileContent,
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
import {
  NativeTimeoutError,
  type BridgeValue,
  type NativeEvent,
  type NativeFeedStatus,
  type NativeReply,
  type NativeRequests,
  type ToNative,
} from './bridge';
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

/**
 * A file reply for the code preview: 200 carries the content (text or binary), 404 means the file is
 * not there (null), 401 signs the user out, and anything else is a failure.
 */
function fileBody(reply: NativeReply): OsFileContent | null {
  if (reply.status === 401) throw new OsAuthError();
  if (reply.status === 404) return null;
  if (reply.status !== 200) throw new Error(`The file could not be loaded (${reply.error ?? reply.status})`);
  if (!reply.body || typeof reply.body !== 'object') throw new Error('The file reply had no content');
  return reply.body as OsFileContent;
}

/** The storage types graph-kit's OsHost declares (its own type names are not exported from the package). */
type StorageSettings = Awaited<ReturnType<NonNullable<OsHost['storageSettings']>>>;
type ClearRequest = Parameters<NonNullable<OsHost['storageClear']>>[0];
type ClearResult = Awaited<ReturnType<NonNullable<OsHost['storageClear']>>>;
type CompactResult = Awaited<ReturnType<NonNullable<OsHost['storageCompact']>>>;

/**
 * A storage call the server refused or failed. graph-kit reads only `code` (a string) and the
 * message; its codes are PREVIEW_EXPIRED, PREVIEW_INVALID, preview_stale, PREVIEW_REQUIRED,
 * VALIDATION_FAILED for a clear, and busy, disk_space, store_down for a compact.
 */
export class StorageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/**
 * How long the page waits for native, per storage call. Native gives a clear or compact 120 s in total
 * (a 401 refresh included) and a read 12 s, so each page wait is longer than native's: the page gets
 * native's answer (a result, or 504 timeout), not its own timeout.
 */
const READ_WAIT_MS = 15_000;
const LONG_WAIT_MS = 130_000;

/** The operation whose failure codes are read. A clear or compact can complete after the page gave up. */
type StorageOp = 'read' | 'clear' | 'compact';

const TIMEOUT_MESSAGE = 'LLM-IDE did not answer in time. The operation may still have completed; check the storage figures before trying again.';

const STORAGE_MESSAGES: Record<string, string> = {
  store_down: 'The agent history store is not available. Restart LLM-IDE and try again.',
  busy: 'A chat turn or meeting run is in progress. Try again when it finishes.',
  disk_space: 'Not enough free disk space to compact the agent history.',
  PREVIEW_EXPIRED: 'The preview expired. Run a new preview.',
  PREVIEW_INVALID: 'The preview does not match this clear. Run a new preview.',
  preview_stale: 'The history changed since the preview. Run a new preview.',
  PREVIEW_REQUIRED: 'A clear needs a preview first.',
  VALIDATION_FAILED: 'The storage request was not valid.',
  timeout: TIMEOUT_MESSAGE,
  bad_reply: 'The server answered but the reply was unreadable; the operation may have completed.',
  unreachable: 'LLM-IDE did not answer.',
  failed: 'The storage call failed.',
};

/** The codes native sends that graph-kit reads as they are. Any other code becomes `failed`. */
const PASSED_CODES = new Set([
  'busy', 'disk_space', 'PREVIEW_EXPIRED', 'PREVIEW_INVALID', 'preview_stale', 'PREVIEW_REQUIRED',
  'VALIDATION_FAILED', 'store_down', 'timeout', 'bad_reply', 'unreachable',
]);

/**
 * Maps a native storage reply to graph-kit's storage codes. Store down is AGENT_STORE_UNAVAILABLE, or a
 * 503 from a compact; other 503s keep their code. 507 is disk_space, 504 is timeout, native's
 * not_allowed is VALIDATION_FAILED. A code outside the known set becomes `failed`.
 */
function storageCode(status: number, code: string | undefined, op: StorageOp): string {
  if (code === 'not_allowed') return 'VALIDATION_FAILED';
  if (code === 'AGENT_STORE_UNAVAILABLE' || (status === 503 && op === 'compact')) return 'store_down';
  if (status === 507) return 'disk_space';
  if (status === 504 || code === 'timeout') return 'timeout';
  if (status === 0 || code === 'unreachable') return 'unreachable';
  if (code !== undefined && PASSED_CODES.has(code)) return code;
  return 'failed';
}

/** The body of a 200 storage reply. 401 signs the user out; any other status throws a StorageError. */
function storageBody<T>(reply: NativeReply, op: StorageOp): T {
  if (reply.status === 401) throw new OsAuthError();
  if (reply.status === 200 && reply.body && typeof reply.body === 'object') return reply.body as T;
  const body = reply.body && typeof reply.body === 'object' ? (reply.body as { code?: unknown; message?: unknown }) : {};
  const serverCode = typeof body.code === 'string' ? body.code : reply.error;
  const code = storageCode(reply.status, serverCode, op);
  // A server message is already redacted by native. An unknown code shows the generic message instead.
  const serverMessage = typeof body.message === 'string' && code !== 'failed' ? body.message : undefined;
  throw new StorageError(code, serverMessage ?? STORAGE_MESSAGES[code] ?? STORAGE_MESSAGES.failed!);
}

/** A request the page refuses before it is sent. The message is the one the user sees. */
function refuse(message: string): never {
  throw new StorageError('VALIDATION_FAILED', message);
}

/**
 * A storage call with its page wait. A wait that runs out is `timeout`: a clear or compact may still
 * have completed on native. A read that runs out keeps its generic error.
 */
async function storageCall(run: Promise<NativeReply>, op: StorageOp): Promise<NativeReply> {
  try {
    return await run;
  } catch (err) {
    if (err instanceof NativeTimeoutError && op !== 'read') throw new StorageError('timeout', TIMEOUT_MESSAGE);
    throw err;
  }
}

export type NativeHostDeps = {
  /** The bridge's request/response map. */
  requests: Pick<NativeRequests, 'call' | 'native' | 'file'>;
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
    openFile: (path: string, line?: number): boolean =>
      post(line === undefined ? { type: 'openFile', path } : { type: 'openFile', path, line }),
    loadFile: async (path: string): Promise<OsFileContent | null> => fileBody(await requests.file(path)),
    loadProjectGraph: async (): Promise<unknown | null> =>
      nativeBody(await requests.native('projectGraph'), 'The project graph'),
    loadSkills: (): Promise<OsSkill[]> => refusedAsAuthError(fetchSkills(requester)),
    loadRoutines: async (): Promise<OsRoutine[]> =>
      toOsRoutines(nativeBody(await requests.native('routines'), 'The routines')),
    storageSettings: async (): Promise<StorageSettings> =>
      storageBody(await storageCall(requests.call('GET', '/kb/agent-history/settings', undefined, READ_WAIT_MS), 'read'), 'read'),
    setStorageRetention: async (days: number): Promise<StorageSettings> => {
      if (!Number.isInteger(days) || days < 7 || days > 365) refuse('Enter 7 to 365 whole days.');
      return storageBody(
        await storageCall(requests.call('PUT', '/kb/agent-history/settings', { retentionDays: days }, READ_WAIT_MS), 'read'),
        'read',
      );
    },
    storageClear: async (req: ClearRequest): Promise<ClearResult> => {
      if (req.scope !== 'raw' && req.scope !== 'all') refuse('Choose raw rows or all history.');
      if (typeof req.dryRun !== 'boolean') refuse('The clear request is not valid.');
      if (req.beforeDays != null && !(Number.isInteger(req.beforeDays) && req.beforeDays >= 0 && req.beforeDays <= 3650)) {
        refuse('The cutoff must be a whole number of days from 0 to 3650.');
      }
      // A real clear is only ever sent with the previewId of its dry run.
      if (!req.dryRun && !req.previewId) throw new StorageError('PREVIEW_REQUIRED', STORAGE_MESSAGES.PREVIEW_REQUIRED!);
      const body: Record<string, BridgeValue> = { scope: req.scope, dryRun: req.dryRun };
      if (req.beforeDays != null) body.beforeDays = req.beforeDays;
      if (req.previewId !== undefined) body.previewId = req.previewId;
      return storageBody(await storageCall(requests.call('POST', '/kb/agent-history/clear', body, LONG_WAIT_MS), 'clear'), 'clear');
    },
    storageCompact: async (): Promise<CompactResult> =>
      storageBody(await storageCall(requests.call('POST', '/kb/agent-history/compact', undefined, LONG_WAIT_MS), 'compact'), 'compact'),
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
    openFile: (): boolean => false,
    loadFile: async (): Promise<OsFileContent | null> => null,
    loadSkills: (): Promise<OsSkill[]> => refusedAsAuthError(fetchSkills(requester)),
  };
}
