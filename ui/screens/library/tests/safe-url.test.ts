import { test } from "node:test";
import assert from "node:assert/strict";
import { publicHttpsUrl } from "../safe-url.ts";

test("browser-mode opener: public https only", () => {
  assert.equal(publicHttpsUrl("https://docs.example.com/a?b=1#c"), "https://docs.example.com/a?b=1#c");
  assert.equal(publicHttpsUrl("https://8.8.8.8/x"), "https://8.8.8.8/x");
  for (const bad of ["http://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://localhost/x", "https://127.0.0.1/", "https://10.0.0.5/", "https://192.168.1.1/", "https://172.20.0.1/", "https://169.254.169.254/", "https://[::1]/", "https://intranet/", "https://x.local/", "https://u:p@example.com/", "https://0x7f.1/", "https://2130706433/", "https://exa mple.com", "", "https://a.example.com/\u0000"]) {
    assert.equal(publicHttpsUrl(bad), null, bad);
  }
});
