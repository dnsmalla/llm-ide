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
# Idempotent: safe to re-run; skips if a "LLM-IDE Local Dev" certificate
# already exists (looked up BY NAME, so an earlier partial run that imported
# but never finished trusting is detected instead of minting a duplicate).
# Interactive Terminal use only — a restricted/sandboxed shell (CI runner,
# sandboxed subprocess) can lose access to securityd/trustd IPC; run from a
# normal Terminal session.
#
# `./make-dev-cert.sh --self-test` runs the pure-logic test suite (no
# keychain writes).
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
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# ============================================
# Pure/testable helpers
# ============================================

# Only OpenSSL 3 both NEEDS and HAS the -legacy flag for `pkcs12 -export`
# (its new default encryption is unreadable by macOS's Security framework;
# LibreSSL — stock macOS — and OpenSSL 1.1 already emit the old RC2/3DES
# scheme and reject the flag outright).
openssl_legacy_flag() {
  case "$1" in
    "OpenSSL 3"*) echo "-legacy" ;;
    *) echo "" ;;
  esac
}

# Run openssl with stderr captured; on failure print it instead of dying
# silently (the old >/dev/null 2>&1 made a stock-LibreSSL machine exit
# non-zero with zero diagnostics).
openssl_quiet() {
  local err=""
  if ! err="$(openssl "$@" 2>&1 >/dev/null)"; then
    echo -e "${RED}[make-dev-cert]${NC} openssl $* failed:" >&2
    echo "$err" >&2
    return 1
  fi
}

# ACL grant for the imported key: codesign only. NEVER add -A ("any
# application may access this item") — it supersedes the -T scoping and
# hands every local process silent access to the private key.
identity_import_flags() {
  echo "-T /usr/bin/codesign"
}

# Name-based certificate lookup. Unlike `find-identity` (which lists VALID
# identities only), this also finds UNTRUSTED certs — so a partial earlier
# run (import done, trust step not) is detected and we skip minting a
# duplicate identity that would make `codesign -s` ambiguous.
identity_cert_present() {
  security find-certificate -c "$1" "$KEYCHAIN" >/dev/null 2>&1
}

# Classify a `security dump-trust-settings` result: exit 0 = reachable;
# exit 1 + "No Trust Settings were found" = reachable, just empty (a stock
# machine — NOT a failure); any other nonzero = a restricted shell that
# can't see the trust service, where an existing identity could look
# missing and we might mint a duplicate.
trust_probe_ok() { # $1 = exit status, $2 = combined output
  if [ "$1" -eq 0 ]; then
    return 0
  fi
  case "$2" in
    *"No Trust Settings were found"*) return 0 ;;
    *) return 1 ;;
  esac
}

# ============================================
# Self-test (--self-test): exercises the pure decision helpers below.
# Read-only with respect to the keychain.
# ============================================
self_test() {
  local failures=0
  pass() { echo "  ok: $1"; }
  fail() { echo "  FAIL: $1"; failures=$((failures + 1)); }

  t_eq() { # label got want
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi
  }
  t_contains() { # label haystack needle
    case "$2" in
      *"$3"*) pass "$1" ;;
      *) fail "$1 (missing '$3' in '$2')" ;;
    esac
  }
  t_not_contains() { # label haystack needle
    case "$2" in
      *"$3"*) fail "$1 (unexpected '$3' in '$2')" ;;
      *) pass "$1" ;;
    esac
  }
  t_status() { # label expected-status fn args...
    local label="$1" want="$2"
    shift 2
    local got=0
    "$@" >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then pass "$label"; else fail "$label (exit $got, want $want)"; fi
  }
  t_nonzero() { # label fn args...
    local label="$1"
    shift
    local got=0
    "$@" >/dev/null 2>&1 || got=$?
    if [ "$got" -ne 0 ]; then pass "$label"; else fail "$label (exit 0, want nonzero)"; fi
  }

  echo "[make-dev-cert self-test]"

  # openssl_legacy_flag: only OpenSSL 3 both NEEDS and HAS the -legacy flag
  t_eq "openssl 3 requests -legacy" "$(openssl_legacy_flag "OpenSSL 3.6.3 9 Jun 2026")" "-legacy"
  t_eq "libressl needs no -legacy" "$(openssl_legacy_flag "LibreSSL 3.3.6")" ""
  t_eq "openssl 1.1 needs no -legacy" "$(openssl_legacy_flag "OpenSSL 1.1.1w  3 Sep 2023")" ""

  # identity_import_flags: codesign-only ACL grant, never -A
  t_eq "import flags grant codesign only" "$(identity_import_flags)" "-T /usr/bin/codesign"
  t_not_contains "import flags never grant all apps" "$(identity_import_flags)" "-A"

  # identity_cert_present: name-based lookup returns nonzero for a cert
  # that does not exist (`security` exits 44, its item-not-found code —
  # contract is nonzero, not a specific value). The present-case needs a
  # real cert in the keychain, which a read-only self-test must not create.
  t_nonzero "absent cert reports not-present" identity_cert_present "LLM-IDE self-test absent $$"

  # trust_probe_ok: exit 1 + "No Trust Settings were found" is HEALTHY
  # (empty settings), any other nonzero is a restricted-shell failure
  t_status "probe ok when settings exist" 0 trust_probe_ok 0 "Number of trusted certs = 2"
  t_status "probe ok when settings empty" 0 trust_probe_ok 1 "SecTrustSettingsCopyCertificates: No Trust Settings were found."
  t_status "probe fails on permission error" 1 trust_probe_ok 1 "SecTrustSettingsCopyCertificates: operation not permitted"

  # openssl_quiet: a failing openssl surfaces its stderr instead of dying silently
  local oq_out=""
  if oq_out="$(openssl_quiet x509 -in "/nonexistent-self-test-$$.crt" -noout 2>&1)"; then
    fail "openssl_quiet should fail on missing input"
  else
    if [ -n "$oq_out" ]; then pass "openssl_quiet surfaces stderr"; else fail "openssl_quiet swallowed stderr"; fi
  fi

  # Live (read-only) probe: the real dump must classify as reachable
  local probe_out="" probe_status=0
  probe_out="$(security dump-trust-settings 2>&1)" || probe_status=$?
  t_status "live dump-trust-settings probe is reachable" 0 trust_probe_ok "$probe_status" "$probe_out"

  if [ "$failures" -eq 0 ]; then
    echo "[make-dev-cert self-test] all green"
  else
    echo "[make-dev-cert self-test] $failures failure(s)"
    return 1
  fi
}

# ============================================
# Main flow
# ============================================
main() {
  # Sanity probe BEFORE trusting an empty result from the identity check:
  # a restricted/sandboxed shell can lose securityd/trustd IPC. An EMPTY
  # trust domain (exit 1 + "No Trust Settings were found") is healthy and
  # must NOT be treated as restricted — that false positive would make the
  # script refuse to run on a stock machine.
  local probe_status=0 probe_out=""
  probe_out="$(security dump-trust-settings 2>&1)" || probe_status=$?
  if ! trust_probe_ok "$probe_status" "$probe_out"; then
    echo -e "${RED}[make-dev-cert]${NC} cannot reach the trust/keychain service in this shell — refusing to proceed" \
      "(a restricted/sandboxed shell can make an existing identity look missing, risking a duplicate)."
    echo -e "${RED}[make-dev-cert]${NC} run this from a normal, unsandboxed Terminal session."
    exit 1
  fi

  if identity_cert_present "$IDENTITY_NAME"; then
    if security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY_NAME\""; then
      echo -e "${YELLOW}[make-dev-cert]${NC} \"$IDENTITY_NAME\" already exists in the login keychain — nothing to do."
      echo "$IDENTITY_NAME" > "$IDENTITY_FILE"
      echo -e "${GREEN}[make-dev-cert]${NC} $IDENTITY_FILE written; Scripts/sign.sh will use it automatically."
      exit 0
    fi
    # Cert (and likely its key) are imported, but the identity isn't valid —
    # an earlier run died between import and trust. NEVER mint a second
    # identity of the same name: `codesign -s` would become ambiguous.
    echo -e "${YELLOW}[make-dev-cert]${NC} \"$IDENTITY_NAME\" is in the login keychain but not reporting as a valid" \
      "codesigning identity — a previous run probably ended between import and trust."
    echo -e "${YELLOW}[make-dev-cert]${NC} finish the trust step instead of re-running:"
    echo "  security find-certificate -a -p -c \"$IDENTITY_NAME\" > /tmp/llm-ide-dev.crt"
    echo "  security add-trusted-cert -r trustRoot -p codeSign -k '$KEYCHAIN' /tmp/llm-ide-dev.crt"
    exit 1
  fi

  local WORKDIR PASS
  WORKDIR="$(mktemp -d)"
  trap 'rm -rf "$WORKDIR"' EXIT

  echo -e "${BLUE}[make-dev-cert]${NC} generating a self-signed code-signing certificate..."
  openssl_quiet req -x509 -newkey rsa:2048 -keyout "$WORKDIR/dev.key" -out "$WORKDIR/dev.crt" -days 3650 -nodes \
    -subj "/CN=$IDENTITY_NAME" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature"

  PASS="$(openssl rand -base64 24)"
  # -legacy (OpenSSL 3 only): modern PKCS#12 encryption isn't readable by
  # macOS's `security import` (Security framework), which expects the older
  # RC2/3DES-based scheme. LibreSSL and OpenSSL 1.1 already emit that scheme
  # and don't have the flag at all.
  openssl_quiet pkcs12 -export -in "$WORKDIR/dev.crt" -inkey "$WORKDIR/dev.key" \
    -out "$WORKDIR/dev.p12" -passout "pass:$PASS" -name "$IDENTITY_NAME" $(openssl_legacy_flag "$(openssl version)")

  echo -e "${BLUE}[make-dev-cert]${NC} importing into the login keychain (trusted for codesign only)..."
  # NOT -A: -A lets ANY application use this key without a prompt, which
  # would defeat the codesign-only -T grant.
  security import "$WORKDIR/dev.p12" -k "$KEYCHAIN" -P "$PASS" $(identity_import_flags)

  echo -e "${BLUE}[make-dev-cert]${NC} trusting it for code signing (per-user trust; self-signed, so it's its own root)..."
  # User-domain trust (no -d): sufficient for local codesign validation and
  # avoids the admin authorization prompt.
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORKDIR/dev.crt"

  if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY_NAME\""; then
    echo -e "${YELLOW}[make-dev-cert]${NC} import succeeded but the identity isn't reporting as valid — the cert IS in the" \
      "keychain; see the recovery note above ('finish the trust step') rather than re-running from scratch."
    exit 1
  fi

  echo "$IDENTITY_NAME" > "$IDENTITY_FILE"
  echo -e "${GREEN}[make-dev-cert]${NC} done — Scripts/sign.sh will now sign with \"$IDENTITY_NAME\" automatically."
  echo -e "${GREEN}[make-dev-cert]${NC} rebuild once (Scripts/build_app.sh) and approve the ONE keychain prompt with \"Always Allow\" — it will stick across future rebuilds."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    --self-test) self_test ;;
    *) main "$@" ;;
  esac
fi
