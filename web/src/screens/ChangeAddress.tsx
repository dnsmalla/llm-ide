import { useState } from "react";
import { Banner, Button, Sheet, TextField } from "../ui/index.ts";

/** Reconnect the paired desktop at a new wss address; opens a sheet. Resolves to an error text or null (the existing contract). */
export function ChangeAddress({ onSubmit, variant = "secondary" }: { onSubmit: (url: string) => Promise<string | null>; variant?: "secondary" | "ghost" }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!busy) { setOpen(false); setError(null); } };
  const submit = async () => {
    setBusy(true); setError(null);
    const err = await onSubmit(url);
    setBusy(false);
    if (err) setError(err); else { setOpen(false); setUrl(""); }
  };
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>Change address</Button>
      <Sheet open={open} onClose={close} title="Change address" dismissible={!busy}
        footer={<><Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form="web-change-address" loading={busy} disabled={!url.trim()}>{busy ? "Connecting…" : "Connect"}</Button></>}>
        <form id="web-change-address" className="web-stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <TextField label="New address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://host:port/host-api/v1" disabled={busy} autoComplete="off" spellCheck={false} inputMode="url"
            hint="Kept signed in only if the desktop there is the same one; otherwise you pair again with a PIN." />
          {error && <Banner tone="error">{error}</Banner>}
        </form>
      </Sheet>
    </>
  );
}
