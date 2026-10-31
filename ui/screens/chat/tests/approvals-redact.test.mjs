import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadChat, REPO } from "./helpers.mjs";

let A, server;
before(async () => {
  A = (await loadChat("approvals-redact")).approvals;
  server = await import(pathToFileURL(join(REPO, "extension/core/redact-secrets.mjs")).href);
});

const FIXTURES = [
  "ghp_" + "a".repeat(36), "github_pat_" + "b".repeat(82), "glpat-" + "c".repeat(24), "xoxb-1234567890-abcdef", "AIza" + "d".repeat(35), "AKIA" + "E".repeat(16),
  "sk-ant-" + "f".repeat(20), "sk-proj-" + "g".repeat(24), "sk-" + "h".repeat(40), "Bearer " + "i".repeat(30), "https://x/?apiKey=abcDEF123", "ya29." + "j".repeat(30), "1//" + "k".repeat(30),
];

test("every shared pattern redacts exactly what the core's redactor redacts (drift guard)", () => {
  for (const f of FIXTURES) {
    const text = `before ${f} after`;
    assert.equal(A.redactSecrets(text), server.redactSecrets(text), f.slice(0, 12));
    assert.ok(!A.redactSecrets(text).includes(f.slice(6)), `${f.slice(0, 12)} leaked`);
  }
  assert.equal(A.redactSecrets("nothing here"), "nothing here");
  assert.equal(A.redactSecrets("ghp_short"), server.redactSecrets("ghp_short"));
});

test("UI additions: private keys and secret-named assignments in commands", () => {
  assert.equal(A.redactSecrets("API_TOKEN=abc123 npm run x"), "API_TOKEN=[REDACTED] npm run x");
  assert.equal(A.redactSecrets('DB_PASSWORD="my pass" run'), "DB_PASSWORD=[REDACTED] run");
  assert.ok(!A.redactSecrets("-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----").includes("MIIabc"));
  assert.equal(A.redactSecrets("PATH=/usr/bin make"), "PATH=/usr/bin make", "ordinary assignments stay readable");
});

test("redactValue: secret-named keys, nesting, depth and breadth bounds", () => {
  const v = A.redactValue({ authorization: "Bearer zzz", ok: "fine", list: ["sk-" + "a".repeat(40)], n: 3, deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } });
  assert.equal(v.authorization, "[REDACTED]");
  assert.equal(v.ok, "fine");
  assert.equal(v.list[0], "[REDACTED]");
  assert.equal(v.n, 3);
  assert.equal(v.deep.a.b.c.d.e, "[nested value omitted: object with 1 keys]");
  const wide = A.redactValue(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])));
  assert.equal(Object.keys(wide).length, 101, "100 kept + one visible [hidden] marker");
  assert.equal(wide["[hidden]"], "400 keys hidden");
  assert.equal(A.looksSecret("ghp_" + "a".repeat(36)), true);
  assert.equal(A.looksSecret("hello"), false);
});
