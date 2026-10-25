// Used from T4+ (not rendered by the T3b shell yet).
import type { ReactNode } from "react";
import { AlertIcon, InfoIcon, XIcon } from "./icons";

export type Severity = "error" | "info" | "warning";

interface Props {
  severity: Severity;
  message: ReactNode;
  onDismiss?: () => void;
}

/** Inline message with severity tint (Mac StatusBanner). */
export function StatusBanner({ severity, message, onDismiss }: Props) {
  return (
    <div className="ui-banner" data-severity={severity} role={severity === "error" ? "alert" : "status"}>
      <span className="ui-banner-icon" aria-hidden="true">
        {severity === "info" ? <InfoIcon /> : <AlertIcon />}
      </span>
      <span className="ui-banner-message">{message}</span>
      {onDismiss && (
        <button type="button" className="ui-icon-button ui-banner-dismiss" aria-label="Dismiss message" title="Dismiss" onClick={onDismiss}>
          <XIcon />
        </button>
      )}
    </div>
  );
}
