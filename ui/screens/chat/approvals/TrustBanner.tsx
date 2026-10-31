// Workspace trust banner (S-G). The `workspace_trust` notice says the project folder is untrusted and what was left
// unloaded. "Trust this folder" opens a confirmation naming what will run; only its confirm PUTs
// /auth/me/workspace-trust, with the notice's own path (captured when the dialog opened, never typed or edited).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { WorkspaceTrustState } from "../state";
import { describeError, httpLike, type CoreTransport } from "../transport";
import { nextFocusIndex } from "./machine";
import { bannerText, confirmationText, failureMessage, kindText, withheld } from "./trust";
import { sanitizeText } from "./sanitize";

export interface TrustBannerProps {
  trust: WorkspaceTrustState | null;
  core: Pick<CoreTransport, "json">;
  /** Called after the core accepted the trust, with the path that was trusted. */
  onTrusted: (path: string) => void;
  /** Optional host-run native confirmation (the plan's preferred form). Resolve true to proceed; absent = the in-page dialog only. */
  nativeConfirm?: (title: string, body: string, path: string) => Promise<boolean>;
}

export function TrustBanner({ trust, core, onTrusted, nativeConfirm }: TrustBannerProps) {
  const [dialogPath, setDialogPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  // The notice moved to another folder while the dialog was open: what the user read no longer applies.
  useEffect(() => { if (dialogPath !== null && trust?.path !== dialogPath) { setDialogPath(null); setError(null); } }, [trust?.path, dialogPath]);
  useEffect(() => { if (dialogPath !== null) cancel.current?.focus(); else opener.current?.focus(); }, [dialogPath]);
  if (!trust) return null;
  const held = withheld(trust);
  const conf = confirmationText(trust);

  const confirm = async () => {
    if (dialogPath === null || dialogPath !== trust.path || busy) return;
    setBusy(true); setError(null);
    try {
      if (nativeConfirm && !(await nativeConfirm(conf.title, conf.body.join("\n\n"), dialogPath))) { setBusy(false); return; }
      await core.json("PUT", "/auth/me/workspace-trust", { path: dialogPath, trusted: true });
      onTrusted(dialogPath);
      setDialogPath(null);
    } catch (e) {
      const h = httpLike(e);
      setError(failureMessage(h?.code ?? null, h ? h.message : describeError(e).message));
    } finally { setBusy(false); }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); setDialogPath(null); return; }
    if (e.key === "Tab" && dialog.current) {
      const items = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
      const i = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (i >= 0) { e.preventDefault(); items[i].focus(); }
    }
  };

  return (
    <div className="appr-trust" role="status" data-kind={held.length ? "withheld" : "info"}>
      <p>{bannerText(trust)}</p>
      {trust.skipped.length > 0 && (
        <ul className="appr-trust-list" aria-label="What was not loaded">
          {trust.skipped.slice(0, 8).map((s, i) => <li key={i}>{kindText(s.kind)}: {sanitizeText(s.name, 80).text}</li>)}
          {trust.skipped.length > 8 && <li>and {trust.skipped.length - 8} more</li>}
        </ul>
      )}
      <button ref={opener} type="button" className="chat-btn" aria-haspopup="dialog" onClick={() => setDialogPath(trust.path)}>Trust this folder...</button>
      {dialogPath !== null && (
        <div className="appr-scrim">
          <div ref={dialog} className="appr-dialog" role="alertdialog" aria-modal="true" aria-labelledby="appr-trust-title" aria-describedby="appr-trust-body" onKeyDown={onKeyDown}>
            <h3 id="appr-trust-title" className="appr-title">{conf.title}</h3>
            <div id="appr-trust-body">{conf.body.map((p, i) => <p key={i}>{p}</p>)}</div>
            {error && <p role="alert" className="chat-error">{error}</p>}
            <div className="appr-actions">
              <button ref={cancel} type="button" className="chat-btn chat-primary" onClick={() => setDialogPath(null)}>Cancel</button>
              <button type="button" className="chat-btn chat-danger" disabled={busy} onClick={() => void confirm()}>{busy ? "Trusting..." : "Trust folder"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
