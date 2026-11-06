// Settings → Phone and browser: pair the iPhone app and the web app with this desktop (Host API pairing PIN and QR,
// paired devices and revoke), and the offline sync they read while the desktop is off.
import type { ReactNode } from "react";
import HostApiPairing from "./HostApiPairing.tsx";
import SyncSection from "./SyncSection.tsx";

export default function MobileBridge(): ReactNode {
  return (
    <div className="st-stack">
      <HostApiPairing />
      <SyncSection />
    </div>
  );
}
