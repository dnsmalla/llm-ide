// Welcome → Connect to SSH server, as one unit: the card, the recent servers and the dialog share one SSH model, so a
// connect from the list and the dialog agree on the server and its progress. The Welcome page places the pieces; this
// file only connects them. The host answers come through `ssh.io`, never from this file.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useModel, useStore } from "../settings/context.tsx";
import { SshServerModel, UNAVAILABLE_SSH_IO, sshServerErrorText, type SshRecentServer, type SshServerIo } from "../settings/ssh-server-model.ts";
import { SshConnectCard } from "./SshConnectCard.tsx";
import { SshConnectDialog } from "./SshConnectDialog.tsx";
import { RecentSshServers } from "./RecentSshServers.tsx";
import { connectRecentServer, loadRecent, recentKey, recentRowMessage, switchDecision } from "./ssh-recent.ts";

/** What the Welcome page needs from the desktop host to connect to an SSH server. */
export interface WelcomeSsh {
  io: SshServerIo;
  /** Saves the SSH mode and restarts the app. Called only when the user confirms the switch. */
  switchToServer: () => Promise<void>;
  /** True while Loop work is running on this computer: the restart then asks first. Absent means unknown, so it asks. */
  hasLiveWork?: () => boolean;
}

const NO_HOST_SWITCH = async (): Promise<void> => {
  throw new Error("Switching to the server needs the desktop host, which is not connected in this build.");
};

export function SshWelcome({ ssh }: { ssh?: WelcomeSsh }): ReactNode {
  const io = ssh?.io ?? UNAVAILABLE_SSH_IO;
  const switchToServer = ssh?.switchToServer ?? NO_HOST_SWITCH;
  const m = useModel(() => new SshServerModel(io));
  const s = useStore(m);
  const [recent, setRecent] = useState<SshRecentServer[]>([]);
  // The row whose action is running or whose result shows; null when none does.
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ passwordOnly: boolean; askSwitch?: boolean } | null>(null);
  const hasLiveWork = ssh?.hasLiveWork ?? (() => true);

  // Reloaded after every connect, forget and edit, so the list shows what the host now remembers.
  const reloadRecent = useCallback(() => {
    void loadRecent(io).then(setRecent);
  }, [io]);
  useEffect(() => {
    reloadRecent();
  }, [reloadRecent]);

  const busy = s.busy !== null;

  const openNew = () => {
    if (m.getState().busy) return;
    // A new server starts empty; the saved one (if any) fills in, as in Settings.
    m.reset();
    void m.load();
    setNotice(null);
    setDialog({ passwordOnly: false });
  };

  const connectRow = async (entry: SshRecentServer) => {
    if (m.getState().busy) return;
    setActive(recentKey(entry));
    setNotice(null);
    const outcome = await connectRecentServer(m, entry);
    if (outcome === "connected") {
      // A warning stays on the row (see recentRowMessage); only a clean connect clears it.
      if (!m.getState().status?.warning) setActive(null);
      setNotice(`Connected to ${entry.host}.`);
    } else if (outcome === "switch") {
      // The restart is the only thing left. It asks (in the dialog) only when work is running on this computer.
      if (switchDecision(hasLiveWork()) === "ask") {
        setDialog({ passwordOnly: false, askSwitch: true });
      } else {
        try {
          await switchToServer();
        } catch (e) {
          setActive(null);
          setNotice(sshServerErrorText(e));
        }
      }
    } else if (outcome === "dialog") {
      setDialog({ passwordOnly: entry.auth === "password" });
    }
    // "failed": the row shows the reason from the model.
    reloadRecent();
  };

  const editRow = (entry: SshRecentServer) => {
    if (m.getState().busy) return;
    m.loadFrom(entry);
    setActive(null);
    setNotice(null);
    setDialog({ passwordOnly: false });
    reloadRecent();
  };

  const forgetRow = async (entry: SshRecentServer) => {
    await io.forget(entry);
    reloadRecent();
  };

  const message = dialog === null && active !== null ? recentRowMessage(s, active, active) : null;

  // The dialog is a sibling of the card, not a child: the card's hover transform would otherwise pin the modal to it.
  return (
    <>
      <SshConnectCard onConnect={openNew} notice={notice}>
        <RecentSshServers
          servers={recent}
          busy={busy}
          message={message}
          onConnect={(entry) => void connectRow(entry)}
          onEdit={editRow}
          onForget={forgetRow}
        />
      </SshConnectCard>
      {dialog !== null ? (
        <SshConnectDialog
          m={m}
          s={s}
          passwordOnly={dialog.passwordOnly}
          onClose={() => setDialog(null)}
          onConnected={() => {
            setDialog(null);
            setNotice(`Connected to ${m.target().host}.`);
            reloadRecent();
          }}
          onSwitch={switchToServer}
          hasLiveWork={hasLiveWork}
          askSwitch={dialog.askSwitch === true}
        />
      ) : null}
    </>
  );
}
