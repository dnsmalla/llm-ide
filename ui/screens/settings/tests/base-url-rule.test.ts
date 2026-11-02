// The client base-URL rule must give the core's verdict on every spelling: it runs the real core guard
// (extension/server/base-url-guard.mjs) on the same table, so a drift on either side fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectBaseUrlIssue, providerBaseUrlRefusal, PLAIN_HTTP_REMOTE, PLAIN_HTTP_NEEDS_OPT_IN } from "../base-url-rule.ts";

const URLS = [
  "https://api.example.com/v1", "http://api.example.com/v1", "HTTP://API.EXAMPLE.COM", "ftp://example.com",
  "http://localhost:11434/v1", "HTTP://LOCALHOST", "http://localhost.", "http://foo.localhost", "http://ollama.local:11434", "http://ollama.local.",
  "http://127.0.0.1:8080", "http://0x7f.1", "http://2130706433", "http://0177.0.0.1", "http://127.1",
  "http://10.0.0.5", "http://172.16.0.1", "http://172.31.255.255", "http://172.32.0.1", "http://192.168.1.20:3001", "http://100.64.0.9", "http://100.128.0.1",
  "http://8.8.8.8", "https://8.8.8.8", "http://0.0.0.0", "http://169.254.169.254", "https://169.254.169.254", "http://224.0.0.1", "http://255.255.255.255",
  "http://192.0.2.1", "http://198.18.0.1", "http://203.0.113.5",
  "http://[::1]:8080", "http://[::]", "http://[::ffff:192.168.1.5]", "http://[::ffff:127.0.0.1]", "http://[::ffff:8.8.8.8]", "http://[::ffff:169.254.169.254]",
  "http://[::7f00:1]", "http://[64:ff9b::c0a8:105]", "http://[64:ff9b:1::1]", "http://[2002:c0a8:105::]", "http://[2002:808:808::]",
  "http://[2001::1]", "http://[ff02::1]", "http://[fe80::1]", "http://[fec0::1]", "http://[2001:db8::1]",
  "http://[fd12:3456::1]", "http://[fc00::1]", "http://[fd00:ec2::254]", "https://[fd00:ec2::254]", "http://[2606:4700::1111]", "https://[2606:4700::1111]",
  "http://user@evil.example", "http://x:y@127.0.0.1", "http://127.0.0.1/?q=1", "http://127.0.0.1/#frag", "not a url", "http://bücher.example", "http://bücher.local",
  "https://192.168.1.5", "https://localhost", "https://foo.local",
];

// A variable specifier keeps tsc from resolving the untyped core module; node loads the real file.
const GUARD = new URL("../../../../extension/server/base-url-guard.mjs", import.meta.url).href;
const { assertProviderBaseUrl } = (await import(GUARD)) as { assertProviderBaseUrl: (url: string, o: { allowPrivate: boolean }) => string };

function core(url: string, allowPrivate: boolean): string | null {
  try { assertProviderBaseUrl(url, { allowPrivate }); return null; } catch (e) { return (e as Error).message; }
}

test("the client rule gives the core guard's verdict and message for every spelling, in both postures", () => {
  for (const url of URLS) {
    for (const allow of [false, true]) {
      assert.equal(providerBaseUrlRefusal(url, allow), core(url, allow), `${url} allowPrivate=${allow}`);
    }
  }
});

test("the connect posture: a local entry (Ollama) is private by construction; a generic entry needs the opt-in", () => {
  const ollama = { name: "Ollama", baseURL: "http://localhost:11434/v1", local: true, allowPrivate: true };
  const generic = { name: "OpenAI-compatible", baseURL: "", local: false, allowPrivate: true };
  const hosted = { name: "OpenAI", baseURL: "https://api.openai.com/v1", local: false, allowPrivate: false };
  // Renaming an Ollama connection re-sends its http://localhost address without the opt-in: the core accepts that.
  assert.equal(connectBaseUrlIssue(ollama, "http://localhost:11434/v1", false), null);
  assert.equal(connectBaseUrlIssue(ollama, "http://127.0.0.1:11434/v1", false), null);
  assert.match(connectBaseUrlIssue(ollama, "http://192.168.1.9:11434/v1", false)!, /needs the private-network opt-in/);
  assert.equal(connectBaseUrlIssue(ollama, "http://192.168.1.9:11434/v1", true), null);
  assert.equal(connectBaseUrlIssue(generic, "http://192.168.1.9/v1", false), PLAIN_HTTP_NEEDS_OPT_IN);
  assert.equal(connectBaseUrlIssue(generic, "http://[::ffff:192.168.1.5]/v1", true), null);
  assert.equal(connectBaseUrlIssue(generic, "http://api.example.com/v1", true), PLAIN_HTTP_REMOTE);
  assert.match(connectBaseUrlIssue(generic, "http://[fd00:ec2::254]/v1", true)!, /cloud-metadata/);
  assert.match(connectBaseUrlIssue(generic, "https://192.168.1.9/v1", false)!, /not allowed for this provider/);
  assert.equal(connectBaseUrlIssue(hosted, "https://api.openai.com/v1", false), null);
});
