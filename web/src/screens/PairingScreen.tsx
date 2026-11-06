import { useId, useState, type FormEvent, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { checkHostUrl } from "../host-api/url.ts";

export interface PairingProps {
  initialUrl: string;
  busy: boolean;
  error: string | null;
  revokedNotice: string | null;
  onSubmit: (url: string, pin: string) => void;
  footer?: ReactNode;
}

/** The first screen of the web client. Deliberately a product page, not a bare form: explain what the browser is
 *  connecting to, where the PIN comes from, and separate the cloud account from the desktop host. */
export function PairingScreen({ initialUrl, busy, error, revokedNotice, onSubmit, footer }: PairingProps) {
  const [url, setUrl] = useState(initialUrl);
  const [pin, setPin] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const ids = [useId(), useId(), useId()];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const u = checkHostUrl(url);
    if (!u.ok) return setProblem(u.reason);
    if (!/^[0-9]{6}$/.test(pin)) return setProblem("The pairing PIN is six digits.");
    setProblem(null);
    onSubmit(u.url, pin);
    setPin("");
  };
  const shown = problem ?? error;
  return (
    <main className="web-auth web-connect-app">
      <header className="web-appbar">
        <a className="web-brand" href="https://llm-ide.com/" aria-label="LLM-IDE home">
          <span className="web-mark" aria-hidden="true" />
          <span>LLM-IDE</span><em>web</em>
        </a>
        <div className="web-appbar-actions">
          <span className="web-private-pill">Private workspace</span>
          <a className="web-quiet-link" href="https://llm-ide.com/guide.html">Guide</a>
        </div>
      </header>

      <section className="web-connect">
        <aside className="web-connect-copy">
          <p className="web-kicker">Desktop companion</p>
          <h1>Your workspace,<br />without the clutter.</h1>
          <p className="web-sub">Connect this browser to your desktop for chat, approvals and read-only access to meetings, plans and library notes.</p>
          <ol className="web-steps" aria-label="How to connect">
            <li><span>1</span><div><strong>Open the desktop app</strong><p>Keep LLM-IDE running on the computer that holds your project.</p></div></li>
            <li><span>2</span><div><strong>Show the pairing PIN</strong><p>Settings → Host API pairing → Show PIN.</p></div></li>
            <li><span>3</span><div><strong>Enter it here</strong><p>This browser connects directly. Nothing is copied to a cloud account.</p></div></li>
          </ol>
          <div className="web-trust">
            <span><i />Project data stays on your desktop</span>
            <span><i />No account or cloud copy</span>
          </div>
        </aside>

        <section className="web-panel web-connect-panel" aria-labelledby="web-pair-title">
          <div className="web-panel-top"><span className="web-live" aria-hidden="true" />CONNECT DESKTOP <span className="web-step">PAIRING</span></div>
          <h2 id="web-pair-title">Pair this browser</h2>
          <p className="web-muted">Use the one-time PIN shown on your desktop. No account is needed.</p>
          <form className="web-form" onSubmit={submit}>
            {revokedNotice && <StatusBanner severity="info" message={revokedNotice} />}
            {shown && <StatusBanner severity="error" message={shown} />}
            <label htmlFor={ids[0]}>Host address</label>
            <input id={ids[0]} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" spellCheck={false} />
            <p className="web-hint">The address of the computer running LLM-IDE.</p>
            <label htmlFor={ids[1]}>Pairing PIN</label>
            <input id={ids[1]} className="web-pin" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required autoFocus placeholder="••••••" aria-describedby={ids[2]} />
            <p className="web-hint" id={ids[2]}>Six digits from Settings → Host API pairing.</p>
            <button type="submit" disabled={busy}>{busy ? "Pairing…" : "Pair browser"}</button>
          </form>
          <details className="web-help">
            <summary>Connection help</summary>
            <p>If pairing fails, check that the desktop is running and lists this page's address in <code>LLMIDE_HOST_API_WEB_ORIGINS</code>.</p>
            <p>For read-only access while the desktop is off, use the sync-link form below.</p>
          </details>
          <div className="web-account-line"><a href="https://llm-ide.com/">What is LLM-IDE?</a></div>
        </section>
      </section>

      {footer}
      <footer className="web-foot">
        <span>LLM-IDE web companion</span>
        <span>Local-first · no account</span>
        <span className="web-foot-links"><a href="/app/privacy">Privacy</a><a href="/app/support">Support</a></span>
      </footer>
    </main>
  );
}
