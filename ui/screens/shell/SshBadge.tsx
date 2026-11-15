// The toolbar's SSH indicator: the server the app is connected to, shown only in ssh mode. The words come from the
// settings model's `sshBadgeText`, so the toolbar and the SSH server card always say the same thing.
import { useEffect, useState } from "react";
import { invokeHost } from "./host";
import { useStoreSelector } from "./hooks";
import { coreStatusStore } from "./runtime";
import { decodeSshServerStatus, sshBadgeText } from "../settings/ssh-server-model.ts";

export function SshBadge() {
  const status = useStoreSelector(coreStatusStore, (s) => s.status);
  const ssh = status?.mode === "ssh";
  const link = ssh ? (status?.link ?? null) : null;
  // The core status does not carry the host name; the host's ssh status does. Read it again whenever the link changes.
  const [host, setHost] = useState("");
  useEffect(() => {
    if (link === null) return undefined;
    let live = true;
    invokeHost<unknown>("remote_ssh_server_status").then((raw) => {
      const answer = decodeSshServerStatus(raw);
      if (live && answer) setHost(answer.host);
    }, () => undefined);
    return () => { live = false; };
  }, [link]);
  const text = sshBadgeText(link, host);
  if (text === null) return null;
  return (
    <span className="sh-ssh-badge" data-level={link === "connected" ? "ok" : "warn"} role="status" title="The app is connected to this SSH server. Settings → Server & Backend shows its details.">
      {text}
    </span>
  );
}
