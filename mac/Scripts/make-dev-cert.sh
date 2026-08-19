#!/bin/bash
# ============================================
# One-time local setup: create a self-signed code-signing certificate for
# LOCAL DEV BUILDS ONLY, so rebuilds stop re-prompting for keychain access.
#
# Why this is needed: ad-hoc signing (codesign -s -, the default) derives its
# identity from the binary's own content hash, which changes on every build.
# macOS's keychain ACL grants ("Always Allow") are matched against the app's
# code-signature identity, so every ad-hoc rebuild looks like a brand-new app
# and re-triggers the "App wants to access your keychain" prompt. A real,
# STABLE signing identity — reused across rebuilds — fixes this because the
# designated requirement stays the same even though the binary's bytes
# (and therefore its cdhash) still differ every build.
#
# This is NOT a substitute for a real Apple Developer ID: it satisfies
# codesign for local runs (LLMIDE_SIGN_IDENTITY / Scripts/sign.sh) but is
# NOT trusted by Gatekeeper or Apple notarization — Scripts/release.sh
# requires a real Developer ID + notary profile and is untouched by this.
#
# Idempotent: safe to re-run; skips if a "LLM-IDE Local Dev" identity
# already exists. Interactive Terminal use only — a restricted/sandboxed
# shell (CI runner, sandboxed subprocess) can lose access to securityd/
# trustd IPC and make `security find-identity` report zero results even
# when a real identity IS present; run from a normal Terminal session.
# ============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IDENTITY_NAME="LLM-IDE Local Dev"
IDENTITY_FILE="$SCRIPT_DIR/.sign-identity"

# Sanity probe BEFORE trusting an empty find-identity result: `security
# list-keychains` alone isn't a reliable signal (it can succeed even when
# trustd/securityd access is actually restricted) — dump-trust-settings is
# what actually fails the same way find-identity's own validity check does
# ("No keychain is available...") in a restricted shell, WITH an
# unambiguous error instead of a silent empty list. Without this probe, the
# idempotency check below would false-negative in that case and go on to
# mint a SECOND identity of the same name (ambiguous for `codesign -s` to
# resolve later).
if ! security dump-trust-settings -d >/dev/null 2>&1; then
  echo -e "${RED}[make-dev-cert]${NC} cannot reach the trust/keychain service in this shell — refusing to proceed" \
    "(a restricted/sandboxed shell can make an existing identity look missing, risking a duplicate)."
  echo -e "${RED}[make-dev-cert]${NC} run this from a normal, unsandboxed Terminal session."
  exit 1
fi

existing="$(security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$IDENTITY_NAME\"" || true)"
if [ -n "$existing" ]; then
  echo -e "${YELLOW}[make-dev-cert]${NC} \"$IDENTITY_NAME\" already exists in the login keychain — nothing to do."
  echo "$IDENTITY_NAME" > "$IDENTITY_FILE"
  echo -e "${GREEN}[make-dev-cert]${NC} $IDENTITY_FILE written; Scripts/sign.sh will use it automatically."
  exit 0
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo -e "${BLUE}[make-dev-cert]${NC} generating a self-signed code-signing certificate..."
openssl req -x509 -newkey rsa:2048 -keyout "$WORKDIR/dev.key" -out "$WORKDIR/dev.crt" -days 3650 -nodes \
  -subj "/CN=$IDENTITY_NAME" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" >/dev/null 2>&1

PASS="$(openssl rand -base64 24)"
# -legacy: modern OpenSSL's default PKCS#12 encryption isn't readable by
# macOS's `security import` (Security framework), which expects the older
# RC2/3DES-based scheme.
openssl pkcs12 -export -in "$WORKDIR/dev.crt" -inkey "$WORKDIR/dev.key" \
  -out "$WORKDIR/dev.p12" -passout "pass:$PASS" -name "$IDENTITY_NAME" -legacy >/dev/null 2>&1

echo -e "${BLUE}[make-dev-cert]${NC} importing into the login keychain (trusted for codesign only)..."
security import "$WORKDIR/dev.p12" -k ~/Library/Keychains/login.keychain-db -P "$PASS" -T /usr/bin/codesign -A

echo -e "${BLUE}[make-dev-cert]${NC} trusting it for code signing (self-signed, so it's its own root)..."
security add-trusted-cert -d -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db "$WORKDIR/dev.crt"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY_NAME\""; then
  echo -e "${YELLOW}[make-dev-cert]${NC} import succeeded but the identity isn't reporting as valid — check 'security find-identity -v -p codesigning'."
  exit 1
fi

echo "$IDENTITY_NAME" > "$IDENTITY_FILE"
echo -e "${GREEN}[make-dev-cert]${NC} done — Scripts/sign.sh will now sign with \"$IDENTITY_NAME\" automatically."
echo -e "${GREEN}[make-dev-cert]${NC} rebuild once (Scripts/build_app.sh) and approve the ONE keychain prompt with \"Always Allow\" — it will stick across future rebuilds."
