// Settings → Mobile Control: the desktop's pairing with the Mac app's Mobile Control server. Auto Tasks and
// Loop are remote controls over this bridge; the PIN and the pairing lifecycle belong here, not on those pages.
import { useEffect, useState, type ReactNode } from "react";
import { useMacBridge } from "../../bridge/BridgeGate.tsx";
import { macBridge } from "../../bridge/mac-bridge.ts";
import { Button, ErrorText } from "../ui.tsx";
import HostApiPairing from "./HostApiPairing.tsx";
import SyncSection from "./SyncSection.tsx";

export default function MobileBridge(): ReactNode {
  return (
    <div className="st-stack">
      <MacBridge />
      <HostApiPairing />
      <SyncSection />
    </div>
  );
}

function MacBridge(): ReactNode {
  const snap = useMacBridge();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (macBridge.paired) macBridge.connect();
  }, []);

  if (snap.phase === "connected") {
    return (
      <div className="st-stack" role="group" aria-label="Mac app bridge">
        <p className="st-status" data-tone="ok">Connected to {snap.deviceName ?? "the Mac app"}</p>
        <p className="st-hint">Auto Tasks and Loop read and control the Mac app through this pairing. Nothing leaves this machine.</p>
        <div className="st-row">
          <Button onClick={() => macBridge.refresh()}>Refresh</Button>
          <Button tone="danger" onClick={() => macBridge.forget()}>Forget pairing</Button>
        </div>
        <ErrorText text={snap.error} />
      </div>
    );
  }

  return (
    <div className="st-stack" role="group" aria-label="Mac app bridge">
      <p className="st-hint">Auto Tasks and Loop run in the Mac app. Keep it open, enable <strong>Settings → Mobile Control</strong> there, and enter the six-digit PIN it shows.</p>
      <form className="st-row" onSubmit={(e) => { e.preventDefault(); setBusy(true); macBridge.connect(pin); window.setTimeout(() => setBusy(false), 800); }}>
        <label className="st-field st-grow">
          <span className="st-label">Pairing PIN</span>
          <input className="st-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={pin} placeholder="000000" onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        </label>
        <Button tone="primary" disabled={busy || pin.length !== 6} onClick={() => { setBusy(true); macBridge.connect(pin); window.setTimeout(() => setBusy(false), 800); }}>
          {snap.phase === "connecting" ? "Connecting…" : "Connect"}
        </Button>
      </form>
      <p className="st-hint">The desktop talks to ws://127.0.0.1:3006; nothing leaves this machine.</p>
      <ErrorText text={snap.error} />
    </div>
  );
}
