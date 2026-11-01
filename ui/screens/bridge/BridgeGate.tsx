// Shared connection panel for the two Mac-backed screens. The desktop is a paired Mobile Control client, not a
// second automation engine: the PIN comes from the Mac's Settings → Mobile Control screen.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, ErrorText } from "../settings/ui.tsx";
import { macBridge, type BridgeSnapshot } from "./mac-bridge.ts";
import { shellBus } from "../shell/bus";

export function useMacBridge(): BridgeSnapshot {
  return useSyncExternalStore(macBridge.subscribe, macBridge.getSnapshot, macBridge.getSnapshot);
}

/** The Mac bridge is configured in Settings; pages only state that it is not connected. */
export function BridgeRequired({ children }: { children: (snap: BridgeSnapshot) => ReactNode }) {
  const snap = useMacBridge();
  useEffect(() => {
    if (macBridge.paired) macBridge.connect();
  }, []);
  if (snap.phase === "connected") return <>{children(snap)}</>;
  return (
    <div className="bridge-gate" role="status">
      <h2>Mac app not connected</h2>
      <p>Auto Tasks and Loop are controlled through the Mac app. Pair the bridge in Settings → Mobile Control, then return here.</p>
      <Button tone="primary" onClick={() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "mobile" })}>Open Settings → Mobile Control</Button>
      <ErrorText text={snap.error} />
    </div>
  );
}

export function BridgeGate({ children }: { children: (snap: BridgeSnapshot) => ReactNode }) {
  const snap = useMacBridge();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  // A paired desktop reconnects with its stored token; only the first pairing needs the PIN.
  useEffect(() => {
    if (macBridge.paired) macBridge.connect();
  }, []);

  if (snap.phase === "connected") {
    return (
      <div className="bridge-connected">
        <div className="bridge-status" role="status">
          <span className="bridge-dot" data-on="true" />
          <span>Mac bridge · {snap.deviceName ?? "LLM-IDE"}</span>
          <span className="bridge-spacer" />
          <button type="button" className="bridge-link" onClick={() => macBridge.refresh()}>Refresh</button>
          <button type="button" className="bridge-link" onClick={() => macBridge.forget()}>Forget pairing</button>
        </div>
        {children(snap)}
      </div>
    );
  }

  return (
    <div className="bridge-gate">
      <h2>Connect to the Mac app</h2>
      <p>
        Auto Tasks and Loop run in the Mac app. Keep it open, enable <strong>Settings → Mobile Control</strong>, and
        enter the six-digit PIN it shows.
      </p>
      <form
        className="bridge-pin"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          macBridge.connect(pin.trim());
          window.setTimeout(() => setBusy(false), 800);
        }}
      >
        <label className="st-field">
          <span className="st-label">Pairing PIN</span>
          <input
            className="st-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={pin}
            placeholder="000000"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
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
