#!/bin/sh
# One-command LLM-IDE hub installer for Ubuntu/Debian.
#
#   sudo sh deploy/hub/install-hub.sh --domain hub.example.com
#
# It uses the same fixed helper, staged Linux core bundle, systemd unit and nginx vhost as the
# desktop's deploy flow. The domain is the only required argument. The model key (Anthropic API key)
# is read from ANTHROPIC_API_KEY or prompted with hidden input: never from argv, never echoed.
#
# Options:
#   --domain <name>   Public DNS name for the hub (required)
#   --email <addr>    Let's Encrypt account email (optional)
#   --bundle <path>   llmide-core-<version>-linux-x64.tar.gz (default: auto-detect)
#   --version <x.y.z> Bundle version (default: parsed from the bundle name or VERSION file)
#   --skip-apt        Do not install nginx/certbot/openssl (already present)
#   --dry-run         Validate and print the plan; change nothing
#   --help            This text
#
# Secrets: the JWT secret and vault key are generated with openssl; the model key is read from the
# environment or a hidden prompt. Both live only in a root-only temp file piped to the helper's env
# stage (0600 root:root on the server). This script never prints them and never puts them in argv.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HELPER="$SCRIPT_DIR/llmide-deploy"
VHOST="$SCRIPT_DIR/llm-ide-hub.nginx.template"
SETUP="$SCRIPT_DIR/setup.html"

DOMAIN=""
EMAIL=""
BUNDLE=""
VERSION=""
SKIP_APT=0
DRY_RUN=0

say() { printf '%s\n' "$*" >&2; }
die() { printf 'install-hub: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
One-command LLM-IDE hub installer for Ubuntu/Debian.

  sudo sh deploy/hub/install-hub.sh --domain hub.example.com

Options:
  --domain <name>   Public DNS name for the hub (required)
  --email <addr>    Let's Encrypt account email (optional)
  --bundle <path>   llmide-core-<version>-linux-x64.tar.gz (default: auto-detect)
  --version <x.y.z> Bundle version (default: parsed from the bundle name or VERSION file)
  --skip-apt        Do not install nginx/certbot/openssl (already present)
  --dry-run         Validate and print the plan; change nothing
  --help            This text

The model key is read from ANTHROPIC_API_KEY or a hidden prompt, never from argv and never echoed.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) [ "$#" -ge 2 ] || die "--domain needs a value"; DOMAIN=$2; shift 2 ;;
    --email) [ "$#" -ge 2 ] || die "--email needs a value"; EMAIL=$2; shift 2 ;;
    --bundle) [ "$#" -ge 2 ] || die "--bundle needs a value"; BUNDLE=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || die "--version needs a value"; VERSION=$2; shift 2 ;;
    --skip-apt) SKIP_APT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    # A model key is intentionally NOT an option: argv is visible in `ps` and shell history.
    --api-key|--model-key|--anthropic-api-key) die "pass the model key in ANTHROPIC_API_KEY or the hidden prompt, never on the command line" ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ -n "$DOMAIN" ] || die "--domain is required (a public DNS name, for example hub.example.com)"
DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
case "$DOMAIN" in
  ''|-*|*.|*[!a-z0-9.-]*) die "the domain is not a valid DNS name" ;;
esac
case "$DOMAIN" in
  *.*.*) ;;
  *.*) ;;
  *) die "the domain must contain a dot (a public DNS name)" ;;
esac
case "$DOMAIN" in
  localhost|*.local|*.internal|*.lan|*.home|*.test|*.invalid|*.onion|*.alt)
    die "the domain must be a public DNS name, not a local-only name" ;;
esac
case "$DOMAIN" in
  *[0-9].[0-9]*) die "enter a DNS name, not an IP address" ;;
esac

# Auto-detect a staged bundle next to this script or in the desktop's dist folder.
if [ -z "$BUNDLE" ]; then
  for f in "$SCRIPT_DIR"/llmide-core-*-linux-x64.tar.gz "$SCRIPT_DIR"/../../desktop/dist/hub/llmide-core-*-linux-x64.tar.gz; do
    [ -f "$f" ] && BUNDLE=$f
  done
fi
[ -n "$BUNDLE" ] || die "no hub bundle found. Build one with: node desktop/scripts/stage-hub-core.mjs, or pass --bundle <path>"
[ -f "$BUNDLE" ] || die "the bundle does not exist: $BUNDLE"

if [ -z "$VERSION" ]; then
  VERSION=$(basename "$BUNDLE" | sed -n 's/^llmide-core-\([0-9][0-9.]*\)-linux-x64\.tar\.gz$/\1/p')
fi
if [ -z "$VERSION" ] && [ -f "$(dirname "$BUNDLE")/VERSION" ]; then
  VERSION=$(tr -cd '0-9.' < "$(dirname "$BUNDLE")/VERSION" | head -c 40)
fi
case "$VERSION" in
  *.*.*) ;;
  *) die "cannot determine the bundle version; pass --version x.y.z" ;;
esac

for f in "$HELPER" "$VHOST" "$SETUP"; do
  [ -f "$f" ] || die "missing installer asset: $f (run this script from the repo's deploy/hub folder)"
done

# Root check after --help/--dry-run so the plan can be inspected without root.
if [ "$DRY_RUN" -ne 1 ] && [ "$(id -u)" -ne 0 ]; then
  die "run as root: sudo sh $0 --domain $DOMAIN"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<PLAN
LLM-IDE hub install plan (dry run)
  domain:  https://$DOMAIN
  version: $VERSION
  bundle:  $BUNDLE
  helper:  $HELPER
  stages:  base -> env -> check-cert -> bundle -> nginx -> start -> open-registration
  apt:     $([ "$SKIP_APT" -eq 1 ] && printf 'skipped' || printf 'install nginx/certbot/openssl/coreutils')
  secret:  model key from ANTHROPIC_API_KEY or a hidden prompt (never argv)
  next:    open the printed setup URL, create the owner, run: llmide-deploy lock-registration
PLAN
  exit 0
fi

# ---- model key: environment or hidden prompt, never argv -------------------
MODEL_KEY=${ANTHROPIC_API_KEY:-}
if [ -z "$MODEL_KEY" ]; then
  [ -t 0 ] || die "set ANTHROPIC_API_KEY in the environment (stdin is not a terminal for a hidden prompt)"
  printf 'Anthropic API key (input hidden): ' >&2
  saved=$(stty -g)
  stty -echo
  IFS= read -r MODEL_KEY || true
  stty "$saved"
  printf '\n' >&2
fi
case "$MODEL_KEY" in
  ''|*[![:graph:]]*) die "the model key is empty or contains whitespace" ;;
esac
[ "${#MODEL_KEY}" -ge 20 ] || die "the model key looks too short"

say "install-hub: preparing $DOMAIN (version $VERSION)"

# ---- packages --------------------------------------------------------------
if [ "$SKIP_APT" -ne 1 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends nginx certbot openssl ca-certificates curl coreutils tar gzip >/dev/null
fi
command -v nginx >/dev/null 2>&1 || die "nginx is not installed (use --skip-apt only when it is)"
command -v certbot >/dev/null 2>&1 || die "certbot is not installed (use --skip-apt only when it is)"

# ---- helper + service user/dirs (the existing fixed helper) ----------------
install -m 0755 -o root -g root "$HELPER" /usr/local/sbin/llmide-deploy
"$HELPER" base
systemctl enable --now nginx >/dev/null 2>&1 || systemctl start nginx >/dev/null 2>&1 || true

# ---- TLS certificate (webroot) ---------------------------------------------
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  say "install-hub: using the existing certificate for $DOMAIN"
else
  say "install-hub: requesting a certificate for $DOMAIN"
  # A temporary vhost makes the ACME challenge land in the same webroot certbot writes. The real
  # hub vhost is installed later by the helper, so this file is removed immediately afterwards.
  ACME_SITE=/etc/nginx/sites-available/llmide-acme
  cat > "$ACME_SITE" <<ACME_VHOST
server {
    listen 80;
    server_name $DOMAIN;
    root /var/www/llmide-web;
    location /.well-known/acme-challenge/ { try_files \$uri =404; }
}
ACME_VHOST
  ln -sfn "$ACME_SITE" /etc/nginx/sites-enabled/llmide-acme
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  if [ -n "$EMAIL" ]; then
    certbot certonly --webroot -w /var/www/llmide-web -d "$DOMAIN" --key-type ecdsa --reuse-key \
      --non-interactive --agree-tos --email "$EMAIL" >/dev/null || { rm -f /etc/nginx/sites-enabled/llmide-acme "$ACME_SITE"; die "certbot failed for $DOMAIN"; }
  else
    certbot certonly --webroot -w /var/www/llmide-web -d "$DOMAIN" --key-type ecdsa --reuse-key \
      --non-interactive --agree-tos --register-unsafely-without-email >/dev/null || { rm -f /etc/nginx/sites-enabled/llmide-acme "$ACME_SITE"; die "certbot failed for $DOMAIN"; }
  fi
  rm -f /etc/nginx/sites-enabled/llmide-acme "$ACME_SITE"
  systemctl reload nginx >/dev/null 2>&1 || true
fi
[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || die "no certificate at /etc/letsencrypt/live/$DOMAIN/fullchain.pem"

# ---- env file: secrets stay in a root-only temp file and stdin -------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
JWT=$(openssl rand -hex 32)
VAULT=$(openssl rand -hex 32)
ENV_FILE="$TMP/core.env"
{
  printf 'NODE_ENV=production\n'
  printf 'PATH=/usr/local/bin:/usr/bin:/bin\n'
  printf 'LLMIDE_HOST=127.0.0.1\n'
  printf 'LLMIDE_PORT=3457\n'
  printf 'LLMIDE_HUB=1\n'
  printf 'LLMIDE_TLS_TERMINATED=1\n'
  printf 'LLMIDE_HUB_DOMAIN=%s\n' "$DOMAIN"
  printf 'LLMIDE_HUB_VERSION=%s\n' "$VERSION"
  printf 'LLMIDE_DATA_DIR=/var/lib/llmide\n'
  printf 'LLMIDE_DB_PATH=/var/lib/llmide/data.db\n'
  printf 'LLMIDE_PROJECTS_ROOT=/srv/llmide/projects\n'
  printf 'LLMIDE_BACKUP_DIR=/var/lib/llmide/backups\n'
  printf 'LLMIDE_BACKUP_KEEP=7\n'
  printf 'LLMIDE_DISABLE_REGISTRATION=1\n'
  printf 'LLMIDE_TRUST_PROXY=1\n'
  printf 'LLMIDE_LOG_JSON=1\n'
  printf 'LLMIDE_LOG_LEVEL=info\n'
  printf 'LLMIDE_LOG_ROTATE=external\n'
  printf 'LLMIDE_MAX_TURNS=8\n'
  printf 'LLMIDE_HOST_API_HUB=1\n'
  printf 'LLMIDE_HOST_API_WEB_ORIGINS=https://%s\n' "$DOMAIN"
  printf 'LLMIDE_HOST_API_FINGERPRINT_FILE=/etc/llmide/host-api-fingerprint\n'
  printf 'LLMIDE_HUB_PUBLIC_URL=wss://%s/host-api/v1\n' "$DOMAIN"
  printf 'LLMIDE_JWT_SECRET=%s\n' "$JWT"
  printf 'LLMIDE_VAULT_KEY=%s\n' "$VAULT"
  printf 'ANTHROPIC_API_KEY=%s\n' "$MODEL_KEY"
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
say "install-hub: writing the secret env file (values hidden)"
"$HELPER" env < "$ENV_FILE"

# ---- stage the release, vhost and setup page -------------------------------
upload() {
  name=$1
  file=$2
  { printf '%s\n' "$name"; cat "$file"; } | "$HELPER" upload >/dev/null
}
SHA=$(sha256sum "$BUNDLE" | awk '{print $1}')
printf '%s  bundle.tar.gz\n' "$SHA" > "$TMP/bundle.sha256"
printf '%s\n' "$VERSION" > "$TMP/VERSION"
upload bundle.tar.gz "$BUNDLE"
upload bundle.sha256 "$TMP/bundle.sha256"
upload VERSION "$TMP/VERSION"
upload llm-ide-hub.nginx "$VHOST"
upload setup.html "$SETUP"

say "install-hub: checking the certificate and switching the release"
"$HELPER" check-cert
"$HELPER" bundle
"$HELPER" nginx
"$HELPER" start

# ---- health gate -----------------------------------------------------------
healthy=0
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then healthy=1; break; fi
  i=$((i + 1))
  sleep 2
done
[ "$healthy" -eq 1 ] || die "the hub did not become healthy at https://$DOMAIN/health; check: journalctl -u llmide-core -n 50"

# ---- one-time owner window + next steps ------------------------------------
SETUP_OUT=$("$HELPER" open-registration 2>/dev/null || true)
SETUP_URL=$(printf '%s\n' "$SETUP_OUT" | sed -n 's/^LLMIDE_SETUP_URL=//p' | head -1)

cat >&2 <<NEXT

LLM-IDE hub installed at https://$DOMAIN
Next steps:
  1. Open the one-time owner setup${SETUP_URL:+: $SETUP_URL}
     Create the owner account (the first account). The token is in the URL fragment, never in a log.
  2. Close registration:
       sudo /usr/local/sbin/llmide-deploy lock-registration
  3. Open LLM-IDE on the desktop -> Settings -> Server & Backend -> Remote server.
     Enter https://$DOMAIN and the owner email/password, then press Connect.
  4. Web: open https://$DOMAIN/app/ and pair with the hub. iPhone: scan the hub pairing QR.
Model key: stored in /etc/llmide/core.env (0600 root:root); it is never printed by this installer.
NEXT
