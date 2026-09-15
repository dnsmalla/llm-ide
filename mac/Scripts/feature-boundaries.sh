#!/usr/bin/env bash
# Enforce the layering rule: Shell -> Features -> Core.
# A Feature may reference Core and Shell-owned symbols, but NEVER another
# Feature's. Swift has no intra-target boundary enforcement, so this is a
# textual check. See docs/superpowers/specs/2026-09-15-mac-feature-isolation-design.md
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$ROOT/Sources/LlmIdeMac"
MAP="$(dirname "$0")/feature-map.txt"
# mktemp -d alone can ignore a sandboxed TMPDIR; name the dir explicitly.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fb.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# libExcludes paths, extracted once and reused by both the exclude-path
# existence check (below) and the Shell/Core build-exclusion check: a
# `Features/X` entry here names a feature the lite/min builds can drop
# entirely, so Shell/Core code may never depend on its symbols unguarded.
perl -0777 -ne '
  while (/var\s+libExcludes:\s*\[String\]\s*=\s*\[(.*?)\]/gs) { print "$1\n"; }
  while (/libExcludes\.append\(contentsOf:\s*\[(.*?)\]\)/gs) { print "$1\n"; }
  while (/libExcludes\.append\((\"[^\"]*\")\)/gs) { print "$1\n"; }
' "$ROOT/Package.swift" \
  | grep -oE '"[^"]+"' | tr -d '"' | sort -u > "$WORK/libexcludes.txt"

layer_of() {
  local rel="$1" prefix lay sealed
  while read -r prefix lay sealed; do
    [[ -z "$prefix" || "$prefix" == \#* ]] && continue
    [[ "$rel" == $prefix* ]] && { echo "$lay"; return; }
  done < "$MAP"
  echo "Unclassified"
}

is_sealed() {
  local want="$1" prefix lay sealed
  while read -r prefix lay sealed; do
    [[ -z "$prefix" || "$prefix" == \#* ]] && continue
    [[ "$lay" == "$want" && "$sealed" == "sealed" ]] && { echo yes; return; }
  done < "$MAP"
  echo no
}

# Comments and string literals must go before ANY matching: doc-comment prose
# like "mirroring AutoCodeView's split" is not a dependency, and counting it
# produced 9 of 13 false positives when this gate was prototyped.
strip() {
  perl -0777 -pe '
    s{/\*.*?\*/}{}gs;
    s{"""[^"]*(?:"(?!"")[^"]*)*"""}{""}gs;
    s{"(?:\\.|[^"\\\n])*"}{""}g;
    s{//[^\n]*}{}g;' "$1"
}

# For the Shell/Core build-exclusion check only: drop the body of any
# `#if FEATURE_x` (non-negated) branch. That code is compiled out together
# with the excluded feature it's guarding, so a reference inside it is not
# the Terminal-style bug (an UNCONDITIONAL reference) this check targets —
# see Shell/FeatureCatalog.swift, whose whole job is exactly this pattern.
# The `#else`/un-guarded-off branch is left in place and still scanned. No
# nesting of `#if FEATURE_*` exists in this codebase, so one flag suffices.
strip_feature_guards() {
  perl -ne '
    if (/^\s*#if\s+(?!!)FEATURE_/) { $skip = 1; next }
    if (/^\s*#else\b/)            { $skip = 0; next }
    if (/^\s*#endif\b/)           { $skip = 0; next }
    print unless $skip;
  '
}

# 1. Declaration map: symbol -> layer.
#    TOP-LEVEL declarations only (column 0). A nested `enum Error` inside a
#    Loop type otherwise claims every stdlib `Error` in the module — that one
#    bug produced 8 of the 13 false positives in the prototype.
find "$SRC" -name '*.swift' | while read -r f; do
  rel="${f#"$SRC"/}"
  strip "$f" \
    | grep -oE '^(public |internal |final |@MainActor )*(class|struct|enum|protocol|actor) [A-Z][A-Za-z0-9_]{2,}' \
    | awk -v l="$(layer_of "$rel")" '{print $NF, l}'
done | sort -u > "$WORK/decls.txt"

# Symbols declared in more than one place cannot be attributed to an owner;
# skip them rather than guess.
awk '{print $1}' "$WORK/decls.txt" | uniq -d > "$WORK/dupes.txt"
if [ -s "$WORK/dupes.txt" ]; then
  grep -vwFf "$WORK/dupes.txt" "$WORK/decls.txt" > "$WORK/owned.txt"
else
  cp "$WORK/decls.txt" "$WORK/owned.txt"
fi

awk '$2 ~ /^Feature:/ {print $2}' "$WORK/owned.txt" | sort -u > "$WORK/features.txt"

# 2. Scan every Feature-owned file for other Features' symbols.
: > "$WORK/violations.txt"
find "$SRC" -name '*.swift' | sort | while read -r f; do
  rel="${f#"$SRC"/}"
  consumer="$(layer_of "$rel")"
  [[ "$consumer" != Feature:* ]] && continue   # Core and Shell may reference anything
  body="$(strip "$f")"
  while read -r owner; do
    [[ "$owner" == "$consumer" ]] && continue
    syms="$(awk -v o="$owner" '$2==o{print $1}' "$WORK/owned.txt" | paste -sd'|' -)"
    [[ -z "$syms" ]] && continue
    hits="$(printf '%s' "$body" | grep -owE "$syms" | sort -u | paste -sd, -)"
    [[ -n "$hits" ]] && \
      echo "${consumer#Feature:}|$rel  ->  ${owner#Feature:}  [$hits]" >> "$WORK/violations.txt"
  done < "$WORK/features.txt"
done

# 2b. Report (never fail on) Feature -> Unclassified references. An edge that
#     will matter once the other side is classified should be visible now
#     rather than ambushing whichever later task moves that code.
: > "$WORK/pending.txt"
uc_syms="$(awk '$2=="Unclassified"{print $1}' "$WORK/owned.txt" | paste -sd'|' -)"
if [ -n "$uc_syms" ]; then
  find "$SRC" -name '*.swift' | sort | while read -r f; do
    rel="${f#"$SRC"/}"
    consumer="$(layer_of "$rel")"
    [[ "$consumer" != Feature:* ]] && continue
    body="$(strip "$f")"
    hits="$(printf '%s' "$body" | grep -owE "$uc_syms" | sort -u | paste -sd, -)"
    [[ -n "$hits" ]] && \
      echo "${consumer#Feature:}|$rel  ->  Unclassified  [$hits]" >> "$WORK/pending.txt"
  done
fi

# 3. Report everything; fail only on SEALED features.
#    A total-count ratchet would block this migration: classifying Explorer
#    makes previously-invisible Explorer<->SourceControl references countable
#    for the first time, so the total rises as a direct result of progress.
status=0
echo "=== cross-feature references ==="
sort "$WORK/violations.txt" | while IFS='|' read -r feat line; do
  if [ "$(is_sealed "Feature:$feat")" = yes ]; then
    echo "  FAIL  [sealed $feat] $line"
  else
    echo "  warn  [$feat] $line"
  fi
done
sealed_hits=0
while IFS='|' read -r feat line; do
  [ "$(is_sealed "Feature:$feat")" = yes ] && sealed_hits=$((sealed_hits+1))
done < "$WORK/violations.txt"
echo "total: $(wc -l < "$WORK/violations.txt" | tr -d ' ')  sealed violations: $sealed_hits"
[ "$sealed_hits" -gt 0 ] && { echo "FAIL: a sealed feature references another feature" >&2; status=1; }

echo "=== pending (feature -> unclassified) — informational, never fails ==="
if [ -s "$WORK/pending.txt" ]; then
  sort "$WORK/pending.txt" | while IFS='|' read -r feat line; do
    echo "  pending  [$feat] $line"
  done
else
  echo "  none"
fi

# 3b. Shell/Core is exempt from the cross-feature BOUNDARY rule above (it may
#     reference any feature's symbols), but it is NOT exempt from build
#     exclusion: a Feature folder named in Package.swift's libExcludes can be
#     compiled out entirely (lite/min builds), so an unguarded Shell/Core
#     reference into it is a real compile-time break, not a style nit. This
#     is the exact shape of the Task 8 Terminal failure: Shell/AppShell.swift
#     referenced TerminalPanelState unconditionally after it moved into a
#     now-excludable Features/Terminal folder, and the boundary check above
#     never saw it because Shell consumers are always allowed through it.
: > "$WORK/exc-layers.txt"
while read -r p; do
  [[ "$p" == Features/* ]] || continue
  layer_of "$p/" >> "$WORK/exc-layers.txt"
done < "$WORK/libexcludes.txt"
sort -u -o "$WORK/exc-layers.txt" "$WORK/exc-layers.txt"

: > "$WORK/shell-violations.txt"
if [ -s "$WORK/exc-layers.txt" ]; then
  find "$SRC" -name '*.swift' | sort | while read -r f; do
    rel="${f#"$SRC"/}"
    consumer="$(layer_of "$rel")"
    [[ "$consumer" == "Shell" || "$consumer" == "Core" ]] || continue
    body="$(strip "$f" | strip_feature_guards)"
    while read -r owner; do
      [[ -z "$owner" ]] && continue
      syms="$(awk -v o="$owner" '$2==o{print $1}' "$WORK/owned.txt" | paste -sd'|' -)"
      [[ -z "$syms" ]] && continue
      hits="$(printf '%s' "$body" | grep -owE "$syms" | sort -u | paste -sd, -)"
      [[ -n "$hits" ]] && \
        echo "$consumer|$rel  ->  ${owner#Feature:} (build-excludable)  [$hits]" >> "$WORK/shell-violations.txt"
    done < "$WORK/exc-layers.txt"
  done
fi

echo "=== Shell/Core references into build-excludable features ==="
if [ -s "$WORK/shell-violations.txt" ]; then
  sort "$WORK/shell-violations.txt" | while IFS='|' read -r layer line; do
    echo "  ERROR  [$layer] $line"
  done
  echo "FAIL: Shell/Core references a symbol owned by a build-excludable feature" >&2
  status=1
else
  echo "  none"
fi

# 4. Every Package.swift exclude path must exist. SwiftPM only WARNS on an
#    invalid exclude and exits 0, so a file moved out from under one silently
#    rejoins the lite build. This migration moves ~250 files past that hazard.
#    Scoped to `libExcludes` only: those paths are relative to Sources/LlmIdeMac
#    ($SRC) and drive the lite/min builds this check protects. `testExcludes`
#    entries are relative to Tests/LlmIdeMacTests, a different root this script
#    never computes, and a naive whole-file grep for quoted strings also picks
#    up unrelated product/target names (GraphCore, GraphKit, ChatContractLab) —
#    both would report false MISSING paths that no build ever excluded.
echo "=== Package.swift exclude paths ==="
missing=0
while read -r p; do
  [ -e "$SRC/$p" ] || { echo "  MISSING: $p"; }
done < "$WORK/libexcludes.txt" > "$WORK/missing.txt"
if [ -s "$WORK/missing.txt" ]; then
  cat "$WORK/missing.txt"
  echo "FAIL: Package.swift names exclude paths that do not exist" >&2
  status=1
else
  echo "  all exclude paths exist"
fi

# testExcludes entries are bare filenames checked against the test target's
# OWN root (Tests/LlmIdeMacTests per Package.swift's .testTarget `path:`),
# never $SRC — a different directory than the lib target this script otherwise
# only knows about. Same hazard as libExcludes: SwiftPM only WARNS on an
# invalid exclude and exits 0, so a renamed/moved test file leaves a stale
# entry that silently stops excluding anything and the test target's shape
# drifts without anyone noticing.
TESTROOT="$ROOT/Tests/LlmIdeMacTests"
perl -0777 -ne '
  while (/var\s+testExcludes:\s*\[String\]\s*=\s*\[(.*?)\]/gs) { print "$1\n"; }
  while (/testExcludes\.append\(contentsOf:\s*\[(.*?)\]\)/gs) { print "$1\n"; }
  while (/testExcludes\.append\((\"[^\"]*\")\)/gs) { print "$1\n"; }
  while (/mobileTestExcludes:\s*Set<String>\s*=\s*\[(.*?)\]/gs) { print "$1\n"; }
' "$ROOT/Package.swift" \
  | grep -oE '"[^"]+"' | tr -d '"' | sort -u | while read -r p; do
      [ -e "$TESTROOT/$p" ] || { echo "  MISSING: $p"; }
    done > "$WORK/missing-test.txt"
if [ -s "$WORK/missing-test.txt" ]; then
  cat "$WORK/missing-test.txt"
  echo "FAIL: Package.swift names testExcludes paths that do not exist under Tests/LlmIdeMacTests" >&2
  status=1
else
  echo "  all testExcludes paths exist"
fi

exit $status
