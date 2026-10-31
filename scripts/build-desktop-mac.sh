#!/usr/bin/env bash
# Builds LLM-IDE.app (the Tauri desktop app) for THIS Mac, verifies it, and prints how to open it.
#
#   scripts/build-desktop-mac.sh [--dmg] [--skip-checks] [--no-smoke]
#
#   --dmg          also make LLM-IDE-<version>-<arch>.dmg next to the .app (hdiutil, no Finder scripting)
#   --skip-checks  skip `npm run check:security` before the build
#   --no-smoke     skip the core smoke test and the shell e2e suite against the core inside the built app
#
# Idempotent: every run restages the core from scratch and rebuilds; nothing outside desktop/ is touched.
# Needs network on the first run (pinned official Node download, npm ci, cargo crates). Nothing here launches
# the app and nothing calls a model. Output: desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app
#
# Signing: the app is signed AD-HOC (`codesign --sign -`), which is all a locally built app needs. Hardened
# runtime and entitlements are NOT used: they matter only for a Developer ID signature + notarization, which
# would need `com.apple.security.cs.allow-jit` and `com.apple.security.cs.disable-library-validation` for the
# bundled node and better-sqlite3 (see docs/how-to/desktop-signing-decisions.md).
set -euo pipefail

DMG=0; CHECKS=1; SMOKE=1
for a in "$@"; do
  case "$a" in
    --dmg) DMG=1 ;;
    --skip-checks) CHECKS=0 ;;
    --no-smoke) SMOKE=0 ;;
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

step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1 ($2)" >&2; exit 2; }; }

# Prefer the rustup stable toolchain's own cargo: a `cargo` earlier on PATH can be a broken rustup proxy
# (it prints "this is the version for the rustup toolchain manager") or a Homebrew rust, which cannot build this.
for d in "$HOME/.rustup/toolchains/stable-$RUST_TRIPLE/bin"; do
  [ -x "$d/cargo" ] && PATH="$d:$PATH" && break
done
[ -x "$HOME/.cargo/bin/cargo" ] && PATH="$PATH:$HOME/.cargo/bin"
need node "install Node 20+"; need npm "comes with Node"; need cargo "install Rust with rustup (https://rustup.rs)"
need codesign "Xcode command line tools: xcode-select --install"; need plutil "macOS"
echo "node $(node -v), $(cargo --version), target $TARGET"

npm_ci_if_needed() { # dir
  local dir="$1"
  if [ ! -d "$dir/node_modules" ] || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
    step "npm ci in ${dir#$ROOT/}"
    (cd "$dir" && npm ci --no-audit --no-fund)
  fi
}
npm_ci_if_needed "$ROOT/ui/kit"
npm_ci_if_needed "$DESKTOP"

step "Stage the core (pinned official Node, production dependencies, no SDK claude binary)"
LLMIDE_STAGE_RELEASE=1 node "$DESKTOP/scripts/stage-core.mjs" --target "$TARGET"

if [ "$CHECKS" = 1 ]; then
  step "Security checks (capability manifest, DOMPurify pin)"
  (cd "$DESKTOP" && npm run --silent check:security)
fi

step "Build the app (frontend + release Rust binary; the first cargo build takes several minutes)"
(cd "$DESKTOP" && npx tauri build --bundles app)

APP="$DESKTOP/src-tauri/target/release/bundle/macos/LLM-IDE.app"
[ -d "$APP" ] || { echo "build finished but $APP is missing" >&2; exit 1; }

step "Ad-hoc sign"
# Re-sign the whole bundle in one pass so the seal covers the bundled core. No hardened runtime (see header).
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

step "Verify the bundle"
node "$DESKTOP/scripts/verify-bundle.mjs" "$APP"
echo "bundle id: $(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist") (the Swift Mac app is com.llmide.macapp; they can run side by side)"
echo "app data:  ~/Library/Application Support/llm-ide-desktop (the Swift app uses .../llm-ide)"

if [ "$SMOKE" = 1 ]; then
  step "Smoke-test the core inside the app (health + nonce, DB under the data dir, claude probe, clean stop)"
  LLMIDE_CORE_DIR="$APP/Contents/Resources/core" node "$DESKTOP/scripts/smoke-core.mjs"
  step "Run the shell end-to-end suite against the core inside the app (fake engine, no model call)"
  (cd "$DESKTOP" && LLMIDE_E2E_BUNDLE="$APP/Contents/Resources/core" node --test --experimental-strip-types ../ui/screens/shell/tests/e2e/e2e.test.mjs)
fi

if [ "$DMG" = 1 ]; then
  step "Make the .dmg"
  VERSION="$(node -p "require('$DESKTOP/src-tauri/tauri.conf.json').version")"
  OUT="$(dirname "$APP")/LLM-IDE-$VERSION-$(uname -m).dmg"
  STAGE="$(mktemp -d)"
  cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
  rm -f "$OUT"
  hdiutil create -quiet -volname "LLM-IDE" -srcfolder "$STAGE" -format UDZO -ov "$OUT"
  rm -rf "$STAGE"
  echo "dmg: $OUT ($(du -h "$OUT" | cut -f1))"
fi

step "Done"
echo "app:  $APP ($(du -sh "$APP" | cut -f1))"
echo
echo "Open it with:"
echo "  open \"$APP\""
echo
echo "Built here, so macOS has not quarantined it. Only if you COPY it from another machine or download the .dmg, run:"
echo "  xattr -dr com.apple.quarantine /Applications/LLM-IDE.app"
echo "Then follow desktop/RUN-ON-MAC.md."
