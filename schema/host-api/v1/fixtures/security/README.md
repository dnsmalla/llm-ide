Shared Host API v1 security fixtures: `origins.json` pins the web-origin allowlist parsing and matching rule; `identity-vector.json` pins the TLS identity fingerprint format (sha256: + base64url SHA-256 of the SPKI DER).
Both hosts' tests (Node core and Mac app) read these files, so the two implementations cannot disagree.
The key in `identity-vector.json` is a public TEST VECTOR, never a real host identity.
