// Error mapping: every error the core (or the host fs) can raise for Doc Gen / Visual becomes a short, actionable
// sentence. Server text is never shown raw (it may echo user content); only the code and status pick the wording.

export interface Failure {
  /** Wording for the user. */
  message: string;
  /** Worth a "Try again" button (transient). */
  retryable: boolean;
  /** Needs the user to act somewhere else (sign in, choose a provider...). */
  action: "sign_in" | "settings" | "open_project" | "none";
}

interface ErrLike {
  status?: unknown;
  code?: unknown;
}

const BY_CODE: Readonly<Record<string, Failure>> = {
  VALIDATION_FAILED: { message: "The core refused this request. Check that a template or command and at least one source are set.", retryable: false, action: "none" },
  AUTH_REQUIRED: { message: "You are signed out of the core. Sign in again, then retry.", retryable: false, action: "sign_in" },
  SESSION_EXPIRED: { message: "Your session expired. Sign in again, then retry.", retryable: false, action: "sign_in" },
  NO_SESSION: { message: "Sign in to the core first.", retryable: false, action: "sign_in" },
  RATE_LIMITED: { message: "Too many requests right now. Wait a few seconds and try again.", retryable: true, action: "none" },
  feature_disabled: { message: "Doc Gen is turned off in this core's feature set (LLMIDE_FEATURES), so it cannot generate.", retryable: false, action: "settings" },
  INTERNAL_ERROR: { message: "The core hit an internal error. Try again; if it keeps happening, check the core log.", retryable: true, action: "none" },
  PAYLOAD_TOO_LARGE: { message: "The request was too large. Select fewer or smaller sources.", retryable: false, action: "none" },
  PROVIDER_UNAVAILABLE: { message: "No model provider is available. Check Settings, Providers.", retryable: true, action: "settings" },
  PROVIDER_RATE_LIMITED: { message: "The model provider is rate limiting you. Wait a moment and try again.", retryable: true, action: "none" },
  PROVIDER_ERROR: { message: "The model provider returned an error. Try again.", retryable: true, action: "none" },
  PROVIDER_BLOCKED: { message: "The model provider blocked this request.", retryable: false, action: "settings" },
  PROVIDER_AUTH: { message: "The model provider rejected your credentials. Check Settings, Providers.", retryable: false, action: "settings" },
  MODEL_REJECTED: { message: "The selected model rejected this request. Choose another model in Settings.", retryable: false, action: "settings" },
  CLAUDE_NOT_FOUND: { message: "The Claude CLI was not found. Install it or add an API key in Settings.", retryable: false, action: "settings" },
  CLAUDE_CODE_OAUTH: { message: "The Claude CLI needs you to sign in (claude login).", retryable: false, action: "settings" },
  TIMEOUT: { message: "The core did not answer in time.", retryable: true, action: "none" },
  NETWORK: { message: "Cannot reach the core. It may be restarting.", retryable: true, action: "none" },
  UNTRUSTED_CORE: { message: "This core was not started by LLM-IDE and has not been confirmed, so nothing was sent.", retryable: false, action: "settings" },
  UNSAFE_URL: { message: "Refusing to contact a non-local core.", retryable: false, action: "settings" },
  BAD_RESPONSE: { message: "The core sent an answer this version cannot read. Update the app or the core.", retryable: false, action: "none" },
  PROJECT_NOT_REGISTERED: { message: "The core does not know this project yet. Reopen the screen to register it.", retryable: true, action: "none" },
  INVALID_ROOT: { message: "The core refused this project folder (too broad, not a folder, or not an LLM-IDE project).", retryable: false, action: "open_project" },
  INVALID_PROJECT_ID: { message: "The project id was refused by the core.", retryable: false, action: "none" },
  TOO_MANY_PROJECTS: { message: "The core has too many registered projects. Remove unused ones and retry.", retryable: false, action: "none" },
  INVALID_FOLDER: { message: "That template name cannot be used as a folder name. Use letters, numbers and dashes.", retryable: false, action: "none" },
  RESERVED_FOLDER: { message: "That name is reserved. Choose another template name.", retryable: false, action: "none" },
  UNSAFE_PATH: { message: "The core refused that path as unsafe.", retryable: false, action: "none" },
  TOO_LARGE: { message: "That template is too large to save.", retryable: false, action: "none" },
  DOCS_FAILED: { message: "The core could not complete the templates request. Try again.", retryable: true, action: "none" },
};

const BY_FS: Readonly<Record<string, string>> = {
  no_project: "Open a project first.",
  root_too_broad: "That project folder is too broad to use.",
  invalid_path: "That is not a valid path.",
  outside_root: "That path is outside the project.",
  not_found: "The file or folder no longer exists.",
  exists: "A file with that name already exists.",
  conflict: "The file changed on disk since it was read.",
  too_large: "That file is too large.",
  not_regular: "That is not a regular file.",
  hardlink: "That file is a hard link and was refused for safety.",
  not_a_directory: "That is not a folder.",
  permission_denied: "The app does not have permission to do that. Check folder access in System Settings.",
  unsupported_encoding: "That file is not text this app can read.",
  unavailable: "This needs the desktop app.",
  io: "The file system reported an error.",
};

const STATUS_FALLBACK: Readonly<Record<number, string>> = {
  400: "The core refused this request.",
  401: "You are signed out of the core.",
  403: "The core refused this request.",
  404: "The core does not offer this feature.",
  409: "That conflicts with something that already exists.",
  413: "The request was too large.",
  429: "Too many requests right now. Wait a few seconds and try again.",
  500: "The core hit an internal error.",
  502: "The core could not reach the model provider.",
  503: "The core is not ready. Try again in a moment.",
  504: "The core did not answer in time.",
};

/** Maps a thrown value (CoreError, FsError, anything) to a user-facing failure. Never returns raw server text. */
export function describeFailure(e: unknown): Failure {
  const o: ErrLike = typeof e === "object" && e !== null ? (e as ErrLike) : {};
  const code = typeof o.code === "string" ? o.code : "";
  const status = typeof o.status === "number" ? o.status : 0;
  if (code && Object.hasOwn(BY_CODE, code)) return BY_CODE[code]!;
  if (code && Object.hasOwn(BY_FS, code)) return { message: BY_FS[code]!, retryable: code === "io" || code === "conflict", action: code === "no_project" ? "open_project" : "none" };
  if (status && Object.hasOwn(STATUS_FALLBACK, status)) return { message: STATUS_FALLBACK[status]!, retryable: status >= 500 || status === 429, action: status === 401 ? "sign_in" : "none" };
  return { message: "Something went wrong. Try again.", retryable: true, action: "none" };
}

/** True when the failure is the user's own cancel (silent). */
export function isCancel(e: unknown): boolean {
  return (typeof e === "object" && e !== null && ((e as ErrLike).code === "ABORTED" || (e as { name?: unknown }).name === "AbortError"));
}
