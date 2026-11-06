# Own-server sync: one-time setup (SFTP + HTTPS)

The desktop writes encrypted sync files to this VPS over SFTP. Phones and browsers read and write only their own
folder over `https://llm-ide.com/sync/`. The server only ever holds ciphertext. Design:
`docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` §8.1, ADR 0020.

## 1. Account and folders (as root)

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin llmidesync
install -d -m 755 -o root -g root /srv/llmide-sync                    # chroot: root-owned, not writable
install -d -m 2770 -o llmidesync -g llmidesync /srv/llmide-sync/data
install -d -m 2770 -o www-data -g llmidesync /srv/llmide-sync-tmp      # nginx PUT temp: same filesystem, group llmidesync
usermod -aG llmidesync www-data                                       # nginx reads data/ and writes inboxes
install -d -m 755 /etc/ssh/authorized_keys
```

`/srv/llmide-sync-tmp` must be on the same filesystem as `/srv/llmide-sync/data`. nginx renames each uploaded request
from there into place, so a reader never sees half a file. The setgid group makes those files readable by the sync user.

## 2. sshd

```bash
cp deploy/vps/50-llmidesync.conf /etc/ssh/sshd_config.d/50-llmidesync.conf
sshd -t && systemctl reload ssh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub     # paste this line into Settings → Phone and web sync → Own server
```

Read the fingerprint over a session you already trust (your own SSH login, the provider's console). The desktop
connects only to a server with exactly this key. If the server is reinstalled, its key changes and the desktop stops
with "The server's identity changed". Then read the new fingerprint the same way and Save again.

## 3. The desktop's key

In Settings → Phone and web sync → Own server, press Save. The card shows the desktop's public key and a command:

```bash
printf 'restrict %s\n' 'ssh-ed25519 AAAA… llmide-sync-…' > /etc/ssh/authorized_keys/llmidesync
chmod 644 /etc/ssh/authorized_keys/llmidesync        # root-owned: the sync user cannot change its own keys
```

Then press Test connection in Settings.

## 4. nginx

The `/sync/` locations, the rate zone and the CORS map are in [llm-ide.com.nginx](llm-ide.com.nginx). Install it as
usual, then:

```bash
nginx -V 2>&1 | grep -o http_dav_module     # must print http_dav_module (Ubuntu's nginx package has it)
nginx -t && systemctl restart nginx         # restart, not reload: the workers must pick up www-data's new group
```

To test the web app's dev server (`http://127.0.0.1:5180`) against this VPS, uncomment its line in the
`$llmidesync_origin` map. Comment it out again afterwards.

## 5. Verify

```bash
deploy/vps/check-sync.sh server                                   # on the VPS, as root
deploy/vps/check-sync.sh remote llm-ide.com 72.62.76.92           # from your computer
```

Both must end without a `FAIL` line.

## Known limits (stated plainly)

- **The folder name is a bearer secret in a URL.** Access logs for `/sync/` are off and the error log is at `crit`, but
  a crashing request can still log a path. Revoke a device by removing it in Settings (its folder is deleted).
- **No per-device token.** A token would travel in the same QR and live next to the folder name on the device, so it
  would add no secret. Everything behind the folder is end-to-end sealed and signed.
- **Overwrite.** A folder holder can PUT over its own earlier request name. Every request is signed by the device key,
  so this changes nothing the device could not send anyway.
- **Space.** A folder holder can upload 64 KiB files at 2 per second. The desktop deletes every inbox file it cannot
  verify on each 30 s drain, so a flood stays around 60 files. No fixed per-device cap is enforced. A full disk would
  also hit the other sites on this VPS.
- **Same host as the PWA.** The web app is only as trustworthy as the server that serves it (relay design §7.2).
- **Switching storage** (MEGA ↔ own server) in Settings unlinks every device. The old storage's files stay. Delete
  them by hand (`rm -rf /srv/llmide-sync/data/*` here, or the MEGA folder).
