// Starts the REAL extension server (extension/server.mjs) on a free loopback port with a temp database and the
// bench FAKE engine (extension/llm_agent/sdk/bench-fake-engine.mjs): the whole route/auth/SSE/metering pipeline
// runs, but no model is called and nothing leaves 127.0.0.1. The environment is built the way scripts/token-bench.mjs
// builds it (every inherited LLMIDE_* variable, NODE_ENV and NODE_TEST_CONTEXT stripped first), so a developer's
// own data directory, secrets or ports can never be touched. Needs local port binding (sandbox: allowLocalBinding).
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
// LLMIDE_E2E_BUNDLE=<.../LLM-IDE.app/Contents/Resources/core> runs the same suite against the BUNDLED core (its pinned
// node and pruned extension tree) instead of the source checkout; the build script's headless check for a built app.
const BUNDLE = process.env.LLMIDE_E2E_BUNDLE ? resolve(process.env.LLMIDE_E2E_BUNDLE) : null;
const EXT = BUNDLE ? join(BUNDLE, "root", "extension") : join(REPO, "extension");
const NODE = BUNDLE ? join(BUNDLE, "node", "node") : process.execPath;

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** `register: false` leaves the data directory empty (no user), for the first-run flow: the test registers through the shell client. */
export async function startCore({ bootTimeoutMs = 40_000, register = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "llmide-e2e-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const port = await freePort();
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("LLMIDE_") || k === "NODE_ENV" || k === "NODE_TEST_CONTEXT") continue;
    env[k] = v;
  }
  Object.assign(env, {
    LLMIDE_PORT: String(port),
    LLMIDE_HOST: "127.0.0.1",
    LLMIDE_DB_PATH: join(dir, "e2e.db"),
    LLMIDE_AGENT_DB_PATH: join(dir, "e2e-agent.db"),
    LLMIDE_JWT_SECRET: randomBytes(36).toString("hex"),
    LLMIDE_VAULT_KEY: randomBytes(36).toString("hex"),
    LLMIDE_BACKUP_INTERVAL_HOURS: "0",
    LLMIDE_ENGINE_PREWARM: "0",
    LLMIDE_BENCH_FAKE: "1",
  });
  const child = spawn(NODE, ["server.mjs", "--bench-fake"], { cwd: EXT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + bootTimeoutMs;
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  for (;;) {
    if (child.exitCode != null) { cleanup(); throw new Error(`core exited early: ${output.slice(-1500)}`); }
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill("SIGTERM"); cleanup(); throw new Error(`core did not answer /health: ${output.slice(-1500)}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const email = `e2e+${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString("base64url");
  if (register) {
    const reg = await fetch(`${base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, displayName: "e2e" }) });
    if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  }
  return {
    base, workspace, email, password,
    tail: (n = 3000) => output.slice(-n),
    stop: () => new Promise((resolveStop) => {
      const done = () => { cleanup(); resolveStop(); };
      if (child.exitCode != null) return done();
      const k = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(k); done(); });
      child.kill("SIGTERM");
    }),
  };
}
