// The offline sync tier (design 6): pair this browser, unlock MEGA for this session, read the desktop's last verified
// snapshot with its age, and queue chat prompts that run when the desktop is back. Every string renders as text.
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Markdown } from "@llmide/screens/chat/MarkdownView.tsx";
import { ReadPanel } from "./ReadPanel.tsx";
import { snapshotReadState } from "../read/snapshot.ts";
import { MAX_TEXT } from "../sync/device.ts";
import type { SyncController, SyncState } from "../sync/controller.ts";

type Actions = Pick<SyncController, "pair" | "cancelPairing" | "unlock" | "send" | "refresh" | "lock" | "forget">;
export interface SyncTierProps { state: SyncState; sync: Actions; hostPaired: boolean; onSources?: () => void }

const READ = new Set(["read"] as const);
const when = (ms: number) => new Date(ms).toLocaleString();
const openLink = (href: string) => { if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); };
const STEP: Record<string, string> = { login: "Signing in to MEGA…", claiming: "Sending this browser's keys to the desktop…" };
export const REPLY_TEXT: Record<string, string> = {
  expired: "The desktop saw it too late (over 24 hours, or this device's clock is wrong).",
  quota: "Too many queued prompts today. Try again tomorrow.",
  needs_approval: "The desktop needed an approval it cannot take from here. Ask again with the desktop on.",
  turn_failed: "The desktop could not finish this prompt.",
  refused: "The desktop refused this prompt.",
  stale_epoch: "The desktop changed its keys. Send it again.",
};

function Frame({ children, hostPaired, onSources }: { children: ReactNode; hostPaired: boolean; onSources?: () => void }) {
  return (
    <main className="web-app">
      <header className="web-header">
        <h1>LLM-IDE · offline sync</h1>
        <span className="chat-spacer" />
        {hostPaired && <span className="chat-muted">Desktop not reachable</span>}
        {onSources && <button type="button" onClick={onSources}>Documents and code</button>}
      </header>
      {children}
    </main>
  );
}

function PairView({ state, sync }: { state: SyncState; sync: Actions }) {
  const ids = [useId(), useId(), useId(), useId()];
  const [name, setName] = useState("Browser");
  const [email, setEmail] = useState(state.email);
  const [password, setPassword] = useState("");
  const box = state.store === "box";
  const sasHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (state.pairStep === "sas") sasHeading.current?.focus(); }, [state.pairStep]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pw = password;
    setPassword("");
    void sync.pair({ email: box ? "" : email.trim(), password: box ? "" : pw, name: name.trim() });
  };
  if (state.pairStep === "sas" && state.sas) {
    const sas = state.sas;
    return (
      <section aria-labelledby={ids[0]}>
        <h2 id={ids[0]} ref={sasHeading} tabIndex={-1}>Check the code</h2>
        <p>The desktop shows a 6-digit code. If it is the same as this one, press <strong>Codes match</strong> on the desktop.</p>
        <output className="web-sync-sas" aria-label={`Pairing code ${sas.split("").join(" ")}`}>{sas.slice(0, 3)} {sas.slice(3)}</output>
        <p role="status" aria-live="polite">Waiting for the desktop…</p>
        <button type="button" onClick={sync.cancelPairing}>Cancel</button>
      </section>
    );
  }
  return (
    <form className="web-form" onSubmit={submit} aria-describedby={ids[3]}>
      <h2>Add this browser to offline sync</h2>
      {box ? <p id={ids[3]}>Sign in to the Box account the desktop syncs to. A small Box window opens. Box gives this browser access to that whole Box account (Box has no single-folder access), so use a Box account kept for LLM-IDE. The sign-in lasts for this session only.</p> : <p id={ids[3]}>{state.login !== false ? "Use the dedicated MEGA account the desktop syncs to. The password is used for this session only and is never stored." : "This browser reaches its own folder on your server. Nothing to sign in to."}</p>}
      {state.notice && <StatusBanner severity="info" message={state.notice} />}
      <label htmlFor={ids[0]}>Name for this browser</label>
      <input id={ids[0]} value={name} maxLength={64} required onChange={(e) => setName(e.target.value)} />
      {!box && state.login !== false && (<><label htmlFor={ids[1]}>MEGA email</label>
      <input id={ids[1]} type="email" autoComplete="username" value={email} required onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor={ids[2]}>MEGA password</label>
      <input id={ids[2]} type="password" autoComplete="current-password" value={password} required onChange={(e) => setPassword(e.target.value)} /></>)}
      <p className="web-status" role="status" aria-live="polite">{state.busy ? (state.pairStep === "claiming" ? STEP.claiming : state.login !== false ? STEP.login : "Connecting to your server…") : ""}</p>
      {state.error && <StatusBanner severity="error" message={state.error} />}
      <div className="web-actions">
        <button type="submit" disabled={state.busy}>{box ? "Sign in to Box and continue" : "Continue"}</button>
        <button type="button" onClick={sync.cancelPairing}>Cancel</button>
      </div>
    </form>
  );
}

function UnlockView({ state, sync }: { state: SyncState; sync: Actions }) {
  const ids = [useId(), useId()];
  const [email, setEmail] = useState(state.email);
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); const pw = password; setPassword(""); void sync.unlock({ email: email.trim(), password: pw }); };
  if (state.store === "box") return (
    <section className="web-form">
      <h2>Connect Box</h2>
      <p>Connect Box for this session. Nothing is kept after you close the page.</p>
      {state.error && <StatusBanner severity="error" message={state.error} />}
      {state.notice && <StatusBanner severity="info" message={state.notice} />}
      <div className="web-actions">
        <button type="button" disabled={state.busy} onClick={() => void sync.unlock({ email: "", password: "" })}>{state.busy ? "Connecting…" : "Connect Box"}</button>
        <button type="button" onClick={() => void sync.forget()}>Forget this browser</button>
      </div>
    </section>
  );
  if (state.login === false) return (
    <section className="web-form">
      <h2>Offline sync</h2>
      {state.error && <StatusBanner severity="error" message={state.error} />}
      <div className="web-actions">
        <button type="button" disabled={state.busy} onClick={() => void sync.unlock({ email: "", password: "" })}>{state.busy ? "Connecting…" : "Connect"}</button>
        <button type="button" onClick={() => void sync.forget()}>Forget this browser</button>
      </div>
    </section>
  );
  return (
    <form className="web-form" onSubmit={submit}>
      <h2>Unlock offline sync</h2>
      <p>Enter the sync account's MEGA password for this session. It is never stored.</p>
      <label htmlFor={ids[0]}>MEGA email</label>
      <input id={ids[0]} type="email" autoComplete="username" value={email} required onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor={ids[1]}>MEGA password</label>
      <input id={ids[1]} type="password" autoComplete="current-password" value={password} required onChange={(e) => setPassword(e.target.value)} />
      {state.error && <StatusBanner severity="error" message={state.error} />}
      {state.notice && <StatusBanner severity="info" message={state.notice} />}
      <div className="web-actions">
        <button type="submit" disabled={state.busy}>{state.busy ? "Unlocking…" : "Unlock"}</button>
        <button type="button" onClick={() => void sync.forget()}>Forget this browser</button>
      </div>
    </form>
  );
}

function Inbox({ state, sync }: { state: SyncState; sync: Actions }) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const submit = async (e: FormEvent) => { e.preventDefault(); const t = draft.trim(); if (t && (await sync.send(t))) setDraft(""); };
  return (
    <section className="web-read" aria-label="Queued prompts">
      <h2>Ask the desktop later</h2>
      <p className="chat-muted">Prompts wait in your storage and run when the desktop is back, read-only: no file changes and no approvals.</p>
      <form className="web-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor={id}>Prompt for the desktop</label>
        <textarea id={id} value={draft} maxLength={MAX_TEXT} rows={3} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" disabled={!draft.trim() || !state.online}>Queue prompt</button>
      </form>
      {state.pending.length > 0 && (
        <ul className="web-list" aria-label="Waiting for the desktop">
          {state.pending.map((p) => <li key={p.requestId} className="web-msg web-user">{p.text ?? "(sent earlier)"} <span className="chat-muted">· queued {when(p.issuedAt)}</span></li>)}
        </ul>
      )}
      {state.answered.length > 0 && (
        <ul className="web-list" aria-label="Answers">
          {state.answered.map((a) => (
            <li key={a.requestId} className="web-msg web-assistant">
              {a.text && <p className="chat-muted">{a.text}</p>}
              {a.ok && a.reply !== null ? <Markdown text={a.reply} onOpenLink={openLink} /> : <p>{REPLY_TEXT[a.code ?? ""] ?? "No answer."}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReadyView({ state, sync }: { state: SyncState; sync: Actions }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const snap = state.snapshot;
  const read = snapshotReadState(snap, openId);
  return (
    <>
      <p role="status" aria-live="polite">{snap ? `Desktop last seen ${when(snap.generatedAt)}` : "No snapshot yet."}{state.checkedAt ? ` · checked ${when(state.checkedAt)}` : ""}</p>
      {snap && state.stale && <StatusBanner severity="warning" message={`Desktop offline or storage withholding updates. This snapshot was due for renewal at ${when(snap.validUntil)}.`} />}
      {!state.online && <StatusBanner severity="info" message="You are offline. Showing what was loaded in this session." />}
      {state.notice && <StatusBanner severity="info" message={state.notice} />}
      {state.error && <StatusBanner severity="error" message={state.error} />}
      <div className="web-actions">
        <button type="button" onClick={() => void sync.refresh()} disabled={state.busy || !state.online}>Check now</button>
        <button type="button" onClick={() => void sync.lock()}>Lock</button>
        <button type="button" onClick={() => void sync.forget()}>Forget this browser</button>
      </div>
      <div className="web-shell">
        <ReadPanel capabilities={READ} state={read} onOpen={(id) => setOpenId(id)} onOlder={() => {}} onClose={() => setOpenId(null)} onMore={() => {}} />
        {!read.open && <Inbox state={state} sync={sync} />}
      </div>
    </>
  );
}

export function SyncTier({ state, sync, hostPaired, onSources }: SyncTierProps) {
  return (
    <Frame hostPaired={hostPaired} onSources={onSources}>
      {state.phase === "pairing" ? <PairView state={state} sync={sync} />
        : state.phase === "locked" ? <UnlockView state={state} sync={sync} />
        : state.phase === "removed" ? (
          <section>
            <h2>This browser was removed from sync</h2>
            <p>The desktop removed it, or its folder was deleted from the sync storage. Pair again from the desktop to keep using offline sync.</p>
            <button type="button" onClick={() => void sync.forget()}>Forget this browser</button>
          </section>
        )
        : <ReadyView state={state} sync={sync} />}
    </Frame>
  );
}

/** On the Pairing screen: an installed PWA cannot receive the desktop's link, so it can be pasted. */
export function SyncLinkEntry({ onLink, error }: { onLink: (url: string) => boolean; error: string | null }) {
  const id = useId();
  const [v, setV] = useState("");
  return (
    <form className="web-form" onSubmit={(e) => { e.preventDefault(); if (onLink(v)) setV(""); }}>
      <h2>Offline sync</h2>
      <p>Read your desktop's last snapshot and queue prompts while it is off. On the desktop: Settings → sync → Add a phone or browser → Browser, then open that link here or paste it.</p>
      <label htmlFor={id}>Pairing link</label>
      <input id={id} type="url" autoComplete="off" spellCheck={false} value={v} onChange={(e) => setV(e.target.value)} />
      {error && <p role="alert" className="web-error">{error}</p>}
      <button type="submit" disabled={!v.trim()}>Use link</button>
    </form>
  );
}
