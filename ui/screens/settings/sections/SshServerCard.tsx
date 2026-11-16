// Settings → Server & Backend → SSH server. The core runs on a Linux server and the desktop reaches it through an ssh
// port forward. A thin shell over SshServerModel: the model owns every host answer; this card owns only what must not
// live in the model (the typed password, kept in memory while mounted) and which confirmation is open.
// Awaits: the card sets no state after an await. Model state is unsubscribed on unmount, so a late answer lands nowhere.
import { useEffect, useState, type ReactNode } from "react";
import { useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import { NeedsHost } from "../ui.tsx";
import { SshServerModel, UNAVAILABLE_SSH_IO } from "../ssh-server-model.ts";
import { SshServerView, type SshDialog } from "./SshServerView.tsx";

export default function SshServerCard(): ReactNode {
  const { host } = useEnv();
  const available = Boolean(host.sshServer);
  // The model exists on every render (hooks cannot be conditional); without a host it is never asked anything.
  const m = useModel(() => new SshServerModel(host.sshServer ?? UNAVAILABLE_SSH_IO));
  const s = useStore(m);
  const [password, setPassword] = useState("");
  const [dialog, setDialog] = useState<SshDialog | null>(null);

  // Load once per mount: the saved target and the live link. A focus refresh reads only the link, so it never
  // overwrites fields the user is still editing.
  useEffect(() => {
    if (available) void m.load();
  }, [available, m]);
  useRefreshOnFocus(() => {
    if (available) void m.refreshStatus();
  });
  // A password is for one server: a new host, port or user means the typed one is forgotten, and an open
  // confirmation for the old host closes (the view also ignores it by host, so it never shows for another server).
  useEffect(() => {
    setPassword("");
    setDialog(null);
  }, [s.host, s.port, s.user]);

  if (!available) return <NeedsHost what="The SSH server" />;
  return (
    <SshServerView
      m={m}
      s={s}
      password={password}
      onPassword={setPassword}
      dialog={dialog}
      onDialog={(kind) => setDialog(kind === null ? null : { kind, host: s.host.trim() })}
      onSwitch={async () => {
        // Only the confirmed Switch calls this: the host saves the SSH mode, then the app restarts onto the server.
        if (!host.switchSshServer) throw new Error("Switching to the server needs the desktop host, which is not connected in this build.");
        await host.switchSshServer();
      }}
    />
  );
}
