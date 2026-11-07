Shared Host API v1 security fixtures: `origins.json` pins the web-origin allowlist parsing and matching rule; `identity-vector.json` pins the TLS identity fingerprint format (sha256: + base64url SHA-256 of the SPKI DER).
Both hosts' tests (Node core and Mac app) read these files, so the two implementations cannot disagree.
The key in `identity-vector.json` is a public TEST VECTOR, never a real host identity.

`compose.json` pins the `compose` capability's bounds: the only modes a client may ask for (never `execute` or a permission mode), which model ids pass the wire pattern, and the attachment limits (the core's 80,000 / 200,000 characters, the schema's 10 files and 300-character names, text only). The Node gateway tests (`extension/tests/host-api-compose.test.mjs`) and the web client tests (`web/tests/attachments.test.mjs`) read it.

`push.json` pins the `push` capability's bounds: the only kinds a push may name (the desktop notifier's webview kinds, never `update_ready` or `core_down`), the browser push-service endpoints a web subscription may point at (https on 443 to FCM, Mozilla, Apple or one regional `*.notify.windows.com` label, no userinfo), and the two payload fields. The Node tests (`extension/tests/push-webpush.test.mjs`, `extension/tests/host-api-push-gateway.test.mjs`) and the web client tests (`web/tests/push-controller.test.mjs`) read it.
