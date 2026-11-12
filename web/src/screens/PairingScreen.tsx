import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ORIGIN_HINT, originText, trustUrl } from "../host-api/connection.ts";
import { checkHostUrl, hostUrlHint } from "../host-api/url.ts";
import { ScanSheet } from "../pairing/Scanner.tsx";
import { candidateUrls, type PairingOffer } from "../pairing/qr.ts";
import { Badge, Banner, Button, Card, TextField, UiIcon } from "../ui/index.ts";

export interface PairingProps {
  initialUrl: string;
  busy: boolean;
  error: string | null;
  revokedNotice: string | null;
  onSubmit: (url: string, pin: string) => void;
  footer?: ReactNode;
}

const STEPS = [
  { title: "Open the desktop app", body: "Keep LLM-IDE running on the computer that holds your project." },
  { title: "Show the pairing PIN", body: "Settings → Host API pairing → Show PIN." },
  { title: "Enter it here", body: "This browser connects directly. Nothing is copied to a cloud account." },
] as const;

type Try = "waiting" | "trying" | "failed";
interface ScanRun { offer: PairingOffer; urls: string[]; i: number; started: boolean; tries: Try[]; done: boolean }
// A wrong or throttled PIN is final for the whole code; anything else (unreachable, closed) moves on to the next address.
const isFinal = (e: string) => /PIN|Too many attempts/i.test(e);

/** The first screen of the web client: what this browser is connecting to, where the PIN comes from, and one clear form. */
export function PairingScreen({ initialUrl, busy, error, revokedNotice, onSubmit, footer }: PairingProps) {
  const [url, setUrl] = useState(initialUrl);
  const [pin, setPin] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setRun(null);
    const u = checkHostUrl(url);
    if (!u.ok) { setUrlProblem(u.reason); setProblem(null); return; }
    setUrlProblem(null);
    if (!/^[0-9]{6}$/.test(pin)) return setProblem("The pairing PIN is six digits.");
    setProblem(null);
    onSubmit(u.url, pin);
    setPin("");
  };
  const [scanning, setScanning] = useState(false);
  const [run, setRun] = useState<ScanRun | null>(null);
  const sawBusy = useRef(false);
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const startScan = (offer: PairingOffer) => {
    const urls = candidateUrls(offer);
    sawBusy.current = false;
    setScanning(false); setProblem(null); setUrlProblem(null); setUrl(urls[0]!); setPin(offer.pin);
    setRun({ offer, urls, i: 0, started: false, tries: urls.map((_, k) => (k === 0 ? "trying" : "waiting")), done: false });
  };
  // Drives the candidates one at a time through the ordinary pairing attempt: the busy/error props report each outcome.
  useEffect(() => {
    if (!run || run.done) return;
    if (!run.started) { setRun({ ...run, started: true }); submitRef.current(run.urls[run.i]!, run.offer.pin); return; }
    if (busy) { sawBusy.current = true; return; }
    if (!sawBusy.current) return;
    sawBusy.current = false;
    if (!error) { setRun(null); return; } // paired: the app swaps this screen out
    const tries = run.tries.map((t, k) => (k === run.i ? "failed" : t)) as Try[];
    if (isFinal(error) || run.i + 1 >= run.urls.length) { setRun({ ...run, tries, done: true }); return; }
    tries[run.i + 1] = "trying";
    setRun({ ...run, tries, i: run.i + 1, started: false });
  }, [run, busy, error]);
  const trust = run?.done ? trustUrl(run.urls[0]) : null;
  const allFailed = run?.done === true && !isFinal(error ?? "");
  const shown = run && !allFailed ? (run.done ? error : null) : problem ?? error;
  return (
    <main className="web-auth">
      <header className="web-appbar">
        <a className="web-brand" href="https://llm-ide.com/" aria-label="LLM-IDE home"><span className="web-mark" aria-hidden="true" /><span>LLM-IDE</span><em>web</em></a>
        <div className="web-appbar-actions"><span className="web-private-pill">Private workspace</span><a className="web-quiet-link" href="https://llm-ide.com/guide.html">Guide</a></div>
      </header>

      <div className="web-connect">
        <section className="web-connect-copy" aria-labelledby="web-connect-title">
          <p className="web-kicker">Desktop companion</p>
          <h1 id="web-connect-title">Your workspace, in your pocket.</h1>
          <p className="web-sub">Connect this browser to your desktop for chat, approvals and read-only access to meetings, plans and library notes.</p>
          <ol className="web-steps" aria-label="How to connect">
            {STEPS.map((s, i) => (
              <li key={s.title}><span aria-hidden="true">{i + 1}</span><div><strong>{s.title}</strong><p>{s.body}</p></div></li>
            ))}
          </ol>
          <div className="web-trust"><span><UiIcon name="shield-check" size={16} />Project data stays on your desktop</span><span><UiIcon name="key-round" size={16} />No account or cloud copy</span></div>
        </section>

        <section className="web-connect-panel" aria-labelledby="web-pair-title">
          <Card>
            <div className="web-panel-top"><span className="web-live" aria-hidden="true" />Connect desktop</div>
            <h2 id="web-pair-title" className="web-card-title">Pair this browser</h2>
            <p className="web-muted">Use the one-time PIN shown on your desktop. No account is needed.</p>
            <form className="web-stack" onSubmit={submit} noValidate>
              {revokedNotice && <Banner tone="info" title="Pair again">{revokedNotice}</Banner>}
              {run && (
                <ul className="pair-tries" aria-label="Addresses from the QR code" aria-live="polite">
                  {run.urls.map((u, k) => <li key={u}><span>{u}</span><Badge tone={run.tries[k] === "failed" ? "danger" : run.tries[k] === "trying" ? "accent" : undefined}>{run.tries[k] === "failed" ? "No answer" : run.tries[k] === "trying" ? "Trying…" : "Waiting"}</Badge></li>)}
                </ul>
              )}
              {allFailed && run && (
                <Banner tone="error" title="Could not reach the desktop">
                  None of the addresses in the code opened. {trust ? <>Open <a href={trust} target="_blank" rel="noopener noreferrer">{trust}</a> in this browser, check that the certificate fingerprint is <span className="pair-fp">{run.offer.fingerprint}</span>, trust it, then scan again.</> : null} {ORIGIN_HINT} {originText(globalThis.location?.origin)}
                </Banner>
              )}
              {shown && <Banner tone="error" title="Could not pair">{shown}</Banner>}
              <Button type="button" variant="secondary" block onClick={() => setScanning(true)} disabled={busy}>Scan the pairing QR</Button>
              <TextField label="Hub or desktop address" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" spellCheck={false} inputMode="url" error={urlProblem} hint={hostUrlHint()} />
              <TextField label="Pairing PIN" className="web-pin" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required autoFocus placeholder="••••••" hint="Six digits from Settings → Host API pairing." />
              <Button type="submit" variant="primary" size="lg" block loading={busy}>{busy ? "Pairing…" : "Pair browser"}</Button>
            </form>
            <ScanSheet open={scanning} onClose={() => setScanning(false)} onOffer={startScan} />
            <details className="web-help">
              <summary>Connection help</summary>
              <p>If pairing fails, check that the desktop is running and lists this page's address in <code>LLMIDE_HOST_API_WEB_ORIGINS</code>.</p>
              <p>For read-only access while the desktop is off, use the sync-link form below.</p>
            </details>
            <p className="web-account-line"><a href="https://llm-ide.com/">What is LLM-IDE?</a></p>
          </Card>
        </section>
      </div>

      {footer && <div className="web-auth-extra">{footer}</div>}
      <footer className="web-foot">
        <span>LLM-IDE web companion</span>
        <span>Local-first · no account</span>
        <span className="web-foot-links"><a href="/app/privacy">Privacy</a><a href="/app/support">Support</a></span>
      </footer>
    </main>
  );
}
