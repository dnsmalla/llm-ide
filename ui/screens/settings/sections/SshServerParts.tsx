// Settings → Server & Backend → SSH server: the small parts of the card. Presentational only; the host answers live in
// SshServerModel. Each confirmation is an inline dialog that closes itself before its action runs, so nothing waits on it.
import { useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Button, Field } from "../ui.tsx";
import type { SshServerTest } from "../host.ts";
import { uninstallConfirmed } from "../ssh-server-model.ts";

export const CHANGED_KEY_TEXT = "This server's key is different from the one you trusted before. Only continue if you know why it changed.";
export const CLAUDE_MISSING_TEXT = 'Claude is not installed on this server. Sign in to the server and run "claude login" after installing it.';

/** The host key to compare with the server's own, and the one button that trusts it. */
export function FingerprintBlock({ test, busy, onTrust }: { test: SshServerTest; busy: boolean; onTrust: () => void }): ReactNode {
  return (
    <div className="st-note" role="group" aria-label="Host key">
      {test.changed ? <StatusBanner severity="warning" message={CHANGED_KEY_TEXT} /> : null}
      <span className="st-label">{test.hostKeyType}</span>
      <code className="st-pre" style={{ userSelect: "text", wordBreak: "break-all" }}>{test.fingerprint}</code>
      <p className="st-hint">Compare this fingerprint with the server&apos;s before you continue.</p>
      <div className="st-row">
        <Button tone="primary" disabled={busy} onClick={onTrust}>Trust this key</Button>
      </div>
    </div>
  );
}

/** What a trusted test found on the server: system, free disk, the installed server part and Claude. */
export function TestSummary({ test }: { test: SshServerTest }): ReactNode {
  const system = [test.os, test.arch].filter((part) => part !== null && part.length > 0).join(" ") || "Unknown system";
  const disk = test.freeMb === null ? "Free disk unknown" : `${Math.floor(test.freeMb / 1024)} GB free`;
  return (
    <div className="st-note" role="status" aria-label="Server check">
      <p className="st-ok">{system}</p>
      <p className="st-hint">{disk}</p>
      <p className="st-hint">{test.installedVersion ? `Server part: version ${test.installedVersion}` : "Server part: not installed yet"}</p>
      {test.claude === "missing" ? <StatusBanner severity="warning" message={CLAUDE_MISSING_TEXT} /> : null}
      {test.claude !== null && test.claude !== "missing" ? <p className="st-hint">{`Claude: ${test.claude}`}</p> : null}
    </div>
  );
}

/** Stop server: names the host and what stops. Stopping the core does not remove anything. */
export function StopConfirm({ host, busy, onConfirm, onCancel }: { host: string; busy: boolean; onConfirm: () => void; onCancel: () => void }): ReactNode {
  return (
    <div className="st-dialog" role="alertdialog" aria-label="Stop the server part">
      <p>{`Stop the server part on ${host}? Running work on the server stops.`}</p>
      <div className="st-row">
        <Button tone="danger" disabled={busy} onClick={onConfirm}>Stop</Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** Uninstall: the user types the host name; the action stays disabled until it matches (trimmed, case-insensitive). */
export function UninstallConfirm({ host, busy, onConfirm, onCancel }: { host: string; busy: boolean; onConfirm: (typed: string) => void; onCancel: () => void }): ReactNode {
  const [typed, setTyped] = useState("");
  const ready = uninstallConfirmed(typed, host);
  return (
    <div className="st-dialog" role="alertdialog" aria-label="Uninstall the server part">
      <p>{`This removes the server part from ${host}. Your data on the server is kept.`}</p>
      <Field label="Type the host name to confirm">
        <input className="st-input" value={typed} onChange={(e) => setTyped(e.currentTarget.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <div className="st-row">
        {/* The guard is in the handler too, not only the disabled attribute: the typed name is what the model checks. */}
        <Button tone="danger" disabled={!ready || busy} onClick={() => { if (ready) onConfirm(typed); }}>Uninstall</Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
