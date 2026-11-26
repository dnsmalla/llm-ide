#!/usr/bin/env bash
# Builds LLM-IDE.app (the Tauri desktop app) for THIS Mac, verifies it, and prints how to open it.
#
#   scripts/build-desktop-mac.sh [--dmg] [--skip-checks] [--no-smoke] [--verbose] [--rebuild]
#
#   --dmg          also make LLM-IDE-<version>-<arch>.dmg next to the .app (hdiutil, no Finder scripting)
#   --skip-checks  skip `npm run check:security` before the build
#   --no-smoke     skip the core smoke test and the shell e2e suite against the core inside the built app
#   --rebuild      always run the frontend + Rust build, even when nothing it reads changed since the last good
#                  build (also LLMIDE_FORCE_REBUILD=1); by default that ~2 min step is skipped and the .app reused
#   --verbose      stream every tool's output (also LLMIDE_BUILD_VERBOSE=1); by default each step prints one line
#                  and the full output goes to desktop/src-tauri/target/build-desktop.log
#
# Idempotent: every run restages the core from scratch and re-signs/verifies/smoke-tests; only the tauri build
# is skipped when desktop/scripts/app-build-key.mjs reports the same input key as the last successful build.
# Nothing outside desktop/ is touched.
# Needs network on the first run (pinned official Node download, npm ci, cargo crates). Nothing here launches
# the app and nothing calls a model. Output: desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app
#
# Signing: prefers a local Apple Development identity when one exists, so the Keychain approval a rebuild needs
# (the host reads the core's JWT/vault secrets) survives later builds — an ad-hoc signature changes every time
# and macOS asks again. Falls back to ad-hoc when there is no identity, or with LLMIDE_ADHOC_SIGN=1.
# Set LLMIDE_CODESIGN_IDENTITY to pick a specific identity. Hardened runtime and entitlements are NOT used: they
# matter only for a Developer ID signature + notarization, which would need `com.apple.security.cs.allow-jit`
# and `com.apple.security.cs.disable-library-validation` for the bundled node and better-sqlite3
# (see docs/how-to/desktop-signing-decisions.md).
set -euo pipefail

# The Rust toolchain ships rust-objcopy with its libLLVM; macOS needs that directory on DYLD_LIBRARY_PATH so the
# release debug-strip step runs instead of warning and leaving symbols in the bundle. SIP clears DYLD_* whenever a
# protected binary such as /usr/bin/env runs, so the Tauri CLI is started with node directly, never through npx.
RUST_SYSROOT="$(rustc --print sysroot)"
RUST_LIB="${RUST_SYSROOT}/lib"

DMG=0; CHECKS=1; SMOKE=1; VERBOSE="${LLMIDE_BUILD_VERBOSE:-0}"; FORCE="${LLMIDE_FORCE_REBUILD:-0}"
for a in "$@"; do
  case "$a" in
    --dmg) DMG=1 ;;
    --skip-checks) CHECKS=0 ;;
    --no-smoke) SMOKE=0 ;;
    --verbose) VERBOSE=1 ;;
    --rebuild) FORCE=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/desktop"
[ "$(uname -s)" = "Darwin" ] || { echo "this script builds the macOS app and must run on macOS" >&2; exit 2; }
case "$(uname -m)" in
  arm64) TARGET=darwin-arm64; RUST_TRIPLE=aarch64-apple-darwin ;;
  x86_64) TARGET=darwin-x64; RUST_TRIPLE=x86_64-apple-darwin ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 2 ;;
esac

# One build at a time per checkout: every build restages desktop/resources/core from scratch (even an in-app
# rebuild with its own CARGO_TARGET_DIR), so a second build would delete the core the first one is bundling.
# mkdir is atomic; a lock whose pid is gone was left by a killed build and is taken over.
LOCK="$DESKTOP/resources/.build-desktop.lock"
mkdir -p "$DESKTOP/resources"
if ! mkdir "$LOCK" 2>/dev/null; then
  OTHER="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OTHER" ] && kill -0 "$OTHER" 2>/dev/null; then
    echo "another desktop build is running (pid $OTHER, lock $LOCK); wait for it to finish" >&2
    exit 1
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"

# Ctrl-C / kill must stop the running step's whole process tree (npm, cargo, node...) and the ticker, otherwise
# they keep writing into desktop/resources after the lock is gone and a second build races them. Steps run in the
# background and are `wait`ed on, because bash runs a trap only after a foreground child ends, and a non-interactive
# bash starts background jobs with SIGINT ignored, so the INT trap has to kill the step tree itself.
TICKER=""
STEP_PID=""
kill_tree() { # pid: children first, so a parent cannot respawn what we just killed
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}
cleanup() {
  [ -n "$TICKER" ] && kill "$TICKER" 2>/dev/null
  [ -n "$STEP_PID" ] && kill_tree "$STEP_PID"
  rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A rebuild from inside the app sets CARGO_TARGET_DIR so it never writes into the running bundle.
TARGET_DIR="${CARGO_TARGET_DIR:-$DESKTOP/src-tauri/target}"
LOG_FILE="$TARGET_DIR/build-desktop.log"
mkdir -p "$TARGET_DIR"
: >"$LOG_FILE"
export LLMIDE_BUILD_VERBOSE="$VERBOSE" # stage-core.mjs prints its size table only when verbose
BUILD_START=$SECONDS

# run <label> <command...>: one line per step ("label ... ok 12s"); the command's output goes to $LOG_FILE.
# On failure the log tail is shown and the build stops. The command runs in a subshell with its own `set -e`, and
# its status is read with $? after `set +e`: inside `if`, `||` or `&&` bash ignores errexit even in the subshell,
# which would let a multi-command step carry on past a failed command.
run() {
  local label="$1"; shift
  local t0=$SECONDS code=0 log_start=0
  if [ "$VERBOSE" = 1 ]; then
    printf '\n==> %s\n' "$label"
    set +e; ( set -e; "$@" ) & STEP_PID=$!
    wait "$STEP_PID"; code=$?; STEP_PID=""; set -e
  else
    printf '==> %s\n' "$label" >>"$LOG_FILE"
    log_start=$(wc -c <"$LOG_FILE" | tr -d ' ')
    printf '  %-56s ' "$label"
    if [ -t 1 ]; then # live elapsed time, so a multi-minute step does not look hung
      ( while sleep 1; do printf '%4ss\b\b\b\b\b' $((SECONDS - t0)); done ) & TICKER=$!
    fi
    set +e; ( set -e; "$@" ) >>"$LOG_FILE" 2>&1 & STEP_PID=$!
    wait "$STEP_PID"; code=$?; STEP_PID=""; set -e
    [ -n "$TICKER" ] && { kill "$TICKER" 2>/dev/null; wait "$TICKER" 2>/dev/null || true; TICKER=""; }
    if [ "$code" = 0 ]; then printf 'ok %4ss\n' $((SECONDS - t0)); else printf 'FAILED\n'; fi
  fi
  if [ "$code" != 0 ]; then
    if [ "$VERBOSE" != 1 ]; then
      echo; tail -n 40 "$LOG_FILE" | sed 's/^/    /'; echo
      echo "full log: $LOG_FILE" >&2
    fi
    echo "build failed at: $label (exit $code)" >&2
    exit "$code"
  fi
  [ "$VERBOSE" = 1 ] || show_warnings "$log_start"
}
# A passing step can still say something worth reading (a skipped cache, a deprecated flag); quiet mode would
# otherwise hide it in the log. Only this step's slice of the log is scanned.
show_warnings() { # log_start_byte
  local lines total
  lines="$(tail -c +"$(($1 + 1))" "$LOG_FILE" | grep -iE '^[[:space:]]*warning' || true)"
  [ -n "$lines" ] || return 0
  # Here-strings, not `printf | head`: under pipefail, head closing early SIGPIPEs printf and kills a passing build.
  total=$(wc -l <<<"$lines" | tr -d ' ')
  head -n 5 <<<"$lines" | sed 's/^[[:space:]]*/      /'
  [ "$total" -le 5 ] || printf '      (%s more in the log)\n' $((total - 5))
}
info() { if [ "$VERBOSE" = 1 ]; then echo "$*"; else echo "$*" >>"$LOG_FILE"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1 ($2)" >&2; exit 2; }; }

# Prefer the rustup stable toolchain's own cargo: a `cargo` earlier on PATH can be a broken rustup proxy
# (it prints "this is the version for the rustup toolchain manager") or a Homebrew rust, which cannot build this.
for d in "$HOME/.rustup/toolchains/stable-$RUST_TRIPLE/bin"; do
  [ -x "$d/cargo" ] && PATH="$d:$PATH" && break
done
[ -x "$HOME/.cargo/bin/cargo" ] && PATH="$PATH:$HOME/.cargo/bin"
need node "install Node 22+"; need npm "comes with Node"; need cargo "install Rust with rustup (https://rustup.rs)"
need codesign "Xcode command line tools: xcode-select --install"; need plutil "macOS"
echo "LLM-IDE desktop build: $TARGET, node $(node -v), $(cargo --version | cut -d' ' -f1-2)"
[ "$VERBOSE" = 1 ] || echo "log: $LOG_FILE"

npm_ci_if_needed() { # dir
  local dir="$1"
  if [ ! -d "$dir/node_modules" ] || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
    run "Install dependencies (${dir#$ROOT/})" bash -c 'cd "$1" && npm ci --no-audit --no-fund' _ "$dir"
  fi
}
npm_ci_if_needed "$ROOT/ui/kit"
npm_ci_if_needed "$DESKTOP"
# desktop/vite.config.ts aliases three into graph-kit/web/node_modules
npm_ci_if_needed "$ROOT/graph-kit/web"

run "Stage the core (pinned Node + production dependencies)" \
  env LLMIDE_STAGE_RELEASE=1 node "$DESKTOP/scripts/stage-core.mjs" --target "$TARGET"

# Always, even with the other checks skipped: the product build must not carry the spike/bench commands.
run "Product security gate (no spike, least-privilege)" bash -c 'cd "$1" && npm run --silent check:security:product' _ "$DESKTOP"

if [ "$CHECKS" = 1 ]; then
  run "Security checks (capabilities, DOMPurify pin)" bash -c 'cd "$1" && npm run --silent check:security' _ "$DESKTOP"
fi

info "features: ${LLMIDE_BUILD_FEATURES:-all}"
tauri_build() {
  cd "$DESKTOP"
  DYLD_LIBRARY_PATH="${RUST_LIB}${DYLD_LIBRARY_PATH:+:${DYLD_LIBRARY_PATH}}" CARGO_TARGET_DIR="$TARGET_DIR" \
    node node_modules/@tauri-apps/cli/tauri.js build --bundles app
}
APP="$TARGET_DIR/release/bundle/macos/LLM-IDE.app"
BUILD_LABEL="Build the app (frontend + release Rust binary)"
# The stamp is written only after the whole build passed, so a build that failed later (sign, smoke) is redone.
BUILD_KEY="$(node "$DESKTOP/scripts/app-build-key.mjs")"
STAMP="$TARGET_DIR/.app-build-key"
# The stamp lives next to the bundle, not in it, so something that swaps the bundle (the in-app feature rebuild
# ditto-es a reduced app over this path) would leave a valid stamp for the wrong app. build-key.txt travels with
# the bundle (and is sealed by the signature), so reuse needs both to match.
KEY_IN_APP="$APP/Contents/Resources/build-key.txt"
REUSE=0
if [ "$FORCE" != 1 ] && [ -d "$APP" ] && [ -f "$STAMP" ] && [ -f "$KEY_IN_APP" ] \
  && [ "$(cat "$STAMP")" = "$BUILD_KEY" ] && [ "$(cat "$KEY_IN_APP")" = "$BUILD_KEY" ]; then REUSE=1; fi
if [ "$REUSE" = 1 ]; then
  printf '==> %s: unchanged since the last build, reused\n' "$BUILD_LABEL" >>"$LOG_FILE"
  if [ "$VERBOSE" = 1 ]; then
    printf '\n==> %s: unchanged since the last build, reused\n' "$BUILD_LABEL"
  else
    printf '  %-56s %s\n' "$BUILD_LABEL" "unchanged, reused"
  fi
  # The key deliberately does not cover the core (it is restaged every build), so a reused bundle gets the fresh one.
  refresh_core() {
    rm -rf "$APP/Contents/Resources/core"
    ditto "$DESKTOP/resources/core" "$APP/Contents/Resources/core"
  }
  run "Refresh the bundled core" refresh_core
else
  rm -f "$STAMP"
  run "$BUILD_LABEL" tauri_build
fi
[ -d "$APP" ] || { echo "build finished but $APP is missing" >&2; exit 1; }

# A local build records its source checkout so Settings > Build can rebuild itself; a distributed release omits it
# (LLMIDE_OMIT_SOURCE_ROOT=1), and the in-app rebuild then refuses. Written BEFORE signing so the seal covers it.
# Removed first so an omit-build on a reused bundle never ships a path left by an earlier local build.
mkdir -p "$APP/Contents/Resources"
rm -f "$APP/Contents/Resources/source-root.txt"
printf '%s\n' "$BUILD_KEY" >"$KEY_IN_APP"
if [ "${LLMIDE_OMIT_SOURCE_ROOT:-0}" != "1" ]; then
  printf '%s\n' "$ROOT" > "$APP/Contents/Resources/source-root.txt"
  chmod 600 "$APP/Contents/Resources/source-root.txt"
fi

# Re-sign the whole bundle in one pass so the seal covers the bundled core. No hardened runtime (see header).
IDENTITY="${LLMIDE_CODESIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ] && [ "${LLMIDE_ADHOC_SIGN:-0}" != "1" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development:/{print $2; exit}')"
fi
SIGN_AS="${IDENTITY:--}"
SIGN_NAME="${IDENTITY:-ad-hoc}"
sign_app() {
  info "identity: $SIGN_NAME"
  codesign --force --deep --sign "$SIGN_AS" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
}
run "Sign ($SIGN_NAME)" sign_app

verify_app() {
  node "$DESKTOP/scripts/verify-bundle.mjs" "$APP"
  # The spike commands are compiled out without `--features spike`; prove it on the finished binary.
  for bin in "$APP"/Contents/MacOS/*; do
    if grep -aq "LLMIDE_POC_AUTOBENCH" "$bin"; then
      echo "product binary $bin still contains the spike/autobench code (built with --features spike?)" >&2
      exit 1
    fi
  done
  echo "bundle id: $(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist")"
}
run "Verify the bundle" verify_app

if [ "$SMOKE" = 1 ]; then
  run "Smoke-test the bundled core" env LLMIDE_CORE_DIR="$APP/Contents/Resources/core" node "$DESKTOP/scripts/smoke-core.mjs"
  e2e() {
    cd "$DESKTOP"
    LLMIDE_E2E_BUNDLE="$APP/Contents/Resources/core" node --test --experimental-strip-types ../ui/screens/shell/tests/e2e/e2e.test.mjs
  }
  run "End-to-end suite against the bundled core" e2e
fi

if [ -n "${LLMIDE_BUILD_OUT:-}" ]; then
  copy_out() {
    mkdir -p "$LLMIDE_BUILD_OUT"
    rm -rf "$LLMIDE_BUILD_OUT/LLM-IDE.app"
    ditto "$APP" "$LLMIDE_BUILD_OUT/LLM-IDE.app"
  }
  run "Copy the app to $LLMIDE_BUILD_OUT" copy_out
fi

DMG_OUT=""
if [ "$DMG" = 1 ]; then
  VERSION="$(node -p "require('$DESKTOP/src-tauri/tauri.conf.json').version")"
  DMG_OUT="$(dirname "$APP")/LLM-IDE-$VERSION-$(uname -m).dmg"
  make_dmg() {
    local stage; stage="$(mktemp -d)"
    cp -R "$APP" "$stage/"; ln -s /Applications "$stage/Applications"
    rm -f "$DMG_OUT"
    hdiutil create -quiet -volname "LLM-IDE" -srcfolder "$stage" -format UDZO -ov "$DMG_OUT"
    rm -rf "$stage"
  }
  run "Make the .dmg" make_dmg
fi

printf '%s\n' "$BUILD_KEY" >"$STAMP"

ELAPSED=$((SECONDS - BUILD_START))
echo
echo "Built in $((ELAPSED / 60))m $((ELAPSED % 60))s"
echo "  app:  $APP ($(du -sh "$APP" | cut -f1))"
[ -n "$DMG_OUT" ] && echo "  dmg:  $DMG_OUT ($(du -h "$DMG_OUT" | cut -f1))"
[ "$VERBOSE" = 1 ] || echo "  log:  $LOG_FILE"
echo
echo "Open it with:  open \"$APP\""
if [ "$VERBOSE" = 1 ]; then
  echo
  echo "Built here, so macOS has not quarantined it. Only if you COPY it from another machine or download the .dmg, run:"
  echo "  xattr -dr com.apple.quarantine /Applications/LLM-IDE.app"
  echo "Then follow desktop/RUN-ON-MAC.md."
fi
