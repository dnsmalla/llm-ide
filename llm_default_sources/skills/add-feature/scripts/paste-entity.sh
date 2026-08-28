#!/usr/bin/env bash
# Copy the ONE template the generator chain cannot produce — the web screen —
# renaming the example entity.
#
# Everything else a feature needs is generated (see SKILL.md): the backend
# layers, the OpenAPI paths, the client registry and models, and the route
# registration are all emitted from `database.entities`. This script exists
# only so an agent never has to READ the screen template to retype it.
#
# Usage: paste-entity.sh <entity-singular> <entity-plural> [project-root]
#   e.g. paste-entity.sh comment comments .
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $(basename "$0") <entity-singular> <entity-plural> [project-root]" >&2
  exit 2
fi

SINGULAR="$1"; PLURAL="$2"; ROOT="${3:-.}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TPL="$SKILL_DIR/templates"

[[ -d "$TPL" ]] || { echo "templates not found at $TPL" >&2; exit 1; }
[[ -d "$ROOT" ]] || { echo "project root not found: $ROOT" >&2; exit 1; }

cap() { printf '%s%s' "$(printf '%s' "${1:0:1}" | tr '[:lower:]' '[:upper:]')" "${1:1}"; }
SINGULAR_CAP="$(cap "$SINGULAR")"; PLURAL_CAP="$(cap "$PLURAL")"

written=0 skipped=0
while IFS= read -r src; do
  rel="${src#"$TPL"/}"
  case "$rel" in snippets/*) continue ;; esac
  dest_rel="${rel//posts/$PLURAL}"
  dest_rel="${dest_rel//post/$SINGULAR}"
  dest="$ROOT/$dest_rel"
  if [[ -e "$dest" ]]; then
    echo "  skip (exists) $dest_rel"; skipped=$((skipped+1)); continue
  fi
  mkdir -p "$(dirname "$dest")"
  # perl, not sed: BSD sed (macOS) silently ignores \b in -E mode, so every
  # rule matched nothing. Lookahead handles camelCase compounds (postsApi,
  # PostsPage, PostResponse) while \b protects words that merely CONTAIN the
  # entity name — postgres, posted, compose.
  perl -pe "
    s/\\bposts(?=[A-Z])/$PLURAL/g;
    s/\\bPosts(?=[A-Z])/$PLURAL_CAP/g;
    s/\\bPost(?=[A-Z])/$SINGULAR_CAP/g;
    s/\\bposts\\b/$PLURAL/g;
    s/\\bPosts\\b/$PLURAL_CAP/g;
    s/\\bpost\\b/$SINGULAR/g;
    s/\\bPost\\b/$SINGULAR_CAP/g;
  " "$src" > "$dest"
  echo "  wrote $dest_rel"; written=$((written+1))
done < <(find "$TPL" -type f | sort)

echo
echo "$written written, $skipped skipped."
echo "Merge by hand (it is the generator's INPUT, not its output):"
echo "  - templates/snippets/system.yaml.entity -> .auto_system/system.yaml"
