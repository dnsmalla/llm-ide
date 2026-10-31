import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtCore, ExtRequestOptions } from "../api.ts";
import type { ExtResponse } from "../errors.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const DIR = join(REPO, "schema/http/fixtures/extensions");

export interface Fx {
  endpoint: string;
  status: number;
  request: { body?: unknown; query?: unknown } | undefined;
  response: unknown;
}
export const fx = (name: string): Fx => {
  const j = JSON.parse(readFileSync(join(DIR, name.endsWith(".json") ? name : `${name}.json`), "utf8"));
  return { endpoint: j.endpoint, status: j.status, request: j.request, response: j.response };
};
export const allFixtureNames = (): string[] => readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
/** The recorded answer of a fixture, as a core response. */
export const reply = (name: string): ExtResponse => {
  const f = fx(name);
  return { status: f.status, body: f.response };
};

export interface Call {
  method: string;
  path: string;
  body: unknown;
  opts: ExtRequestOptions;
}
export type Handler = (call: Call) => ExtResponse | Promise<ExtResponse>;

/** A scripted core: `routes["POST /auth/me/extensions/toggle"]` answers (query stripped from the key); unknown routes answer 404. */
export function fakeCore(routes: Record<string, Handler>): ExtCore & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request(method, path, body, opts) {
      const call = { method, path, body, opts };
      calls.push(call);
      const key = `${method} ${path.split("?")[0]}`;
      const h = routes[key];
      if (!h) return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      return h(call);
    },
  };
}

export const err = (status: number, code: string, details?: Record<string, unknown>): ExtResponse => ({ status, body: { error: { code, message: "server text", details } } });

/** A promise you resolve by hand (races). */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
