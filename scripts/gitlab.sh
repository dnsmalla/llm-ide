#!/usr/bin/env bash
# GitLab CLI wrapper — uses the PAT from LLM-IDE Settings (Keychain).
# Agents: run `./scripts/gitlab.sh issue create …` instead of bare `glab`.
# Never prompt the user for a separate `glab auth login`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
READER="$ROOT/scripts/read-gitlab-credential.swift"

if [[ ! -x "$(command -v glab)" ]]; then
  echo "glab is not installed. Install it (brew install glab) or use LLM-IDE Settings → GitLab in the Mac app." >&2
  exit 127
fi

if [[ -f "$READER" ]]; then
  _creds_out="$("$READER" 2>/dev/null || true)"
  if [[ -n "$_creds_out" ]]; then
    export GITLAB_HOST="$(echo "$_creds_out" | sed -n '1p')"
    export GITLAB_TOKEN="$(echo "$_creds_out" | sed -n '2p')"
  fi
fi

exec glab "$@"
