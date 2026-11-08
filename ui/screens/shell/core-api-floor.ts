// The API version floor the shell checks a running core against. The app is built with the core it bundles, so
// `APP_API_VERSION` must match `SERVER_API_VERSION` in extension/server.mjs (a drift test pins it). A source checkout
// or an adopted core can be older than the app; `/health` reports its `apiVersion`, and a lower number gets a warning.

export const APP_API_VERSION = 125;

/**
 * The warning for a core whose /health reports an API older than this app, or null when it is current or newer.
 * A /health without a numeric `apiVersion` is a core from before the field existed, so it is older than any floor
 * (the Mac's BackendManager.isVersionTooOld treats a missing version the same way).
 */
export function coreApiWarning(coreApiVersion: unknown, appApi: number = APP_API_VERSION): string | null {
  if (typeof coreApiVersion !== "number" || !Number.isFinite(coreApiVersion)) {
    return `The backend does not report its API version, so it is older than this app expects (API ${appApi} or newer). Some features may fail. Restart the backend, or update the source checkout it runs from.`;
  }
  if (coreApiVersion >= appApi) return null;
  return `The backend reports API ${coreApiVersion}, but this app expects API ${appApi} or newer. Some features may fail. Restart the backend, or update the source checkout it runs from.`;
}
