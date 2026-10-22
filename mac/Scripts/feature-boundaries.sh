#!/usr/bin/env bash
# Enforce the layering rule: Shell -> Features -> Core.
# A Feature may reference Core and Shell-owned symbols, but NEVER another
# Feature's. Swift has no intra-target boundary enforcement, so this is a
# textual check. See docs/superpowers/specs/2026-09-15-mac-feature-isolation-design.md
#
# Checks, in script order (numbers match the section comments below):
#   1-3  feature -> feature references (warn; FAIL only for `sealed` features)
#        and feature -> Unclassified (informational)
#   3a   #elseif in an always-compiled layer                        (FAIL)
#   3b   always-compiled layer -> build-excludable feature, unguarded (FAIL)
#   4    Package.swift libExcludes / testExcludes paths exist         (FAIL)
#   5    non-Swift files name only existing LlmIdeMac/*.swift paths   (FAIL)
#   6    tests naming an excludable feature's type are testExcluded   (FAIL)
#   7    Core is a leaf: Core/ClaudeLink never name Shell/feature types,
#        bar CORE_LEAF_ALLOWLIST; stale allowlist rows also FAIL      (FAIL)
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

# Folder -> FEATURE_* flag correspondence, DERIVED (not hardcoded) from each
# `if <cond> { featureDefines.append(.define("FEATURE_X")) } else { ... }`
# block in Package.swift: the quoted strings at the TOP LEVEL of that
# else-block (i.e. not inside a further-nested `if`, like the `auto_tasks`
# sub-block under `mobileIncluded`'s else) are the paths FEATURE_X's
# exclusion controls. This can't be a naming-convention lookup — `file_explorer`
# guards `Features/Search` as `FEATURE_EXPLORER`, not `FEATURE_SEARCH` — so it
# has to be parsed. Brace-depth tracked by hand because these else-blocks are
# not flat (see the nested `if autoTasksIncluded` case above).
perl -e '
  local $/; my $text = <STDIN>;
  while ($text =~ /if\s+\w+\s*\{\s*featureDefines\.append\(\.define\("([^"]+)"\)\)\s*\}\s*else\s*\{/gs) {
    my $flag = $1;
    my $start = pos($text);
    my $depth = 1; my $i = $start; my $len = length($text);
    while ($i < $len && $depth > 0) {
      my $c = substr($text, $i, 1);
      $depth++ if $c eq "{";
      $depth-- if $c eq "}";
      $i++;
    }
    my $body = substr($text, $start, $i - $start - 1);
    my $d = 0; my $flat = "";
    for my $c (split //, $body) {
      if ($c eq "{") { $d++; $flat .= " "; next; }
      if ($c eq "}") { $d--; $flat .= " "; next; }
      $flat .= ($d == 0 ? $c : " ");
    }
    while ($flat =~ /"([^"]+)"/g) { print "$flag\t$1\n"; }
  }
' < "$ROOT/Package.swift" | sort -u > "$WORK/flagmap.txt"

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

# For the Shell/Core build-exclusion check only: given the ONE flag that
# actually controls a specific owner's exclusion (looked up in flagmap.txt,
# never guessed), drop the body of whichever branch does not compile when
# that flag is false — i.e. the branch that is guaranteed absent in the
# build the owner's folder is excluded from. Any OTHER `#if FEATURE_*` guard
# (a different feature entirely) is left untouched and still scanned: a
# guard naming the wrong flag must not hide the reference, or this reopens
# the exact hole the check exists to close (see task-8a-report.md round 1 —
# a reviewer-reproduced `#if FEATURE_AUTOTASK` wrapped around the Terminal
# reference in AppShell.swift made the ERROR vanish under the old blanket
# "any FEATURE_*" stripper).
#
# Stack-based (not a single flag) so nested guards resolve correctly, and
# negation-aware so `#if !FLAG / <unsafe> / #else / <safe> / #endif` hides
# the right branch instead of the literal-opposite one. Conservative on `||`:
# `#if FLAG || OTHER` can still compile even when FLAG is false, so it is
# never treated as safe cover regardless of branch.
strip_feature_guard_for_flag() {
  local flag="$1"
  perl -e '
    my $flag = shift @ARGV;
    my @stack;
    while (my $line = <STDIN>) {
      if ($line =~ /^\s*#if\s+(.*)$/) {
        my $cond = $1;
        my $relevant = 0;
        my $negated = 0;
        if ($cond !~ /\|\|/ && $cond =~ /\b\Q$flag\E\b/) {
          $relevant = 1;
          $negated = ($cond =~ /!\s*\Q$flag\E\b/) ? 1 : 0;
        }
        push @stack, { relevant => $relevant, negated => $negated, inElse => 0 };
        next;
      }
      if ($line =~ /^\s*#else\b/) {
        $stack[-1]{inElse} = 1 if @stack;
        next;
      }
      if ($line =~ /^\s*#endif\b/) {
        pop @stack if @stack;
        next;
      }
      my $hidden = 0;
      for my $fr (@stack) {
        next unless $fr->{relevant};
        my $h = (!$fr->{negated} && !$fr->{inElse}) || ($fr->{negated} && $fr->{inElse});
        if ($h) { $hidden = 1; last; }
      }
      print $line unless $hidden;
    }
  ' "$flag"
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

# Build-excludable layers (and the FEATURE_* flag that excludes each), shared
# by 3a, 3b and 6. Computed here, ahead of 3a, because 3a's consumer set is
# derived from it.
: > "$WORK/exc-layers.txt"
: > "$WORK/layer-flag.txt"
while read -r p; do
  [[ "$p" == Features/* ]] || continue
  lay="$(layer_of "$p/")"
  echo "$lay" >> "$WORK/exc-layers.txt"
  flag="$(awk -F'\t' -v path="$p" '$2==path{print $1; exit}' "$WORK/flagmap.txt")"
  [ -n "$flag" ] && printf '%s\t%s\n' "$lay" "$flag" >> "$WORK/layer-flag.txt"
done < "$WORK/libexcludes.txt"
sort -u -o "$WORK/exc-layers.txt" "$WORK/exc-layers.txt"
sort -u -o "$WORK/layer-flag.txt" "$WORK/layer-flag.txt"
# Always-compiled layers = every layer the map (or the Unclassified default)
# can produce, minus the excludable ones. Derived rather than listed so a
# newly classified always-compiled feature is checked without editing this
# script, and a feature that becomes excludable drops out automatically.
{ awk '!/^#/ && NF>=2 {print $2}' "$MAP"; echo Unclassified; } | sort -u \
  | grep -vxFf "$WORK/exc-layers.txt" > "$WORK/always-layers.txt"
is_always_compiled() { grep -qxF "$1" "$WORK/always-layers.txt"; }

# 3a. `strip_feature_guard_for_flag` only understands `#if`/`#else`/`#endif`.
#     An `#elseif` branch inherits its enclosing `#if` frame's hidden/visible
#     state as written today, which is backwards for the branch that runs
#     when the target flag is FALSE — a genuine false negative, not a
#     hypothetical one (reviewer-reproduced: `#if FEATURE_TERMINAL / x /
#     #elseif DEBUG / <ref> / #endif` silently passed). Full `#elseif`
#     support is deliberately out of scope; refuse it outright instead of
#     guessing, so the first `#elseif` in an always-compiled layer forces a
#     person to either restructure it (nested #if/#else) or extend the parser
#     on purpose. Same consumer set as 3b, since 3b runs the parser on them.
: > "$WORK/elseif-hits.txt"
find "$SRC" -name '*.swift' | sort | while read -r f; do
  rel="${f#"$SRC"/}"
  consumer="$(layer_of "$rel")"
  is_always_compiled "$consumer" || continue
  grep -n '^[[:space:]]*#elseif\b' "$f" | while IFS=: read -r lineno _; do
    echo "$rel:$lineno" >> "$WORK/elseif-hits.txt"
  done
done

echo "=== #elseif in always-compiled layers (unsupported by the guard parser) ==="
if [ -s "$WORK/elseif-hits.txt" ]; then
  sort "$WORK/elseif-hits.txt" | while read -r loc; do
    echo "  ERROR  $loc  — strip_feature_guard_for_flag has no #elseif support; restructure as nested #if/#else or extend the parser deliberately"
  done
  echo "FAIL: #elseif found in an always-compiled layer; the build-exclusion guard parser cannot reason about it safely" >&2
  status=1
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
#
#     The same break applies to EVERY always-compiled layer, not only
#     Shell/Core: Chat, Library, Live, Settings and ReviewConflicts are
#     compiled into build-mac-min too, and the boundary check only `warn`s on
#     their cross-feature edges (none of them is sealed), so an unguarded
#     reference from one of them into an excludable folder would pass this
#     gate and surface only as a compile error in a reduced build.
#     Unclassified is included for the same reason — nothing excludes those
#     folders either.
: > "$WORK/shell-violations.txt"
# Per-owner symbol alternations, built once: the consumer loop below now
# covers several hundred more files than Shell/Core alone, and re-running awk
# over owned.txt per (file, owner) pair dominated its runtime.
mkdir -p "$WORK/exc-syms"
while read -r owner; do
  [[ -z "$owner" ]] && continue
  awk -v o="$owner" '$2==o{print $1}' "$WORK/owned.txt" | paste -sd'|' - > "$WORK/exc-syms/${owner#Feature:}"
done < "$WORK/exc-layers.txt"
if [ -s "$WORK/exc-layers.txt" ]; then
  find "$SRC" -name '*.swift' | sort | while read -r f; do
    rel="${f#"$SRC"/}"
    consumer="$(layer_of "$rel")"
    is_always_compiled "$consumer" || continue
    raw_body="$(strip "$f")"
    while read -r owner; do
      [[ -z "$owner" ]] && continue
      syms="$(cat "$WORK/exc-syms/${owner#Feature:}")"
      [[ -z "$syms" ]] && continue
      # Fail closed: no derivable flag for this owner means no guard can be
      # trusted to hide it, so scan the RAW (unstripped-of-guards) body.
      flag="$(awk -F'\t' -v o="$owner" '$1==o{print $2; exit}' "$WORK/layer-flag.txt")"
      if [ -n "$flag" ]; then
        body="$(printf '%s' "$raw_body" | strip_feature_guard_for_flag "$flag")"
      else
        body="$raw_body"
      fi
      hits="$(printf '%s' "$body" | grep -owE "$syms" | sort -u | paste -sd, -)"
      [[ -n "$hits" ]] && \
        echo "$consumer|$rel  ->  ${owner#Feature:} (build-excludable)  [$hits]" >> "$WORK/shell-violations.txt"
    done < "$WORK/exc-layers.txt"
  done
fi

echo "=== always-compiled layer references into build-excludable features ==="
if [ -s "$WORK/shell-violations.txt" ]; then
  sort "$WORK/shell-violations.txt" | while IFS='|' read -r layer line; do
    echo "  ERROR  [$layer] $line"
  done
  echo "FAIL: an always-compiled layer references a symbol owned by a build-excludable feature" >&2
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

# 5. Non-Swift files naming a stale mac/Sources/LlmIdeMac path. Swift is one
#    module, so moving a file inside it never breaks a Swift build — every
#    check above only ever catches that class. It silently breaks anything
#    OUTSIDE Swift that names a path by hand: a script, a Makefile target, a
#    CI step. This is exactly how conformance-agent-v2.mjs kept hardcoding
#    the pre-migration Views/DocGen/DocGenView.swift and
#    Views/Visual/VisualView.swift after the Features/ migration moved both
#    (to Features/DocGen/Views/ and Features/Visual/Views/), undetected through three reviews
#    because every one of them only re-ran Swift builds and the boundary
#    gate above.
#
#    Scope is deliberately narrow: scripts/, mac/Scripts/, and Makefile —
#    not a repo-wide scan. A repo-wide grep for "Sources/LlmIdeMac" also
#    matches explanatory comments naming a file for context
#    (extension/kb/chat-sessions.mjs, extension/llm_agent/runtime/loop.mjs)
#    and test/schema fixture payloads that deliberately reference paths as
#    sample data, not real files (extension/tests/fence-output-hygiene.test.mjs,
#    schema/agent-v2/fixtures/approval_request_tool.json). None of those live
#    under scripts/, mac/Scripts/, or Makefile, so narrowing the search root
#    already clears every false positive found surveying this repo — no
#    ignore list needed. A gate that cries wolf gets ignored, and eight more
#    feature-move tasks depend on this one being trusted.
#
#    Matching is further restricted to literals ending in `.swift`: the
#    hazard this closes is a stale SOURCE FILE reference, not a stale
#    directory (e.g. `Sources/LlmIdeMac/Resources`, mentioned in
#    mac/Scripts/build.sh and mac/Scripts/build-monaco-bundle.mjs, is a real,
#    unmoved directory, not a file this check can usefully validate). The
#    `.swift` restriction also happens to skip every comment found in-scope
#    (mac/Scripts/feature-boundaries.sh's own prose, Makefile's), since none
#    of them names a specific .swift file — verified by survey, not assumed.
echo "=== non-Swift files naming a stale mac/Sources/LlmIdeMac/*.swift path ==="
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
: > "$WORK/stale-path-hits.txt"
{
  find "$REPO_ROOT/scripts" "$ROOT/Scripts" -type f \
    \( -name '*.mjs' -o -name '*.js' -o -name '*.sh' -o -name '*.yml' -o -name '*.yaml' -o -name '*.json' \) \
    2>/dev/null
  [ -f "$REPO_ROOT/Makefile" ] && echo "$REPO_ROOT/Makefile"
} | grep -vE '/(node_modules|\.build|\.superpowers)/' | sort -u | while read -r f; do
  grep -noE '(mac/)?Sources/LlmIdeMac/[A-Za-zA-Z0-9_./-]+\.swift' "$f" | while IFS=: read -r lineno lit; do
    if [[ "$lit" == mac/Sources/LlmIdeMac/* ]]; then
      target="$REPO_ROOT/$lit"
    else
      target="$ROOT/$lit"
    fi
    [ -e "$target" ] || echo "${f#"$REPO_ROOT"/}:$lineno  names \"$lit\" which does not exist" >> "$WORK/stale-path-hits.txt"
  done
done
if [ -s "$WORK/stale-path-hits.txt" ]; then
  sort -u "$WORK/stale-path-hits.txt" | while read -r line; do
    echo "  ERROR  $line"
  done
  echo "FAIL: a non-Swift file names a mac/Sources/LlmIdeMac/*.swift path that does not exist" >&2
  status=1
else
  echo "  none"
fi

# 6. Every test file that names a type owned by a build-excludable feature
#    must be in THAT feature's testExcludes. The test target is never compiled
#    with features removed (`make regression` and CI run `swift test` on the
#    full build only; lite/min/mobile-only are built, not tested), so a
#    missing entry is invisible until someone runs
#    `swift build --build-tests` under a reduced LLMIDE_FEATURES — by which
#    time 50 files had drifted out of the hand-maintained lists. Package.swift
#    is the source of truth for both sides: which Sources paths each FEATURE_*
#    flag excludes, and which test files it excludes with them.
#
#    Ownership is by TOP-LEVEL declaration only. A nested type (e.g. a
#    feature's `enum Error` or `struct Key`) is reachable from a test only
#    through its parent's name, which already counts, while matching the bare
#    nested name flags every unrelated `Error`/`Key` in the suite. A name is
#    owned by a flag only when EVERY declaration of it lies under that flag's
#    excluded paths — a name declared elsewhere too cannot be attributed, the
#    same rule as the declaration map in check 1. Known blind spot, by
#    construction: extension members and top-level functions/typealiases
#    declared inside an excludable folder are not types and are not seen.
#
#    Excluded paths per flag come from two shapes: the else-body of
#    `if x { featureDefines.append(.define("F")) } else { ... }` (any nesting
#    depth, so the `if !testExcludes.contains(...)` dedupe appends count), and
#    any other `if ... !x { libExcludes.append(...) }` block — a per-file
#    exclude for a cross-feature quadrant would be written that way, and its
#    types would then belong to that flag as well. (The Auto Task / Loop
#    mobile bridges once needed one; they now live in their own features
#    behind Core/Contracts' `MobileBridgeHosting`, so none exists today.)
echo "=== test files referencing build-excludable feature types vs testExcludes ==="
perl -e '
  local $/; my $t = <STDIN>;
  sub body_at { my ($text, $start) = @_; my $d = 1; my $i = $start; my $n = length($text);
    while ($i < $n && $d > 0) { my $c = substr($text, $i, 1); $d++ if $c eq "{"; $d-- if $c eq "}"; $i++; }
    return substr($text, $start, $i - $start - 1); }
  sub emit { my ($flag, $body) = @_;
    while ($body =~ /"([^"]+)"/g) { my $v = $1;
      if ($v =~ m{^Features/}) { print "L\t$flag\t$v\n"; }
      elsif ($v =~ /\.swift$/) { print "T\t$flag\t$v\n"; } } }
  my %varflag;
  while ($t =~ /if\s+(\w+)\s*\{\s*featureDefines\.append\(\.define\("([^"]+)"\)\)\s*\}\s*else\s*\{/gs) {
    $varflag{$1} = $2; emit($2, body_at($t, pos($t)));
  }
  while ($t =~ /\bif\s+[^{\n]*?!\s*(\w+)\s*\{/g) {
    next unless exists $varflag{$1};
    emit($varflag{$1}, body_at($t, pos($t)));
  }
' < "$ROOT/Package.swift" | sort -u > "$WORK/flag-excludes.txt"

# One perl process for every Sources file (not one per file, as check 1 does)
# keeps this check to about a second. Rows of toplevel-all.txt:
# name<TAB>path relative to Sources/<TAB>keyword. Check 6 uses the TYPE rows
# only (toplevel-decls.txt: name<TAB>path, no typealias); check 7 also needs
# top-level typealiases, since Core naming a feature's typealias is the same
# leaf violation as naming its struct.
find "$ROOT/Sources" -name '*.swift' -print0 | xargs -0 perl -e '
  my $root = shift @ARGV;
  for my $f (@ARGV) {
    open(my $fh, "<", $f) or next; local $/; my $t = <$fh>; close $fh;
    $t =~ s{/\*.*?\*/}{}gs; $t =~ s{"""[^"]*(?:"(?!"")[^"]*)*"""}{""}gs;
    $t =~ s{"(?:\\.|[^"\\\n])*"}{""}g; $t =~ s{//[^\n]*}{}g;
    (my $rel = $f) =~ s{^\Q$root\E/}{};
    while ($t =~ /^(?:@\w+(?:\([^)\n]*\))?\s+|(?:public|package|internal|private|fileprivate|open|final|indirect|nonisolated)\s+)*(class|struct|enum|protocol|actor|typealias)\s+([A-Za-z_]\w*)/mg) {
      print "$2\t$rel\t$1\n";
    }
  }
' "$ROOT/Sources" | sort -u > "$WORK/toplevel-all.txt"
awk -F'\t' '$3 != "typealias" {print $1 "\t" $2}' "$WORK/toplevel-all.txt" \
  | sort -u > "$WORK/toplevel-decls.txt"

# Strip comments/strings from a set of files once, into a mirror tree, so a
# type named only in prose (`/// mirrors LoopStage`) never counts as a use.
# Usage: <NUL-separated absolute paths on stdin> | strip_tree_into ROOT OUT
# Each file lands at OUT/<path relative to ROOT>. Shared by checks 6 and 7.
strip_tree_into() {
  xargs -0 perl -e '
  my ($root, $out) = splice(@ARGV, 0, 2);
  for my $f (@ARGV) {
    open(my $fh, "<", $f) or next; local $/; my $t = <$fh>; close $fh;
    $t =~ s{/\*.*?\*/}{}gs; $t =~ s{"""[^"]*(?:"(?!"")[^"]*)*"""}{""}gs;
    $t =~ s{"(?:\\.|[^"\\\n])*"}{""}g; $t =~ s{//[^\n]*}{}g;
    (my $rel = $f) =~ s{^\Q$root\E/}{};
    my $dst = "$out/$rel"; (my $dir = $dst) =~ s{/[^/]+$}{};
    system("mkdir", "-p", $dir) unless -d $dir;
    open(my $oh, ">", $dst) or die "$dst: $!"; print $oh $t; close $oh;
  }
' "$1" "$2"
}
TESTROOT_STRIPPED="$WORK/tests-stripped"
mkdir -p "$TESTROOT_STRIPPED"
find "$TESTROOT" -name '*.swift' -print0 | strip_tree_into "$TESTROOT" "$TESTROOT_STRIPPED"

# Guard against a vacuous pass: the two lists below come from textual parsers
# of Package.swift and Sources/. If either parser silently yields nothing (a
# reformatted manifest, a changed declaration style), the loop would run zero
# times and report success without checking anything — so demand that every
# flag the flagmap knows is present with an L row, and that the declaration
# index is non-trivial, before trusting the result.
expected_flags="$(awk -F'\t' '{print $1}' "$WORK/flagmap.txt" | sort -u)"
parsed_flags="$(awk -F'\t' '$1=="L"{print $2}' "$WORK/flag-excludes.txt" | sort -u)"
if [ -z "$parsed_flags" ] || [ "$expected_flags" != "$parsed_flags" ]; then
  echo "  ERROR check 6 parser: flags with an L row in Package.swift ($(echo $parsed_flags | tr '\n' ' ')) != flagmap ($(echo $expected_flags | tr '\n' ' '))" >&2
  status=1
fi
decl_count="$(wc -l < "$WORK/toplevel-decls.txt" | tr -d ' ')"
if [ "$decl_count" -lt 100 ]; then
  echo "  ERROR check 6 parser: only $decl_count top-level declarations indexed under Sources/ (expected hundreds)" >&2
  status=1
fi

: > "$WORK/test-exclude-gaps.txt"
for flag in $(awk -F'\t' '$1=="L"{print $2}' "$WORK/flag-excludes.txt" | sort -u); do
  awk -F'\t' -v f="$flag" '$1=="L" && $2==f {print "LlmIdeMac/" $3}' "$WORK/flag-excludes.txt" > "$WORK/paths.$flag"
  awk -F'\t' -v f="$flag" '$1=="T" && $2==f {print $3}' "$WORK/flag-excludes.txt" > "$WORK/tests.$flag"
  # Owned = every declaration site of the name lies under one of the flag's paths.
  awk -F'\t' '
    NR == FNR { paths[++np] = $0; next }
    { total[$1]++
      for (i = 1; i <= np; i++) {
        p = paths[i]
        if ($2 == p || index($2, p "/") == 1) { inside[$1]++; break }
      } }
    END { for (n in total) if (inside[n] == total[n]) print n }
  ' "$WORK/paths.$flag" "$WORK/toplevel-decls.txt" | sort > "$WORK/names.$flag"
  [ -s "$WORK/names.$flag" ] || continue
  grep -rlwFf "$WORK/names.$flag" "$TESTROOT_STRIPPED" --include='*.swift' | sort | while read -r hit; do
    rel="${hit#"$TESTROOT_STRIPPED"/}"
    grep -qxF "$rel" "$WORK/tests.$flag" && continue
    names="$(grep -owFf "$WORK/names.$flag" "$hit" | sort -u | paste -sd, -)"
    echo "$flag|$rel  [$names]" >> "$WORK/test-exclude-gaps.txt"
  done
done
if [ -s "$WORK/test-exclude-gaps.txt" ]; then
  sort "$WORK/test-exclude-gaps.txt" | while IFS='|' read -r flag line; do
    echo "  ERROR  [$flag] $line  — add to that feature's testExcludes in Package.swift"
  done
  echo "FAIL: a test file names a build-excludable feature's type but is not excluded with that feature" >&2
  status=1
else
  echo "  every such test file is excluded with its feature"
fi

# 7. Core is a leaf. Every `.swift` file whose layer is `Core` (Core/** and
#    ClaudeLink/**, per feature-map.txt) may name only Core-, Unclassified-
#    and SDK-owned types — never a top-level type declared under a Shell or
#    Feature:* path. Checks 1–6 never looked at this direction: the boundary
#    rule exempts Core as a consumer, and 3b only sees Core -> BUILD-EXCLUDABLE
#    feature edges, so Core -> Chat/Library/Settings/Shell edges were invisible
#    until an ad-hoc scan found them. Forbidden = every top-level
#    class/struct/enum/protocol/actor/typealias declared under Sources/LlmIdeMac
#    in a Shell/Feature layer, minus any name ALSO declared in Core (a `#if`
#    stub/twin, or a collision the name cannot be attributed through — same
#    ownership rule as checks 1 and 6). Matched word-for-word against a
#    comment- and string-literal-stripped copy of each Core file, so prose
#    and log strings never count. Known blind spot: a name used ONLY inside a
#    string interpolation (`"\(Foo.bar)"`) is stripped with its literal.
#
#    Allowlist: one row per deliberate seam, TAB-separated
#    `path<TAB>symbol<TAB>reason`, path relative to Sources/LlmIdeMac. A row
#    skips exactly that (file, symbol) pair. A row whose file is gone, or
#    whose symbol that file no longer names as a Shell/feature type, FAILS as
#    stale — so the list can only shrink when the seam does, never rot.
CORE_LEAF_ALLOWLIST='Core/Contracts/LoopRunning.swift	LoopEngineConfig	deliberate #if FEATURE_AUTOTASK seam (see file doc comment)'

echo "=== Core-layer files naming Shell/feature types (Core must be a leaf) ==="
# Layer for each top-level declaration under LlmIdeMac/, using the same
# first-matching-prefix rule as layer_of() but in one awk pass.
# Rows: name<TAB>path relative to Sources/LlmIdeMac<TAB>layer.
awk -F'\t' '
  NR == FNR {
    if ($0 ~ /^[[:space:]]*(#|$)/) next
    n = split($0, col, " "); if (n < 2) next
    np++; pre[np] = col[1]; lay[np] = col[2]; next
  }
  index($2, "LlmIdeMac/") == 1 {
    rel = substr($2, length("LlmIdeMac/") + 1); l = "Unclassified"
    for (i = 1; i <= np; i++) if (index(rel, pre[i]) == 1) { l = lay[i]; break }
    print $1 "\t" rel "\t" l
  }
' "$MAP" "$WORK/toplevel-all.txt" > "$WORK/c7-decl-layers.txt"
awk -F'\t' '$3 == "Core" {print $1}' "$WORK/c7-decl-layers.txt" | sort -u > "$WORK/c7-core-names.txt"
# name<TAB>owner layers ("+"-joined when a name is declared in several).
awk -F'\t' '
  NR == FNR { core[$1] = 1; next }
  ($3 == "Shell" || $3 ~ /^Feature:/) && !($1 in core) {
    key = $1 SUBSEP $3
    if (!(key in seen)) { seen[key] = 1; own[$1] = ($1 in own) ? own[$1] "+" $3 : $3 }
  }
  END { for (n in own) print n "\t" own[n] }
' "$WORK/c7-core-names.txt" "$WORK/c7-decl-layers.txt" | sort > "$WORK/c7-owners.txt"
cut -f1 "$WORK/c7-owners.txt" > "$WORK/c7-forbidden.txt"

# Core-layer files, stripped once into a mirror tree.
CORE_STRIPPED="$WORK/core-stripped"
mkdir -p "$CORE_STRIPPED"
find "$SRC" -name '*.swift' | sort | awk -v src="$SRC/" '
  NR == FNR {
    if ($0 ~ /^[[:space:]]*(#|$)/) next
    n = split($0, col, " "); if (n < 2) next
    np++; pre[np] = col[1]; lay[np] = col[2]; next
  }
  {
    rel = substr($0, length(src) + 1); l = "Unclassified"
    for (i = 1; i <= np; i++) if (index(rel, pre[i]) == 1) { l = lay[i]; break }
    if (l == "Core") printf "%s%c", $0, 0
  }
' "$MAP" - | strip_tree_into "$SRC" "$CORE_STRIPPED"
core_file_count="$(find "$CORE_STRIPPED" -name '*.swift' | wc -l | tr -d ' ')"

# Vacuous-pass guard, as for check 6: an empty or tiny forbidden list, or no
# Core files, means a parser broke — not that Core is clean.
forbidden_count="$(wc -l < "$WORK/c7-forbidden.txt" | tr -d ' ')"
c7_ok=1
if [ "$forbidden_count" -lt 300 ]; then
  echo "  ERROR check 7 parser: only $forbidden_count Shell/feature top-level type names collected (expected hundreds)" >&2
  status=1; c7_ok=0
fi
if [ "$core_file_count" -eq 0 ]; then
  echo "  ERROR check 7 parser: zero Core-layer files scanned (feature-map.txt has no Core prefix matching Sources/LlmIdeMac?)" >&2
  status=1; c7_ok=0
fi

# rel<TAB>symbol for every forbidden name each Core file names.
: > "$WORK/c7-hits.txt"
if [ "$c7_ok" -eq 1 ]; then
  grep -rowFf "$WORK/c7-forbidden.txt" "$CORE_STRIPPED" --include='*.swift' \
    | awk -v root="$CORE_STRIPPED/" '{
        i = index($0, ".swift:"); f = substr($0, 1, i + 5); sym = substr($0, i + 7)
        print substr(f, length(root) + 1) "\t" sym
      }' | sort -u > "$WORK/c7-hits.txt"
fi

printf '%s\n' "$CORE_LEAF_ALLOWLIST" | awk -F'\t' 'NF >= 2 && $1 !~ /^#/ {print $1 "\t" $2}' \
  > "$WORK/c7-allow.txt"
: > "$WORK/c7-stale.txt"
while IFS="$(printf '\t')" read -r apath asym; do
  if [ ! -f "$SRC/$apath" ]; then
    echo "$apath  [$asym]  — file no longer exists" >> "$WORK/c7-stale.txt"
  elif ! grep -qxF "$apath	$asym" "$WORK/c7-hits.txt"; then
    echo "$apath  [$asym]  — file no longer names this as a Shell/feature type" >> "$WORK/c7-stale.txt"
  fi
done < "$WORK/c7-allow.txt"

if [ -s "$WORK/c7-allow.txt" ]; then
  grep -vxFf "$WORK/c7-allow.txt" "$WORK/c7-hits.txt" > "$WORK/c7-violations.txt"
else
  cp "$WORK/c7-hits.txt" "$WORK/c7-violations.txt"
fi
if [ -s "$WORK/c7-violations.txt" ]; then
  # Group per (owner layer, file), like the warn lines of check 2.
  awk -F'\t' '
    NR == FNR { own[$1] = $2; next }
    { key = own[$2] "|" $1; syms[key] = (key in syms) ? syms[key] "," $2 : $2 }
    END { for (k in syms) print k "|" syms[k] }
  ' "$WORK/c7-owners.txt" "$WORK/c7-violations.txt" | sort \
    | while IFS='|' read -r owner rel syms; do
        short="$(printf '%s' "$owner" | sed 's/Feature://g')"
        echo "  ERROR  [$short] $rel  ->  $owner  [$syms]"
      done
  echo "FAIL: a Core-layer file names a type declared under Shell/ or Features/ — move the type to Core, or put a protocol in Core/Contracts/" >&2
  status=1
fi
if [ -s "$WORK/c7-stale.txt" ]; then
  while read -r line; do
    echo "  ERROR  stale allowlist row: $line"
  done < "$WORK/c7-stale.txt"
  echo "FAIL: a CORE_LEAF_ALLOWLIST row no longer matches a real reference — delete it" >&2
  status=1
fi
if [ ! -s "$WORK/c7-violations.txt" ] && [ ! -s "$WORK/c7-stale.txt" ]; then
  echo "  none"
fi

exit $status
