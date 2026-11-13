// The one-command installer's argument/secret contract, exercised by its dry run on POSIX shells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HUB = join(REPO, "deploy/hub");
const SCRIPT = join(HUB, "install-hub.sh");
const skip = process.platform === "win32" ? "POSIX shell only" : false;
const read = (name) => readFileSync(join(HUB, name), "utf8").replaceAll("\r\n", "\n");

function run(args, env = {}) {
  return spawnSync("sh", [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", env: { ...process.env, ...env } });
}

test("the installer is POSIX-shell clean", { skip }, () => {
  const r = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("--help explains the URL-first next steps without requiring root", { skip }, () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--domain/);
  assert.match(r.stdout, /hidden prompt/);
});

test("--dry-run prints the plan, never the model key, and rejects a key in argv", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "llmide-install-"));
  try {
    const bundle = join(dir, "llmide-core-1.2.3-linux-x64.tar.gz");
    writeFileSync(bundle, "not a real bundle");
    const secret = "sk-ant-test-secret-value";
    const r = run(["--domain", "Hub.Example.com", "--bundle", bundle, "--dry-run"], { ANTHROPIC_API_KEY: secret });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /https:\/\/hub\.example\.com/);
    assert.match(r.stdout, /1\.2\.3/);
    assert.match(r.stdout, /open-registration/);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret), "the key is never printed");
    const bad = run(["--domain", "hub.example.com", "--api-key", secret, "--dry-run"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /never on the command line/);
    assert.doesNotMatch(bad.stdout + bad.stderr, new RegExp(secret));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the domain must be a public DNS name, and a bundle is required", { skip }, () => {
  for (const domain of ["localhost", "hub.local", "8.8.8.8", "hub", "bad_host.example.com"]) {
    const r = run(["--domain", domain, "--dry-run"]);
    assert.notEqual(r.status, 0, domain);
  }
  const missing = run(["--domain", "hub.example.com", "--bundle", "/nonexistent.tgz", "--dry-run"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not exist|no hub bundle/);
});

test("the helper accepts the model key and preserves it across a redeploy", { skip }, () => {
  const helper = read("llmide-deploy");
  assert.match(helper, /ANTHROPIC_API_KEY/);
  assert.match(helper, /grep '\^ANTHROPIC_API_KEY=' "\$CONF"/);
});

test("the hub env serves Host API read but never compose or tool approvals", () => {
  const installer = read("install-hub.sh");
  assert.match(installer, /LLMIDE_HOST_API_READ=1/);
  assert.doesNotMatch(installer, /LLMIDE_HOST_API_(COMPOSE|TOOL_APPROVALS)/);
  const deploy = read("llmide-deploy");
  assert.match(deploy, /\|LLMIDE_HOST_API_READ\|/, "the env allowlist accepts READ");
  assert.doesNotMatch(deploy, /LLMIDE_HOST_API_(COMPOSE|TOOL_APPROVALS)/);
});

test("the nginx vhost is embedded in the root helper and cannot be uploaded", () => {
  const helper = read("llmide-deploy");
  const template = read("llm-ide-hub.nginx.template");
  assert.ok(helper.includes(template), "the helper embeds llm-ide-hub.nginx.template verbatim");
  assert.doesNotMatch(helper, /\|llm-ide-hub\.nginx\|/, "the upload allowlist has no vhost");
  assert.doesNotMatch(helper, /"\$STAGING\/llm-ide-hub\.nginx"\s*>/, "no staged vhost is installed");
  assert.match(helper, /echo "helper=6"/);
  assert.doesNotMatch(read("install-hub.sh"), /upload llm-ide-hub\.nginx/);
});

test("the helper is POSIX-shell clean", { skip }, () => {
  const r = spawnSync("sh", ["-n", join(HUB, "llmide-deploy")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
