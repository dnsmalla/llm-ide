// Documents and code at the source (design 9): GitLab projects and Box folders, read-only. Every name, path, snippet and
// body renders as React text, or through the shared Markdown view (no HTML strings, no images). A PDF is offered as a
// download only (decision D2); nothing from a provider is rendered as HTML or executed.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Markdown } from "@llmide/screens/chat/MarkdownView.tsx";
import { TEXT, type SourcesController, type SourcesState } from "../sources/controller.ts";
import type { Entry, Opened, Reason } from "../sources/model.ts";
import type { Provider } from "../sources/oauth.ts";
import { Banner, Button, TextField } from "../ui/index.ts";

type Actions = Omit<SourcesController, "subscribe" | "getState" | "start" | "dispose">;
export interface SourcesScreenProps { state: SourcesState; sources: Actions; onBack: () => void }

export const NAME: Record<Provider, string> = { gitlab: "GitLab", box: "Box" };
export const REASON: Record<Reason, string> = {
  binary: "This file is binary and is not shown.",
  type: "This file type is not shown here.",
  too_large: "Too large to show here. Open it on the provider's site.",
  no_text: "Box has no text for this file yet.",
};
const KIND: Record<Entry["kind"], string> = { project: "Project", dir: "Folder", file: "File" };
const HELP: Record<Provider, string> = {
  gitlab: "On gitlab.com: Preferences → Applications → Add new application. Untick Confidential, tick only read_api and read_repository, and add the redirect URI below. Paste the Application ID here. A sign-in lasts for this browser session.",
  box: "In the Box developer console: create a Custom App with User Authentication (OAuth 2.0), tick only “Read all files and folders stored in Box”, add this site's address to CORS Domains and the redirect URI below. The client secret stays in this browser's storage for this site; anything running on this site could read it.",
};
const openLink = (href: string) => { if (/^https:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); };
const size = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function ProviderCard({ p, state, sources }: { p: Provider; state: SourcesState; sources: Actions }) {
  const ids = [useId(), useId(), useId()];
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const configured = state.configured[p], signed = state.signedIn[p];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const sec = secret; setSecret("");
    if (await sources.configure(p, p === "box" ? { clientId: id.trim(), clientSecret: sec.trim() } : { clientId: id.trim() })) setId("");
  };
  return (
    <article className="source-card" aria-labelledby={ids[2]}>
      <header className="source-card-head">
        <span className="source-logo" data-provider={p} aria-hidden="true">{p === "gitlab" ? "GL" : "BX"}</span>
        <div className="source-card-title"><h2 id={ids[2]}>{p === "gitlab" ? "GitLab code" : "Box documents"}</h2><p>{p === "gitlab" ? "Repositories, files and code search" : "Folders, documents and extracted text"}</p></div>
        <span className="source-status" data-state={signed ? "live" : configured ? "ready" : "off"}>{signed ? "Connected" : configured ? "Ready" : "Not set up"}</span>
      </header>
      <div className="source-card-actions">
        {configured && !signed && <Button variant="primary" disabled={state.busy || !state.online} onClick={() => void sources.signIn(p)}>Sign in to {NAME[p]}</Button>}
        {signed && <Button variant="primary" onClick={() => void sources.choose(p)}>Browse {NAME[p]}</Button>}
        {signed && <Button variant="secondary" onClick={() => void sources.signOut(p)}>Sign out</Button>}
      </div>
      <details className="source-setup" open={!configured}>
        <summary>{configured ? "App settings" : "Set up app"}</summary>
        <p className="source-note">{signed ? "Signed in for this browser session." : configured ? "App settings saved. Sign in to browse." : "One-time setup with your own OAuth app."}</p>
        <p>{HELP[p]}</p>
        <p>Redirect URI to register: <code>{sources.redirectUri()}</code></p>
        <form className="web-form" onSubmit={(e) => void save(e)}>
          <TextField id={ids[0]} label={p === "gitlab" ? "Application ID" : "Client ID"} value={id} autoComplete="off" spellCheck={false} maxLength={128} required onChange={(e) => setId(e.target.value)} />
          {p === "box" && (
            <>
              <TextField id={ids[1]} label="Client secret" type="password" value={secret} autoComplete="off" maxLength={128} required onChange={(e) => setSecret(e.target.value)} />
            </>
          )}
          <div className="source-card-actions">
            <Button variant="primary" type="submit">Save app</Button>
            {configured && <Button variant="secondary" onClick={() => void sources.forgetConfig(p)}>Forget app</Button>}
          </div>
        </form>
      </details>
    </article>
  );
}

function Browser({ state, sources }: { state: SourcesState; sources: Actions }) {
  const p = state.provider as Provider;
  const searchId = useId();
  const [q, setQ] = useState("");
  const here = state.trail.at(-1) ?? null;
  const label = p === "gitlab" ? (here ? "Search code in this project" : "Search projects") : here ? "Search files in this folder" : "Search Box files";
  const atEnd = (i: number) => i === state.trail.length - 1 && state.query === null;
  return (
    <section className="web-read" aria-label={`${NAME[p]} browser`}>
      <nav aria-label="Location">
        <ol className="web-crumbs">
          <li><button type="button" onClick={() => void sources.toCrumb(-1)} aria-current={state.trail.length === 0 && state.query === null ? "page" : undefined}>{p === "gitlab" ? "Projects" : "All files"}</button></li>
          {state.trail.map((e, i) => <li key={e.id}><button type="button" onClick={() => void sources.toCrumb(i)} aria-current={atEnd(i) ? "page" : undefined}>{e.name}</button></li>)}
        </ol>
      </nav>
      <form className="web-search" role="search" onSubmit={(e) => { e.preventDefault(); void sources.search(q); }}>
        <TextField id={searchId} label={label} type="search" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
        <Button variant="primary" type="submit" disabled={!q.trim() || state.busy || !state.online}>Search</Button>
        {state.query !== null && <Button variant="secondary" onClick={() => { setQ(""); void sources.clearSearch(); }}>Clear search</Button>}
      </form>
      {state.query !== null && <p>Results for “{state.query}”</p>}
      <ul className="web-list" aria-label={state.query !== null ? "Search results" : "Items"}>
        {state.entries.map((e) => (
          <li key={e.id}>
            <button type="button" className="web-entry" onClick={() => void sources.openEntry(e)}><span className="chat-muted">{KIND[e.kind]}</span> {e.name}</button>
            {e.size !== null && <span className="chat-muted"> · {size(e.size)}</span>}
            {state.query !== null && e.path !== e.name && <span className="chat-muted"> · {e.path}</span>}
            {e.detail && <pre className="web-snippet">{e.detail}</pre>}
          </li>
        ))}
      </ul>
      {!state.busy && state.entries.length === 0 && <p className="chat-muted">{state.query !== null ? "No results." : "Nothing here."}</p>}
      {state.next && state.query === null && <Button variant="secondary" onClick={() => void sources.more()} disabled={state.busy}>More</Button>}
    </section>
  );
}

function FileView({ o, provider, onClose }: { o: Opened; provider: Provider; onClose: () => void }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, [o]);
  const savePdf = () => {
    if (!o.bytes) return;
    const url = URL.createObjectURL(new Blob([o.bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url; a.download = o.entry.name.replace(/[^\w.\- ]+/g, "_") || "document.pdf"; a.rel = "noopener";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const asText = o.text !== null && (o.kind === "code" || o.kind === "text" || o.kind === "extracted");
  return (
    <section className="web-read" aria-label={`File ${o.entry.name}`}>
      <div className="web-read-head">
        <Button size="sm" variant="secondary" icon="chevron-left" onClick={onClose}>Back to list</Button>
        <h2 ref={head} tabIndex={-1}>{o.entry.name}</h2>
        {o.webUrl && <Button size="sm" variant="secondary" onClick={() => openLink(o.webUrl as string)}>Open on {NAME[provider]}</Button>}
      </div>
      <p className="chat-muted">{o.entry.path}{o.language ? ` · ${o.language}` : ""} · read-only</p>
      {o.truncated && <Banner tone="warn">Only the first part is shown: the file is larger than this app shows.</Banner>}
      {o.reason && <p>{REASON[o.reason]}</p>}
      {o.kind === "markdown" && o.text !== null && <div className="web-doc"><Markdown text={o.text} onOpenLink={openLink} /></div>}
      {o.kind === "extracted" && <p className="chat-muted">Text extracted by Box. Layout and images are not shown.</p>}
      {asText && <pre className="web-src" tabIndex={0} aria-label={`Contents of ${o.entry.name}`}><code>{o.text}</code></pre>}
      {o.kind === "pdf" && o.bytes && (
        <>
          <p>PDF, {size(o.bytes.length)}. This app does not display PDFs. Save it and open it with your PDF viewer.</p>
          <Button variant="primary" onClick={savePdf}>Save PDF</Button>
        </>
      )}
    </section>
  );
}

export function SourcesScreen({ state, sources, onBack }: SourcesScreenProps) {
  return (
    <main className="web-app sources-app">
      <header className="sources-topbar">
        <div className="sources-brand"><span className="web-mark" aria-hidden="true" /><div><span>LLM-IDE</span><h1>Documents &amp; code</h1></div></div>
        <div className="sources-top-actions"><span className="sync-chip" data-tone="muted">Read-only</span><Button size="sm" variant="secondary" icon="chevron-left" onClick={state.provider ? () => void sources.choose(null) : onBack}>{state.provider ? "All sources" : "Back"}</Button></div>
      </header>
      {!state.provider && (
        <section className="sources-hero">
          <p className="web-kicker">Live from the source</p>
          <h2>Your documents and code, without the desktop</h2>
          <p>Read directly from your own GitLab and Box accounts, read-only. Nothing is copied into sync or stored on this device.</p>
        </section>
      )}
      {!state.online && <Banner tone="info">{TEXT.offline}</Banner>}
      <p className="web-status" role="status" aria-live="polite">{state.status}</p>
      {state.error && <Banner tone="error">{state.error}</Banner>}
      {!state.provider ? (
        <div className="sources-grid">
          <ProviderCard p="gitlab" state={state} sources={sources} />
          <ProviderCard p="box" state={state} sources={sources} />
        </div>
      ) : state.opened ? <FileView o={state.opened} provider={state.provider} onClose={sources.closeFile} />
        : <Browser state={state} sources={sources} />}
    </main>
  );
}

/** On the Pairing screen: the way in when this browser is not linked to anything yet. */
export function SourcesEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="web-form">
      <h2>Documents and code</h2>
      <p>Read your Box documents and GitLab code directly, read-only, even with the desktop off.</p>
      <Button variant="primary" onClick={onOpen}>Open documents and code</Button>
    </section>
  );
}
