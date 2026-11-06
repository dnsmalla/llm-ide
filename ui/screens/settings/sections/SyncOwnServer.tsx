// Settings → Phone and web sync → Own server: SFTP address, port and user; the pasted host-key fingerprint; the HTTPS
// host phones and browsers use. After Save it shows this desktop's public key and the root command that installs it.
// Nothing secret is shown or sent: the private key stays in the core's vault.
import { useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { Button } from "../ui.tsx";
import { authorizedKeysCommand, isSftpStore, type SftpSetup, type SyncStatus } from "../sync-model.ts";

export default function SyncOwnServer({ status, onSave }: { status: SyncStatus | null | undefined; onSave: (cfg: SftpSetup) => void }): ReactNode {
  const { host } = useEnv();
  const cur = status && isSftpStore(status.store) ? status.store : null;
  const [form, setForm] = useState({ host: cur?.host ?? "", port: String(cur?.port ?? 22), username: cur?.username ?? "llmidesync",
    hostFingerprint: cur?.hostFingerprint ?? "", webHost: cur?.webHost ?? "llm-ide.com" });
  const [copied, setCopied] = useState(false);
  const input = (k: keyof typeof form, label: string) => (
    <label className="st-field">{label}
      <input className="st-input" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} aria-label={label} spellCheck={false} autoComplete="off" />
    </label>
  );
  const command = cur ? authorizedKeysCommand(cur.publicKey, cur.username) : null;
  const save = () => onSave({ host: form.host.trim(), port: Number(form.port), username: form.username.trim(), hostFingerprint: form.hostFingerprint.trim(), webHost: form.webHost.trim() });
  return (
    <div className="st-stack">
      <p className="st-hint">Your own server keeps the encrypted files. The desktop writes them over SFTP, and each phone or browser reaches only its own folder over HTTPS. Set the server up once with <code>deploy/vps/sync-sftp.md</code>.</p>
      {input("host", "Server address")}
      {input("port", "SSH port")}
      {input("username", "SFTP user")}
      {input("hostFingerprint", "Server host key fingerprint")}
      <p className="st-hint">On the server, run <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> over a connection you already trust, and paste what it prints. The desktop connects only to a server with exactly this key.</p>
      {input("webHost", "HTTPS host for phones and browsers")}
      <div className="st-row"><Button onClick={save} disabled={!form.host.trim() || !form.hostFingerprint.trim()}>Save</Button></div>
      {cur && command && (
        <div className="st-stack">
          <p className="st-hint">This desktop's SSH public key. The private key stays in this computer's encrypted vault.</p>
          <pre className="st-pre" aria-label="SSH public key">{cur.publicKey}</pre>
          <p className="st-hint">Install it on the server as root (this replaces any earlier key for the sync user), then press Test connection:</p>
          <pre className="st-pre" aria-label="Command that installs the key">{command}</pre>
          <div className="st-row"><Button onClick={() => void host.copyText(command).then(() => setCopied(true), () => setCopied(false))}>{copied ? "Copied" : "Copy command"}</Button></div>
        </div>
      )}
    </div>
  );
}
