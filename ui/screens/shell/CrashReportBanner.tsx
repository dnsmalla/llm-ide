// One-time "didn't close properly" notice at the top of the shell. Dismiss deletes the host's records; Copy
// details copies only the redacted record (see crash-report.ts). Plain text throughout.
import { useState } from "react";
import { copyCrashDetails, crashBannerMessage, type CrashNotice } from "./crash-report";

export function CrashReportBanner({ notice, onDismiss, copy }: { notice: CrashNotice; onDismiss: () => void; copy?: (text: string) => Promise<void> }) {
  const [status, setStatus] = useState("");
  const doCopy = async () => setStatus(await copyCrashDetails(notice, copy ?? ((t: string) => navigator.clipboard.writeText(t))));
  return (
    <div className="sh-notice sh-crash" role="status" data-testid="crash-notice">
      <p>{crashBannerMessage(notice.count)}</p>
      <span className="sh-crash-status" aria-live="polite">{status}</span>
      <button type="button" className="sh-button" onClick={() => void doCopy()}>Copy details</button>
      <button type="button" className="sh-button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
