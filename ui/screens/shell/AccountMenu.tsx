// The account menu at the right of the toolbar (Mac `HeaderAccountMenu`): who is signed in, Settings, Help & Guide,
// Permissions, Sign out (confirmed). Only shown while signed in, like the Mac. Name and email are server text: shown as text.
import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "@llmide/ui-kit";
import { MenuButton, type MenuItem } from "./MenuButton";
import { safeText } from "./safe-text";
import type { SessionUser } from "./core";

/** Mac's confirmation wording, adjusted to what the desktop actually clears. */
export const SIGN_OUT_TITLE = "Sign out of LLM-IDE?";
export const SIGN_OUT_BODY = "Signing out ends your session on this computer. Your projects, notes and saved chats stay where they are.";

export interface AccountActions {
  openSettings: () => void;
  openHelp: () => void;
  openPermissions: () => void;
  signOut: () => Promise<void>;
  /** Sign out AND clear this device's local UI settings (the Mac's broader sign-out). */
  signOutAndForget?: () => Promise<void>;
}

/** The menu rows (pure, so the order and wording are tested without a DOM). */
export function accountMenuItems(user: SessionUser, a: Pick<AccountActions, "openSettings" | "openHelp" | "openPermissions"> & { askSignOut: () => void }, mac: boolean): MenuItem[] {
  const mod = mac ? "⌘" : "Ctrl+";
  return [
    { id: "name", kind: "label", label: safeText(user.displayName || user.email, 80) },
    { id: "email", kind: "label", label: safeText(user.email, 120), muted: true },
    { id: "sep1", kind: "separator" },
    { id: "settings", label: "Settings…", hint: `${mod},`, onSelect: a.openSettings },
    { id: "help", label: "Help & Guide", onSelect: a.openHelp },
    { id: "permissions", label: "Permissions…", onSelect: a.openPermissions },
    { id: "sep2", kind: "separator" },
    { id: "signout", label: "Sign out", onSelect: a.askSignOut },
  ];
}

export function SignOutDialog({ onCancel, onConfirm, busy, title = SIGN_OUT_TITLE, body = SIGN_OUT_BODY, confirmLabel = "Sign out" }: { onCancel: () => void; onConfirm: () => void; busy?: boolean; title?: string; body?: string; confirmLabel?: string }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="sh-modal" role="alertdialog" aria-modal="true" aria-labelledby="sh-signout-title" aria-describedby="sh-signout-body" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="sh-modal-card">
        <h2 id="sh-signout-title" className="sh-panel-title">{title}</h2>
        <p id="sh-signout-body" className="sh-panel-text sh-muted">{body}</p>
        <div className="sh-form-actions">
          <button ref={cancel} type="button" className="sh-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="sh-button sh-button-danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export const AccountMenu = memo(function AccountMenu({ user, actions, mac }: { user: SessionUser | null; actions: AccountActions; mac: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const items = accountMenuItems(user, { ...actions, askSignOut: () => setConfirm(true) }, mac);
  items.push(...(actions.signOutAndForget ? [{ id: "signout-forget", label: "Sign out and forget this device…", onSelect: () => setForget(true) } as MenuItem] : []));
  return (
    <>
      <MenuButton ariaLabel={`Account: ${safeText(user.email, 120)}`} className="sh-icon-button sh-account" items={items} end>
        <Icon name="circle-user" size={18} />
      </MenuButton>
      {forget && actions.signOutAndForget ? (
        <SignOutDialog
          busy={busy}
          title="Sign out and forget this device?"
          body="Signing out clears this computer's local UI settings (panels, terminal, Library view, save destinations) and your session. Project files and notes are not deleted."
          confirmLabel="Sign out and forget"
          onCancel={() => setForget(false)}
          onConfirm={() => {
            setBusy(true);
            void actions.signOutAndForget!().finally(() => { setBusy(false); setForget(false); });
          }}
        />
      ) : null}
      {confirm && (
        <SignOutDialog
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setBusy(true);
            void actions.signOut().finally(() => {
              setBusy(false);
              setConfirm(false);
            });
          }}
        />
      )}
    </>
  );
});
