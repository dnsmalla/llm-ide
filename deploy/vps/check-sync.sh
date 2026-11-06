#!/usr/bin/env bash
# Read-only checks for the own-server sync setup. Probe PUTs target random, non-existent folders and must be refused.
#   check-sync.sh remote <web-host> <ssh-host> [ssh-port]
#   check-sync.sh server
set -u
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
want() { local allowed=$1 got=$2 what=$3; if [[ " $allowed " == *" $got "* ]]; then ok "$what ($got)"; else bad "$what: got $got, want one of: $allowed"; fi; }

remote() {
  local web=${1:?web host} ssh_host=${2:?ssh host} port=${3:-22}
  local id; id=$(head -c 16 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | cut -c1-22)
  local base="https://$web/sync/$id/d/$id"
  code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
  want "404" "$(code "https://$web/sync/")" "no listing at /sync/"
  want "404" "$(code "$base/")" "no folder listing"
  want "404" "$(code "$base/other.bin")" "GET outside the allow-list"
  want "404" "$(code "$base/manifest.bin")" "GET of an absent allowed file"
  want "403 405" "$(code -X PUT --data-binary x "$base/manifest.bin")" "PUT over a desktop file"
  want "403 405" "$(code -X DELETE "$base/in/0000000000000-$id.bin")" "DELETE"
  want "413" "$(head -c 70000 /dev/zero | code -X PUT --data-binary @- "$base/in/0000000000000-$id.bin")" "PUT over 64 KiB"
  want "409" "$(code -X PUT --data-binary x "$base/in/0000000000000-$id.bin")" "PUT into a folder the desktop did not create"
  if curl -s -o /dev/null -D - -H 'Origin: https://evil.example' "$base/key.bin" | grep -qi '^access-control-allow-origin'; then bad "CORS answered a foreign origin"; else ok "no CORS for a foreign origin"; fi
  local codes=""; for _ in $(seq 1 60); do codes+="$(code "$base/key.bin") "; done
  if [[ "$codes" == *429* ]]; then ok "rate limit answers 429"; else bad "no 429 after 60 quick GETs"; fi
  local out; out=$(ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o ConnectTimeout=10 -p "$port" "llmidesync@$ssh_host" true 2>&1)
  if [[ "$out" == *"Permission denied (publickey)"* ]]; then ok "sshd offers only publickey to llmidesync"; else bad "sshd answer for password login: $out"; fi
}

server() {
  [[ $EUID -eq 0 ]] || { echo "run as root"; exit 2; }
  sshd -t || bad "sshd -t"
  local t; t=$(sshd -T -C user=llmidesync,host=check,addr=127.0.0.1)
  for kv in "chrootdirectory /srv/llmide-sync" "forcecommand internal-sftp -d /data -u 0007" "allowtcpforwarding no" "allowstreamlocalforwarding no" \
            "allowagentforwarding no" "permittunnel no" "x11forwarding no" "permittty no" "permituserrc no" "passwordauthentication no" \
            "kbdinteractiveauthentication no" "authenticationmethods publickey" "authorizedkeysfile /etc/ssh/authorized_keys/%u"; do
    if grep -qx "$kv" <<<"$t"; then ok "sshd: $kv"; else bad "sshd: want '$kv'"; fi
  done
  want "root:root 755" "$(stat -c '%U:%G %a' /srv/llmide-sync)" "chroot owned by root, not writable"
  want "llmidesync:llmidesync 2770" "$(stat -c '%U:%G %a' /srv/llmide-sync/data)" "data folder"
  want "www-data:llmidesync 2770" "$(stat -c '%U:%G %a' /srv/llmide-sync-tmp)" "nginx PUT temp folder"
  want "root:root 644" "$(stat -c '%U:%G %a' /etc/ssh/authorized_keys/llmidesync)" "authorized key file is root-owned"
  [[ "$(stat -c %d /srv/llmide-sync-tmp)" == "$(stat -c %d /srv/llmide-sync/data)" ]] && ok "temp and data on one filesystem" || bad "temp and data on different filesystems"
  id -nG www-data | tr ' ' '\n' | grep -qx llmidesync && ok "www-data in group llmidesync" || bad "www-data not in group llmidesync"
  nginx -t 2>/dev/null && ok "nginx -t" || bad "nginx -t"
  nginx -V 2>&1 | grep -q http_dav_module && ok "nginx has the DAV module" || bad "nginx lacks http_dav_module"
  if grep -qs ' /sync/' /var/log/nginx/access.log; then bad "/sync/ paths in the access log"; else ok "no /sync/ paths in the access log"; fi
}
case "${1:-}" in remote) shift; remote "$@" ;; server) server ;; *) echo "usage: $0 remote <web-host> <ssh-host> [ssh-port] | server"; exit 2 ;; esac
exit $fail
