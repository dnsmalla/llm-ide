import type { ReactNode } from "react";

/** A non-modal confirmation panel (alertdialog) that names what changes. The caller supplies the body and the
 *  button row as children; `className` adds classes beside `st-dialog`. */
export function InlineConfirm({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `st-dialog ${className}` : "st-dialog"} role="alertdialog" aria-label={label}>
      {children}
    </div>
  );
}
