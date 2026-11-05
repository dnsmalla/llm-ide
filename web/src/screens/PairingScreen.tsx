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
    <main className="web-auth">
      <header className="web-top">
        <a className="web-brand" href="https://llm-ide.com/" aria-label="LLM-IDE home">
          <span className="web-mark" aria-hidden="true" />
          <span>LLM-IDE</span><em>web</em>
        </a>
        <nav className="web-topnav" aria-label="LLM-IDE links">
          <a href="https://llm-ide.com/guide.html">Guide</a>
          <a href="https://accounts.llm-ide.com/">Account</a>
        </nav>
      </header>

      <div className="web-auth-grid">
        <section className="web-pitch" aria-labelledby="web-pitch-title">
          <p className="web-kicker">Local-first workspace</p>
          <h1 id="web-pitch-title">Your project.<br />In your browser.</h1>
          <p className="web-sub">Your desktop holds the project and runs the AI. This browser is a companion for chat and approvals.</p>
          <div className="web-chips" aria-label="What this browser can use">
            <span>Project chat</span><span>Approvals</span><span>Meetings</span><span>Library</span>
          </div>
          <div className="web-trust">
            <span><i />Project data stays on your desktop</span>
            <span><i />No public copy of your workspace</span>
          </div>
        </section>

        <section className="web-panel" aria-labelledby="web-pair-title">
          <div className="web-panel-top"><span className="web-live" aria-hidden="true" />CONNECT DESKTOP <span className="web-step">PAIRING</span></div>
          <h2 id="web-pair-title">Pair this browser</h2>
          <p className="web-muted">Use a one-time PIN from the desktop app. The account at accounts.llm-ide.com is separate.</p>
          <form className="web-form" onSubmit={submit}>
            {revokedNotice && <StatusBanner severity="info" message={revokedNotice} />}
            {shown && <StatusBanner severity="error" message={shown} />}
            <label htmlFor={ids[0]}>Host address</label>
            <input id={ids[0]} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" spellCheck={false} />
            <p className="web-hint">Prefilled for this deployment. Advanced users can enter another wss:// address listed in LLMIDE_HOST_API_WEB_ORIGINS.</p>
            <label htmlFor={ids[1]}>Pairing PIN</label>
            <input id={ids[1]} className="web-pin" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required autoFocus placeholder="••••••" aria-describedby={ids[2]} />
            <p className="web-hint" id={ids[2]}>Six digits, shown under Settings → Host API pairing.</p>
            <button type="submit" disabled={busy}>{busy ? "Pairing…" : "Pair browser"}</button>
          </form>
          <details className="web-help">
            <summary>Where do I find the PIN?</summary>
            <p>In the desktop app: <strong>Settings → Host API pairing → Show PIN</strong>. The PIN expires quickly and is single-use.</p>
            <p>If pairing fails, check that the desktop is running the workspace with this page listed in <code>LLMIDE_HOST_API_WEB_ORIGINS</code>.</p>
          </details>
          <div className="web-account-line">
            <span>New to LLM-IDE?</span>
            <a href="https://accounts.llm-ide.com/">Create an account</a>
            <span aria-hidden="true">·</span>
            <a href="https://llm-ide.com/">What is LLM-IDE?</a>
          </div>
        </section>
      </div>

      {footer}
      <footer className="web-foot">
        <span>LLM-IDE web companion</span>
        <span>Project data stays local</span>
      </footer>
    </main>
  );
}
