// The screen's door to the core's Extensions routes. A request function is injected (the shell's core
// client owns the base URL, the token and the nonce check); this module builds only fixed paths and
// JSON bodies, decodes every answer, and never sees a token. Routes that reach GitHub or the MCP
// registry are POSTs the user started; the GETs read the core's cache only.
import { ExtApiError, toExtApiError, type ExtResponse } from "./errors.ts";
import {
  DecodeError,
  decodeActive,
  decodeCatalog,
  decodeCheck,
  decodeInstalled,
  decodeItemResult,
  decodeOk,
  decodePreview,
  decodeRefresh,
  decodeRepair,
  decodeRollback,
  decodeUpdateApplied,
  type ActiveSummary,
  type CatalogPage,
  type CheckResult,
  type InstalledList,
  type ItemResult,
  type RefreshResult,
  type RepairResult,
  type UpdateApplied,
  type UpdatePreview,
} from "./decoders.ts";

export interface ExtRequestOptions {
  signal?: AbortSignal;
  /** Routes that download from GitHub can take longer than the default request deadline. */
  slow?: boolean;
}

export interface ExtCore {
  request(method: "GET" | "POST", path: string, body: unknown, opts: ExtRequestOptions): Promise<ExtResponse>;
}

export interface ExtensionsApi {
  installed(signal?: AbortSignal): Promise<InstalledList>;
  active(signal?: AbortSignal): Promise<ActiveSummary>;
  catalog(q: { query: string; kind: string | null; limit: number; offset: number }, signal?: AbortSignal): Promise<CatalogPage>;
  refreshCatalog(signal?: AbortSignal): Promise<RefreshResult>;
  install(req: { url: string; path: string | null }, signal?: AbortSignal): Promise<ItemResult>;
  toggle(req: { id: string; enabled: boolean; consents?: readonly string[] }, signal?: AbortSignal): Promise<ItemResult>;
  toggleMember(req: { id: string; memberId: string; enabled: boolean }, signal?: AbortSignal): Promise<ItemResult>;
  uninstall(id: string, signal?: AbortSignal): Promise<void>;
  checkUpdates(id: string | null, signal?: AbortSignal): Promise<CheckResult>;
  previewUpdate(req: { id: string; commit: string | null }, signal?: AbortSignal): Promise<UpdatePreview>;
  applyUpdate(req: { id: string; commit: string; consents: readonly string[] | null }, signal?: AbortSignal): Promise<UpdateApplied>;
  rollback(id: string, signal?: AbortSignal): Promise<UpdateApplied>;
  repair(id: string, signal?: AbortSignal): Promise<RepairResult>;
}

const BASE = "/auth/me/extensions";

export function createExtensionsApi(core: ExtCore): ExtensionsApi {
  async function call<T>(method: "GET" | "POST", path: string, body: unknown, decode: (b: unknown) => T, opts: ExtRequestOptions = {}): Promise<T> {
    let res: ExtResponse;
    try {
      res = await core.request(method, path, body, opts);
    } catch (e) {
      if (e instanceof ExtApiError) throw e;
      if (opts.signal?.aborted) throw new ExtApiError(0, "ABORTED");
      throw new ExtApiError(0, "UNREACHABLE");
    }
    if (res.status < 200 || res.status >= 300) throw toExtApiError(res);
    try {
      return decode(res.body);
    } catch (e) {
      if (e instanceof DecodeError) throw new ExtApiError(res.status, "BAD_RESPONSE");
      throw e;
    }
  }
  const post = <T>(path: string, body: unknown, decode: (b: unknown) => T, signal?: AbortSignal, slow = false): Promise<T> => call("POST", path, body, decode, { signal, slow });
  const qs = (q: { query: string; kind: string | null; limit: number; offset: number }): string => {
    const p = new URLSearchParams();
    if (q.query !== "") p.set("q", q.query.slice(0, 200));
    if (q.kind) p.set("kind", q.kind);
    p.set("limit", String(Math.min(100, Math.max(1, Math.trunc(q.limit)))));
    p.set("offset", String(Math.max(0, Math.trunc(q.offset))));
    return p.toString();
  };
  return {
    installed: (signal) => call("GET", `${BASE}/installed`, undefined, decodeInstalled, { signal }),
    active: (signal) => call("GET", `${BASE}/active`, undefined, decodeActive, { signal }),
    catalog: (q, signal) => call("GET", `${BASE}/catalog?${qs(q)}`, undefined, decodeCatalog, { signal }),
    refreshCatalog: (signal) => post(`${BASE}/catalog/refresh`, {}, decodeRefresh, signal, true),
    install: (req, signal) => post(`${BASE}/install`, req.path ? { url: req.url, path: req.path } : { url: req.url }, decodeItemResult, signal, true),
    toggle: (req, signal) => post(`${BASE}/toggle`, req.consents && req.consents.length > 0 ? { id: req.id, enabled: req.enabled, consents: [...req.consents] } : { id: req.id, enabled: req.enabled }, decodeItemResult, signal),
    toggleMember: (req, signal) => post(`${BASE}/toggle`, { id: req.id, members: [req.memberId], enabled: req.enabled }, decodeItemResult, signal),
    uninstall: (id, signal) => post(`${BASE}/uninstall`, { id }, decodeOk, signal),
    checkUpdates: (id, signal) => post(`${BASE}/updates/check`, id ? { id } : {}, decodeCheck, signal, true),
    previewUpdate: (req, signal) => post(`${BASE}/update/preview`, req.commit ? { id: req.id, commit: req.commit } : { id: req.id }, decodePreview, signal, true),
    applyUpdate: (req, signal) => post(`${BASE}/update`, req.consents && req.consents.length > 0 ? { id: req.id, commit: req.commit, consents: [...req.consents] } : { id: req.id, commit: req.commit }, decodeUpdateApplied, signal, true),
    rollback: (id, signal) => post(`${BASE}/rollback`, { id }, decodeRollback, signal),
    repair: (id, signal) => post(`${BASE}/repair`, { id }, decodeRepair, signal, true),
  };
}
