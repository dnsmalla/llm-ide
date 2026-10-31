import { useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { AllowlistModel, IGNORED_REASON, TRUST_CONSENT, TrustListModel, ceilingText } from "../trust-model.ts";
import { useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import { Button, ErrorText, Field, NeedsHost } from "../ui.tsx";

/** The Mac's "Folder trust" group. */
export function TrustedFolders() {
  const { client, host } = useEnv();
  const m = useModel(() => new TrustListModel(client));
  const s = useStore(m);
  useRefreshOnFocus(() => void m.load());
  // With a desktop host the final yes is a native dialog (fixed text naming the folder, default Cancel); a refusal keeps the folder untrusted.
  const confirmTrust = async (path: string) => {
    if (host.confirmTrust) {
      let ok = false;
      try { ok = await host.confirmTrust(path); } catch { ok = false; }
      if (!ok) { m.cancelPending(); return; }
    }
    await m.confirmPendingTrust();
  };
  return (
    <div className="st-stack">
      <p className="st-hint">Chats in a trusted folder start the MCP servers its .mcp.json defines. Each change is a click here; nothing is trusted automatically.</p>
      {!s.enforced ? <StatusBanner severity="warning" message="The operator turned the trust check off on this server, so every folder behaves as trusted." /> : null}
      <ErrorText text={s.error} />
      <div className="st-row">
        <Button label="Reload trusted folders" onClick={() => void m.load()} disabled={s.loading}>Reload</Button>
        {host.pickFolder ? <Button onClick={() => void host.pickFolder!("Choose a folder to trust").then((p) => { if (p) m.addFolder(p); })}>Add folder...</Button> : <NeedsHost what="Choosing a folder" />}
      </div>
      {s.pendingTrust ? (
        <div className="st-dialog" role="alertdialog" aria-label={`Trust ${s.pendingTrust.path}`}>
          <p className="st-pre">{TRUST_CONSENT(s.pendingTrust.path)}</p>
          <div className="st-row">
            <Button tone="danger" onClick={() => void confirmTrust(s.pendingTrust!.path)}>Trust this folder</Button>
            <Button onClick={() => m.cancelPending()}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {s.loaded && s.items.length === 0 ? <p className="st-hint">No folder decisions yet.</p> : null}
      <ul className="st-stack" aria-label="Folder decisions">
        {s.items.map((i) => (
          <li key={i.path} className="st-row">
            <span className="st-grow" title={i.path}>{i.path}</span>
            <span className="st-status" data-tone={i.trusted ? "ok" : "warning"}>{i.trusted ? "Trusted" : "Not trusted"}</span>
            <Button label={`${i.trusted ? "Stop trusting" : "Trust"} ${i.path}`} disabled={s.busy.has(i.path)} onClick={() => void m.requestChange(i, !i.trusted)}>{i.trusted ? "Stop trusting" : "Trust..."}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Mac's "Extension sources" group. */
export function Allowlist() {
  const { client } = useEnv();
  const m = useModel(() => new AllowlistModel(client));
  const s = useStore(m);
  useRefreshOnFocus(() => void m.load());
  const [confirm, setConfirm] = useState<string | null>(null);
  const a = s.allowlist;
  return (
    <div className="st-stack">
      <p className="st-hint">Where extensions may be installed from. Entries look like owner/repo or owner/*.</p>
      <ErrorText text={s.error} />
      {!a ? <div className="st-row"><Button onClick={() => void m.load()} disabled={s.loading}>Reload</Button><span className="st-hint">The saved list is not loaded; it cannot be changed until it is.</span></div> : null}
      {a ? (
        <>
          <Group title="Set by the operator" items={a.operator} empty="The operator allows nothing by default." />
          <p className="st-hint">{ceilingText(a.ceiling)}</p>
          <div className="st-stack" role="group" aria-label="Your additions">
            <span className="st-label">Your additions</span>
            {a.user.length === 0 ? <p className="st-hint">None.</p> : null}
            <ul className="st-stack">
              {a.user.map((e) => (
                <li key={e} className="st-row">
                  <span className="st-grow">{e}</span>
                  {a.ignored.includes(e) ? <span className="st-error">{IGNORED_REASON}</span> : null}
                  <Button label={`Remove ${e} from your additions`} disabled={s.saving} onClick={() => setConfirm(e)}>Remove</Button>
                </li>
              ))}
            </ul>
          </div>
          {confirm ? (
            <div className="st-dialog" role="alertdialog" aria-label={`Remove ${confirm}`}>
              <p>Remove <strong>{confirm}</strong> from your additions? Extensions from it can no longer be installed. Ones already installed stay.</p>
              <div className="st-row">
                <Button tone="danger" onClick={() => { const e = confirm; setConfirm(null); void m.remove(e); }}>Remove</Button>
                <Button onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            </div>
          ) : null}
          <Field label="Add a source" hint="owner/repo, owner/*, or a pasted GitHub address">
            <div className="st-row">
              <input className="st-input st-grow" value={s.draft} autoComplete="off" spellCheck={false} onChange={(e) => m.setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && m.canAdd) void m.addDraft(); }} />
              <Button tone="primary" disabled={!m.canAdd} onClick={() => void m.addDraft()}>Add</Button>
            </div>
          </Field>
          <Group title="In effect" items={a.effective} empty="Nothing can be installed." />
        </>
      ) : null}
    </div>
  );
}

function Group({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="st-stack" role="group" aria-label={title}>
      <span className="st-label">{title}</span>
      {items.length === 0 ? <p className="st-hint">{empty}</p> : <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>}
    </div>
  );
}
