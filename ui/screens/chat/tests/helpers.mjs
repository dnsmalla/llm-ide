// Bundles the chat screen sources once per test file (esbuild from desktop/node_modules, React externalised
// so there is a single copy), and exposes fixtures and a fake core transport.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CHAT = resolve(HERE, "..");
export const REPO = resolve(CHAT, "../../..");
const DESKTOP = join(REPO, "desktop");
const require = createRequire(join(DESKTOP, "package.json"));

export const h = require("react").createElement;
export const renderToStaticMarkup = require("react-dom/server").renderToStaticMarkup;

export async function loadChat(name = "chat") {
  const { build } = require("esbuild");
  const dir = bundleDir("chat");
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent",
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") },
  });
  return import(`${outfile}?t=${Date.now()}`);
}

export const FIXTURE_DIR = join(REPO, "schema/agent-v2/fixtures");
export const fixtures = () => readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f, json: JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) }));

export const sse = (...events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

/** Fake core: scripted JSON routes and stream bodies; honours the abort signal. */
export function fakeCore({ json = {}, streams = [], attaches = null } = {}) {
  const calls = [];
  const queue = [...streams];
  const attachQueue = attaches ? [...attaches] : null;
  return {
    calls,
    // Re-attach stream (GET): scripts are arrays of { id, data } frames, an Error, or (signal, path) => async generator.
    ...(attachQueue ? {
      attach(path, signal) {
        calls.push({ method: "ATTACH", path });
        const script = attachQueue.shift();
        return (async function* () {
          if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          if (typeof script === "function") { yield* script(signal, path); return; }
          if (script instanceof Error) throw script;
          for (const fr of script ?? []) {
            if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            yield fr;
            await Promise.resolve();
          }
        })();
      },
    } : {}),
    async json(method, path, body, signal) {
      calls.push({ method, path, body });
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const h = json[`${method} ${path.split("?")[0]}`] ?? json[`${method} ${path}`];
      if (typeof h === "function") return h(body, path);
      if (h === undefined) throw Object.assign(new Error(`no fake for ${method} ${path}`), { status: 404 });
      return h;
    },
    stream(path, body, signal) {
      calls.push({ method: "STREAM", path, body });
      const script = queue.shift();
      return (async function* () {
        if (typeof script === "function") { yield* script(signal); return; }
        if (script instanceof Error) throw script;
        for (const chunk of script ?? []) {
          if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          // scripted items are framed text; the real transport yields one payload per event
          for (const frame of String(chunk).split("\n\n").filter(Boolean)) yield frame.replace(/^data: ?/, "");
          await Promise.resolve();
        }
      })();
    },
  };
}

/** A stream that never ends until aborted (a long turn). */
export const hangingStream = (...first) => async function* (signal) {
  for (const c of first) for (const frame of String(c).split("\n\n").filter(Boolean)) yield frame.replace(/^data: ?/, "");
  await new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
};

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export async function until(cond, ms = 2000) {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout waiting for condition"); await tick(2); }
}
