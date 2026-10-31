import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreClient, CoreResponse } from "../core-api.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The recorded `response` of a schema/http fixture (and its status). */
export function fixture(rel: string): { status: number; request: unknown; response: unknown } {
  const j = JSON.parse(readFileSync(join(REPO, "schema/http/fixtures", rel), "utf8"));
  return { status: j.status, request: j.request, response: j.response };
}

export const reply = (rel: string): CoreResponse => {
  const f = fixture(rel);
  return { status: f.status, body: f.response };
};

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export type Handler = (body: unknown, call: Call) => CoreResponse | Promise<CoreResponse>;

/** A scripted core: `routes["POST /kb/x"]` answers; unknown routes answer 404. Records every call. */
export function fakeClient(routes: Record<string, Handler>): CoreClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request(method, path, body) {
      const c = { method, path, body };
      calls.push(c);
      const h = routes[`${method} ${path}`];
      if (!h) return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      return h(body, c);
    },
  };
}

/** A promise you resolve by hand, to interleave requests deterministically. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}
