// Settings → Phone and browser, in two tabs so the two ways a phone or browser connects are never mixed:
//   Online  — live pairing with this desktop (Host API PIN and QR, paired devices, revoke); the desktop must be on.
//   Offline — encrypted sync storage the phone and web app read while the desktop is off.
import { useState, type ReactNode } from "react";
import HostApiPairing from "./HostApiPairing.tsx";
import SyncSection from "./SyncSection.tsx";

type Tab = "online" | "offline";
const TABS: readonly { id: Tab; label: string; hint: string }[] = [
  { id: "online", label: "Online", hint: "Chat, run tasks and start runs live, while this desktop is on." },
  { id: "offline", label: "Offline", hint: "Read your chats, meetings and plans from your own storage while this desktop is off." },
];

export default function MobileBridge(): ReactNode {
  const [tab, setTab] = useState<Tab>("online");
  const current = TABS.find((t) => t.id === tab)!;
  return (
    <div className="st-stack">
      <div className="st-tabs" role="tablist" aria-label="Phone and browser connection">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`mobile-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`mobile-pane-${t.id}`} className="st-tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`mobile-pane-${tab}`} aria-labelledby={`mobile-tab-${tab}`} className="st-stack">
        <p className="st-hint">{current.hint}</p>
        {tab === "online" ? <HostApiPairing /> : <SyncSection />}
      </div>
    </div>
  );
}
