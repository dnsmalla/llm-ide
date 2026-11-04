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
