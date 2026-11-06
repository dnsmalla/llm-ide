# Own-server sync: one-time setup (SFTP + HTTPS)

The desktop writes encrypted sync files to this VPS over SFTP. Phones and browsers read and write only their own folder over `https://llm-ide.com/sync/`. The server holds ciphertext only. Design: §8.1, ADR 0020.

## 1. Account and folders (as root)

```bash
useradd --system --home-dir /srv/llmide-sync --shell /usr/sbin/nologin llmidesync
install -d -o root -g root -m 755 /srv/llmide-sync
install -d -o llmidesync -g llmidesync -m 2770 /srv/llmide-sync/data
install -d -o www-data -g llmidesync -m 2770 /srv/llmide-sync-tmp
usermod -aG llmidesync www-data
install -d -o root -g root -m 700 /etc/ssh/authorized_keys
```

The chroot root and key directory are root-owned. `data/` is group-writable by the sync user and nginx.

## 2. sshd

```bash
install -o root -g root -m 644 deploy/vps/50-llmidesync.conf /etc/ssh/sshd_config.d/50-llmidesync.conf
sshd -t && systemctl reload ssh
deploy/vps/check-sync.sh server
```

The account is chrooted, SFTP-only, public-key-only, with no TTY and no forwarding.

## 3. The desktop's key

In Settings → Sync, choose **Own server**, enter the host, port, user, the pinned host fingerprint (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) and the HTTPS web host. The desktop generates one ed25519 key and shows its public line. Put that line in `/etc/ssh/authorized_keys/llmidesync`, root-owned `0644`:

```bash
printf '%s\n' 'ssh-ed25519 AAAA... llmide-sync-...' > /etc/ssh/authorized_keys/llmidesync
chown root:root /etc/ssh/authorized_keys/llmidesync && chmod 644 /etc/ssh/authorized_keys/llmidesync
```

## 4. nginx

Install `deploy/vps/llm-ide.com.nginx` as the vhost, ensure `nginx-extras` or a build with `http_dav_module`, then:

```bash
nginx -t && systemctl reload nginx
```

The `alias` assumes the chroot data folder is `/srv/llmide-sync/data`. `client_body_temp_path` must be on the same filesystem for nginx's atomic PUT.

## 5. Verify

```bash
deploy/vps/check-sync.sh server
deploy/vps/check-sync.sh remote llm-ide.com 72.62.76.92
```

Then, from Settings, press **Test connection** and enable sync. Revoking a device deletes `d/<dir>`; nginx never recreates folders.

## Known limits

- The path is the capability: anyone with a 22-character folder name can read that folder until the disk or logs are inspected. TLS protects it in transit; `no-store` and no access logging reduce exposure at rest in logs.
- `limit_req` is per source address; proxies must set real client addresses.
- The server sees IPs, file sizes and timing. It never sees plaintext, device names or note text.
