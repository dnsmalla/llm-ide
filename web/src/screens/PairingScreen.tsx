import { useId, useState, type FormEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { checkHostUrl } from "../host-api/url.ts";

export interface PairingProps {
  initialUrl: string;
  busy: boolean;
  error: string | null;
  revokedNotice: string | null;
  onSubmit: (url: string, pin: string) => void;
}

export function PairingScreen({ initialUrl, busy, error, revokedNotice, onSubmit }: PairingProps) {
  const [url, setUrl] = useState(initialUrl);
  const [pin, setPin] = useState(""); // component state only; cleared after submit
  const [problem, setProblem] = useState<string | null>(null);
  const ids = [useId(), useId()];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const u = checkHostUrl(url);
    if (!u.ok) return setProblem(u.reason);
    if (!/^[0-9]{6}$/.test(pin)) return setProblem("The PIN is 6 digits.");
    setProblem(null);
    onSubmit(u.url, pin);
    setPin("");
  };
  const shown = problem ?? error;
  return (
    <main className="web-app">
      <h1>LLM-IDE Web</h1>
      <section className="web-guide" aria-label="What LLM-IDE does">
        <h2>Your local-first AI workspace</h2>
        <p className="chat-muted">
          Meetings, code, chats and project data stay on your desktop. You sign in with a passkey here, then pair
          this browser to your desktop. AI runs on the desktop with your own Claude login or API key.
        </p>
        <div className="web-features">
          <section><h3>Capture &amp; Library</h3><p>Meeting captions, notes, documents and sources become one searchable knowledge base.</p></section>
          <section><h3>Chat &amp; Code</h3><p>Ask across the project, draft code changes and approve tool actions from the browser.</p></section>
          <section><h3>Issues &amp; Gantt</h3><p>Turn action items into tracked work, schedule it and review delivery in one place.</p></section>
          <section><h3>Graph, Doc Gen, Loop</h3><p>Explore the code graph, generate documents and run repeatable agent workflows.</p></section>
        </div>
        <p className="chat-muted">
          <a href="https://accounts.llm-ide.com/" target="_blank" rel="noreferrer">Create or sign in to your LLM-IDE account</a>
          {" · "}
          <a href="https://accounts.llm-ide.com/account.html" target="_blank" rel="noreferrer">Account &amp; passkeys</a>
        </p>
      </section>
      <form className="web-form" onSubmit={submit}>
        {revokedNotice && <StatusBanner severity="info" message={revokedNotice} />}
        {shown && <StatusBanner severity="error" message={shown} />}
        <label htmlFor={ids[0]}>Host address</label>
        <input id={ids[0]} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" spellCheck={false} />
        <label htmlFor={ids[1]}>Pairing PIN</label>
        <input id={ids[1]} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={pin}
          onChange={(e) => setPin(e.target.value)} required autoFocus />
        <button type="submit" disabled={busy}>{busy ? "Pairing…" : "Pair"}</button>
        <p className="chat-muted">
          Show the PIN in the desktop app: Settings → Host API pairing. This page ({globalThis.location?.origin ?? "this origin"}) must be listed in{" "}
          <code>LLMIDE_HOST_API_WEB_ORIGINS</code>.
        </p>
      </form>
    </main>
  );
}
