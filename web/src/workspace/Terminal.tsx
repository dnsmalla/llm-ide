// Allowlisted remote commands. The host refuses anything outside its list; this view only sends argv.
import { useState } from "react";
import type { HostLink } from "../host-api/connection.ts";
import { shellExec, terminalExec } from "./api.ts";
import { parseArgv, terminalReady } from "./model.ts";
import "./terminal.css";

const PRESETS = [
  ["git", "status", "--porcelain"], ["git", "diff"], ["git", "log", "--oneline", "-10"],
  ["ls"], ["pwd"], ["npm", "test"],
];

export function Terminal({ link, projectId, onClose }: { link: HostLink; projectId: string; onClose(): void }) {
  const [text, setText] = useState("git status --porcelain");
  const [output, setOutput] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shell, setShell] = useState(false);
  const argv = parseArgv(text);

  const run = async () => {
    if (busy) return;
    if (shell && !text.trim()) return;
    if (!shell && !terminalReady(argv, busy)) return;
    if (shell && !window.confirm(`Run this shell command on the host?\n\n${text}`)) return;
    setBusy(true); setError(null); setOutput(""); setExitCode(null);
    try {
      const out = shell ? await shellExec(link, projectId, text) : await terminalExec(link, projectId, argv);
      setOutput([out.stdout, out.stderr].filter(Boolean).join("\n"));
      setExitCode(out.exitCode);
      if (out.truncated) setError("Output was truncated at 256 KiB.");
      if (out.timedOut) setError("The command timed out after 30 seconds.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="term-pane">
      <header className="term-head">
        <strong>Terminal</strong>
        <span className="term-note">allowlisted commands · no shell</span>
        <button type="button" onClick={onClose}>Files</button>
      </header>
      <div className="term-presets">
        {PRESETS.map((p) => <button key={p.join(" ")} type="button" onClick={() => setText(p.join(" "))}>{p[0]} {p[1]}</button>)}
      </div>
      <label className="term-shell"><input type="checkbox" checked={shell} onChange={(e) => setShell(e.target.checked)} /> Full shell (host must enable LLMIDE_ALLOW_REMOTE_SHELL=1)</label>
      <div className="term-row">
        <input value={text} spellCheck={false} aria-label="Command" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run(); }} />
        <button type="button" disabled={busy || (shell ? !text.trim() : !terminalReady(argv, busy))} onClick={() => void run()}>{busy ? "Running…" : "Run"}</button>
      </div>
      {error ? <p className="ws-error" role="alert">{error}</p> : null}
      <pre className="term-out" aria-live="polite">{output || (exitCode === null ? "" : "(no output)")}</pre>
      {exitCode !== null ? <p className="term-exit">exit {exitCode}</p> : null}
    </div>
  );
}
