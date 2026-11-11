// The account menu at the right of the toolbar (Mac `HeaderAccountMenu`): who is signed in, Settings, Help & Support,
// Permissions, Sign out (confirmed). Only shown while signed in, like the Mac. Name and email are server text: shown as text.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@llmide/ui-kit";
import { MenuButton, type MenuItem } from "./MenuButton";
import { safeText } from "./safe-text";
import type { SessionUser } from "./core";
import { describePlan, singleFlight, type DisconnectOutcome, type DisconnectPlan } from "./disconnect-all";

/** Mac's confirmation wording, adjusted to what the desktop actually clears. */
export const SIGN_OUT_TITLE = "Sign out of LLM-IDE?";
export const SIGN_OUT_BODY = "Signing out ends your session and disconnects chat on this computer, so chat stops using your account here. Project files and chat files are not deleted. Git tokens and provider keys stay saved on the server until you clear them in Settings. The Sign out and forget this device option also deletes everything this app keeps in its own storage on this device: the saved repository list, Auto Tasks, custom Loop templates and queued runs, and layout and display settings.";

export interface AccountActions {
  openSettings: () => void;
  openHelp: () => void;
  openPermissions: () => void;
  signOut: () => Promise<void>;
  /** Sign out AND clear this device's local UI settings (the Mac's broader sign-out). */
  signOutAndForget?: () => Promise<void>;
  /** The Mac's third variant: what is saved right now. Both disconnect callbacks must be set for the variant to show. */
  disconnectPlan?: () => Promise<DisconnectPlan>;
  disconnectAll?: (plan: DisconnectPlan, onStep: (text: string) => void) => Promise<DisconnectOutcome>;
}

/** The menu rows (pure, so the order and wording are tested without a DOM). */
export function accountMenuItems(user: SessionUser, a: Pick<AccountActions, "openSettings" | "openHelp" | "openPermissions"> & { askSignOut: () => void }, mac: boolean): MenuItem[] {
  const mod = mac ? "⌘" : "Ctrl+";
  return [
    { id: "name", kind: "label", label: safeText(user.displayName || user.email, 80) },
    { id: "email", kind: "label", label: safeText(user.email, 120), muted: true },
    { id: "sep1", kind: "separator" },
    { id: "settings", label: "Settings…", hint: `${mod},`, onSelect: a.openSettings },
    { id: "help", label: "Help & Support", hint: `${mod}/`, onSelect: a.openHelp },
    { id: "permissions", label: "Permissions…", onSelect: a.openPermissions },
    { id: "sep2", kind: "separator" },
    { id: "signout", label: "Sign out", onSelect: a.askSignOut },
  ];
}

/** The Mac's message names the third variant (HeaderAccountMenu.swift:67); shown only when it is offered. */
export const DISCONNECT_NOTE = "Your GitHub / GitLab tokens and saved repositories stay saved unless you choose to disconnect all accounts.";

export function SignOutDialog({ onCancel, onConfirm, onForget, onDisconnect, busy, title = SIGN_OUT_TITLE, body = SIGN_OUT_BODY, confirmLabel = "Sign out" }: { onCancel: () => void; onConfirm: () => void; onForget?: () => void; onDisconnect?: () => void; busy?: boolean; title?: string; body?: string; confirmLabel?: string }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="sh-modal" role="alertdialog" aria-modal="true" aria-labelledby="sh-signout-title" aria-describedby="sh-signout-body" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="sh-modal-card">
        <h2 id="sh-signout-title" className="sh-panel-title">{title}</h2>
        <p id="sh-signout-body" className="sh-panel-text sh-muted">{body}</p>
        {onDisconnect ? <p className="sh-panel-text sh-muted">{DISCONNECT_NOTE}</p> : null}
        <div className="sh-form-actions">
          <button ref={cancel} type="button" className="sh-button" onClick={onCancel}>Cancel</button>
          {onForget ? <button type="button" className="sh-button" disabled={busy} onClick={onForget}>Sign out and forget this device</button> : null}
          {onDisconnect ? <button type="button" className="sh-button sh-button-danger" disabled={busy} onClick={onDisconnect}>Sign out and disconnect all accounts</button> : null}
          <button type="button" className="sh-button sh-button-danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/** Pure view of the disconnect dialog: what will go, what failed, and the running step. Nothing here reads a value. */
export function DisconnectDialogView({ plan, busy, step, failed, notice, onCancel, onConfirm }: {
  plan: DisconnectPlan | null;
  busy: boolean;
  step: string | null;
  failed: { label: string; code: string }[];
  notice?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const what = plan === null
    ? "Checking what is saved..."
    : plan.keys.length === 0 && plan.savedRepos === 0
      ? "No GitHub or GitLab token and no saved repositories are stored on this computer, so nothing is removed."
      : `This removes: ${describePlan(plan)}.`;
  return (
    <div className="sh-modal" role="alertdialog" aria-modal="true" aria-labelledby="sh-disconnect-title" aria-describedby="sh-disconnect-body" onKeyDown={(e) => e.key === "Escape" && !busy && onCancel()}>
      <div className="sh-modal-card">
        <h2 id="sh-disconnect-title" className="sh-panel-title">Sign out and disconnect all accounts?</h2>
        <p id="sh-disconnect-body" className="sh-panel-text">{what}</p>
        <p className="sh-panel-text sh-muted">This cannot be undone. To use these accounts again you must paste the tokens again. Project files and chat files are not deleted. Provider keys, Slack, Box, email and Google connections are not removed; manage them in Settings.</p>
        {notice ? <p className="sh-panel-text" role="alert">{notice}</p> : null}
        {failed.length > 0 ? <p className="sh-panel-text" role="alert">Could not remove: {failed.map((f) => `${f.label} (${f.code})`).join(", ")}. {notice && /session ended/.test(notice) ? "" : "You are still signed in. "}Try again to remove the rest.</p> : null}
        {step ? <p className="sh-panel-text sh-muted" role="status">{step}</p> : null}
        <div className="sh-form-actions">
          <button ref={cancel} type="button" className="sh-button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="sh-button sh-button-danger" disabled={busy || plan === null} onClick={onConfirm}>Disconnect and sign out</button>
        </div>
      </div>
    </div>
  );
}

/** The stateful dialog: reads the plan on open, runs the deletes one at a time, and keeps the user signed in on a failure. */
function DisconnectDialog({ read, run, onClose }: { read: () => Promise<DisconnectPlan>; run: (plan: DisconnectPlan, onStep: (t: string) => void) => Promise<DisconnectOutcome>; onClose: () => void }) {
  const [plan, setPlan] = useState<DisconnectPlan | null>(null);
  const [failed, setFailed] = useState<{ label: string; code: string }[]>([]);
  const [step, setStep] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const once = useMemo(() => singleFlight(run), [run]);

  useEffect(() => {
    let live = true;
    read().then(
      (p) => { if (live) setPlan(p); },
      () => { if (live) setNotice("Could not read what is saved. Nothing was removed."); },
    );
    return () => { live = false; };
  }, [read]);

  const confirm = () => {
    if (!plan || busy) return;
    setBusy(true);
    setNotice(null);
    once(plan, setStep).then(
      (out) => {
        if (out.signedOut) { onClose(); return; }
        setFailed(out.failed.map((f) => ({ label: f.label, code: f.code })));
        if (out.sessionLost) setNotice("Your session ended before this finished. Sign in again and repeat this to remove what is left; nothing else was changed.");
        setPlan({ keys: out.failed.map((f) => ({ key: f.key, label: f.label })), savedRepos: plan.savedRepos });
      },
      () => setNotice("Something went wrong. Nothing was signed out."),
    ).finally(() => {
      setBusy(false);
      setStep(null);
    });
  };

  return <DisconnectDialogView plan={plan} busy={busy} step={step} failed={failed} notice={notice} onCancel={onClose} onConfirm={confirm} />;
}

export const AccountMenu = memo(function AccountMenu({ user, actions, mac }: { user: SessionUser | null; actions: AccountActions; mac: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  if (!user) return null;
  const canDisconnect = !!actions.disconnectPlan && !!actions.disconnectAll;
  const items = accountMenuItems(user, { ...actions, askSignOut: () => setConfirm(true) }, mac);
  return (
    <>
      <MenuButton ariaLabel={`Account: ${safeText(user.email, 120)}`} className="sh-icon-button sh-account" items={items} end>
        <Icon name="circle-user" size={18} />
      </MenuButton>
      {confirm && (
        <SignOutDialog
          busy={busy}
          onDisconnect={canDisconnect ? () => { setConfirm(false); setDisconnecting(true); } : undefined}
          onCancel={() => setConfirm(false)}
          onForget={actions.signOutAndForget ? () => {
            setBusy(true);
            void actions.signOutAndForget!().finally(() => { setBusy(false); setConfirm(false); });
          } : undefined}
          onConfirm={() => {
            setBusy(true);
            void actions.signOut().finally(() => {
              setBusy(false);
              setConfirm(false);
            });
          }}
        />
      )}
      {disconnecting && canDisconnect ? (
        <DisconnectDialog read={actions.disconnectPlan!} run={actions.disconnectAll!} onClose={() => setDisconnecting(false)} />
      ) : null}
    </>
  );
});
