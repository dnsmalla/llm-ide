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

# 3a. `strip_feature_guard_for_flag` only understands `#if`/`#else`/`#endif`.
#     An `#elseif` branch inherits its enclosing `#if` frame's hidden/visible
#     state as written today, which is backwards for the branch that runs
#     when the target flag is FALSE — a genuine false negative, not a
#     hypothetical one (reviewer-reproduced: `#if FEATURE_TERMINAL / x /
#     #elseif DEBUG / <ref> / #endif` silently passed). Full `#elseif`
#     support is deliberately out of scope; refuse it outright instead of
#     guessing, so the first `#elseif` under Shell/Core forces a person to
#     either restructure it (nested #if/#else) or extend the parser on
#     purpose.
: > "$WORK/elseif-hits.txt"
find "$SRC" -name '*.swift' | sort | while read -r f; do
  rel="${f#"$SRC"/}"
  consumer="$(layer_of "$rel")"
  [[ "$consumer" == "Shell" || "$consumer" == "Core" ]] || continue
  grep -n '^[[:space:]]*#elseif\b' "$f" | while IFS=: read -r lineno _; do
    echo "$rel:$lineno" >> "$WORK/elseif-hits.txt"
  done
done

echo "=== #elseif under Shell/Core (unsupported by the guard parser) ==="
if [ -s "$WORK/elseif-hits.txt" ]; then
  sort "$WORK/elseif-hits.txt" | while read -r loc; do
    echo "  ERROR  $loc  — strip_feature_guard_for_flag has no #elseif support; restructure as nested #if/#else or extend the parser deliberately"
  done
  echo "FAIL: #elseif found under Shell/Core; the build-exclusion guard parser cannot reason about it safely" >&2
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

: > "$WORK/shell-violations.txt"
if [ -s "$WORK/exc-layers.txt" ]; then
  find "$SRC" -name '*.swift' | sort | while read -r f; do
    rel="${f#"$SRC"/}"
    consumer="$(layer_of "$rel")"
    [[ "$consumer" == "Shell" || "$consumer" == "Core" ]] || continue
    raw_body="$(strip "$f")"
    while read -r owner; do
      [[ -z "$owner" ]] && continue
      syms="$(awk -v o="$owner" '$2==o{print $1}' "$WORK/owned.txt" | paste -sd'|' -)"
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

# 5. Non-Swift files naming a stale mac/Sources/LlmIdeMac path. Swift is one
#    module, so moving a file inside it never breaks a Swift build — every
#    check above only ever catches that class. It silently breaks anything
#    OUTSIDE Swift that names a path by hand: a script, a Makefile target, a
#    CI step. This is exactly how conformance-agent-v2.mjs kept hardcoding
#    Views/DocGen/DocGenView.swift and Views/Visual/VisualView.swift after
#    the Features/ migration moved both, undetected through three reviews
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

exit $status
