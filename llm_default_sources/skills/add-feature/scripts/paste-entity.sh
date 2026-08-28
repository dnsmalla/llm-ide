#!/usr/bin/env bash
# Copy the add-feature templates into a project, renaming the example entity.
#
# The templates are the payload; this script exists so an agent never has to
# READ them. Reading 341 lines of example code into context to retype it as
# 341 similar lines costs tokens twice and produces different output each run.
# Copying costs none and is byte-identical.
#
# Usage: paste-entity.sh <entity-singular> <entity-plural> [project-root]
#   e.g. paste-entity.sh comment comments .
#
# Substitutions applied to paths AND contents:
#   posts -> <plural>    Posts -> <Plural>    post -> <singular>    Post -> <Singular>
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
# Full files only; snippets/ are merged by hand into existing files.
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
  sed -e "s/posts/$PLURAL/g" -e "s/Posts/$PLURAL_CAP/g" \
      -e "s/post/$SINGULAR/g" -e "s/Post/$SINGULAR_CAP/g" "$src" > "$dest"
  echo "  wrote $dest_rel"; written=$((written+1))
done < <(find "$TPL" -type f | sort)

echo
echo "$written written, $skipped skipped."
echo "Still manual (they merge into existing files — see SKILL.md):"
echo "  - templates/snippets/system.yaml.entity           -> .auto_system/system.yaml"
echo "  - templates/snippets/routes-index.registration.ts -> src/routes/index.ts"
