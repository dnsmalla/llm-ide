// Settings → Server & Backend → Remote server → Deploy (Phase 2). The host owns SSH, the secret
// env file and the health check; this card only shows the plan, the blockers and the typed-domain
// confirmation. No secret is ever rendered or stored here.
import { useState, type ReactNode } from "react";
import { useEnv, useModel, useStore } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";
import type { RemoteServerConfig } from "../host.ts";
import { canDeploy, deployReady, RemoteDeployModel, type DeployIo } from "../remote-deploy-model.ts";

export default function RemoteDeployCard({ config }: { config: RemoteServerConfig }): ReactNode {
  const { host } = useEnv();
  const available = Boolean(host.remoteDeployPlan && host.remoteDeployBootstrap && host.remoteDeployRun && host.remoteDeployLock && host.remoteDeployRollback);
  const m = useModel(() => new RemoteDeployModel({
    plan: (t, d, a) => host.remoteDeployPlan!(t, d, a),
    bootstrap: (t) => host.remoteDeployBootstrap!(t),
    run: (t, id, c) => host.remoteDeployRun!(t, id, c),
    lock: (t) => host.remoteDeployLock!(t),
    rollback: (t) => host.remoteDeployRollback!(t),
  } as DeployIo, () => config));
  const s = useStore(m);
  const [version, setVersion] = useState("");
  const [updateConfirm, setUpdateConfirm] = useState("");
  const [ops, setOps] = useState<{ busy: string | null; note: string | null; error: string | null; logs: string; diag: string }>({ busy: null, note: null, error: null, logs: "", diag: "" });
  const target = { host: config.host.trim(), port: config.port, user: config.user.trim(), keyPath: config.keyPath.trim() };
  const run = async (what: "update" | "backup" | "logs" | "diag" | "uninstall", purge = false) => {
    setOps({ busy: what, note: null, error: null, logs: ops.logs, diag: ops.diag });
    try {
      if (what === "update") { if (!host.remoteUpdate) throw new Error("Update needs the desktop host."); await host.remoteUpdate(target, version, updateConfirm, config.hubUrl); }
      else if (what === "backup") { if (!host.remoteBackupNow) throw new Error("Backup needs the desktop host."); await host.remoteBackupNow(target); }
      else if (what === "diag") { if (!host.remoteDiagnostics) throw new Error("Diagnostics need the desktop host."); const d = await host.remoteDiagnostics(target); setOps({ busy: null, note: null, error: null, logs: ops.logs, diag: `service ${d.service}; disk ${d.diskFreeMb} MB; version ${d.version ?? "?"}; last backup ${d.lastBackup ?? "none"}${typeof d.lastBackupAgeSec === "number" ? ` (${Math.round(d.lastBackupAgeSec / 3600)} h ago)` : ""}; health ${d.health ?? "unreachable"}` }); return; }
      else if (what === "logs") { if (!host.remoteLogs) throw new Error("Logs need the desktop host."); setOps({ busy: null, note: null, error: null, logs: await host.remoteLogs(target, 200), diag: ops.diag }); return; }
      else {
        if (!host.remoteUninstall) throw new Error("Uninstall needs the desktop host.");
        const typed = globalThis.prompt?.(`Type ${config.host} to uninstall the hub (data is kept).`) ?? null;
        if (typed === null) { setOps({ busy: null, note: null, error: null, logs: ops.logs, diag: ops.diag }); return; }
        if (typed !== config.host) throw new Error("The hostname did not match; nothing was removed.");
        await host.remoteUninstall(target, typed, purge);
      }
      setOps({ busy: null, note: what === "update" ? `Updated to ${version}.` : what === "backup" ? "Backup started." : "Hub removed; data kept.", error: null, logs: ops.logs, diag: ops.diag });
    } catch (e) { setOps({ busy: null, note: null, error: e instanceof Error ? e.message : "The operation failed.", logs: ops.logs, diag: ops.diag }); }
  };
  if (!available) return <p className="st-hint">Deploy needs the desktop host.</p>;
  if (!deployReady(config)) return <p className="st-hint">Enter and save the host, SSH user and private key path first.</p>;

  return (
    <div className="st-note" role="group" aria-label="Deploy the hub">
      <span className="st-label">Deploy the hub</span>
      <p className="st-hint">The deploy creates a service user, installs the pinned Linux core and a systemd unit, writes the secret env file over stdin, and starts nginx/TLS. It affects the server; nothing is written until you confirm.</p>
      <label className="st-field">
        <span className="st-label">Hub domain</span>
        <input className="st-input" value={s.domain} onChange={(e) => m.setDomain(e.currentTarget.value)} placeholder="hub.example.com" spellCheck={false} />
        <span className="st-hint">The certificate must already exist for this name (certbot).</span>
      </label>
      <label className="st-row">
        <input type="checkbox" checked={s.reviewAck} onChange={(e) => m.setReviewAck(e.currentTarget.checked)} />
        <span>External security review completed or explicitly accepted for this public hub</span>
      </label>
      <div className="st-row">
        <Button disabled={s.phase === "planning" || s.phase === "deploying" || !s.reviewAck} onClick={() => void m.preflight()}>{s.phase === "planning" ? "Checking…" : "Run preflight"}</Button>
        <Button disabled={s.phase === "bootstrapping" || s.phase === "deploying"} onClick={() => void m.bootstrapHelper()}>{s.phase === "bootstrapping" ? "Installing…" : "Install helper"}</Button>
      </div>
      {s.bootstrap && !s.bootstrap.installed ? <p className="st-hint" role="alert">{s.bootstrap.command}</p> : null}
      {s.plan ? (
        <div className="st-stack">
          <p className="st-hint">Plan {s.plan.version} on {s.plan.arch}. {s.plan.blockers.length ? `Blockers: ${s.plan.blockers.join(", ")}.` : "No blockers."}</p>
          {s.plan.warnings.length ? <p className="st-hint">Warnings: {s.plan.warnings.join(", ")}.</p> : null}
          <ol className="st-hint">{s.plan.stages.map((st) => <li key={st.id}>{st.title} — {st.detail}</li>)}</ol>
          <label className="st-field">
            <span className="st-label">Type {s.plan.confirmation} to confirm</span>
            <input className="st-input" value={s.confirmation} onChange={(e) => m.setConfirmation(e.currentTarget.value)} spellCheck={false} />
          </label>
          <div className="st-row">
            <Button tone="primary" disabled={!canDeploy(s)} onClick={() => void m.deploy()}>{s.phase === "deploying" ? "Deploying…" : "Deploy"}</Button>
            <Button disabled={s.phase === "deploying"} onClick={() => void m.rollback()}>Roll back</Button>
          </div>
        </div>
      ) : null}
      {s.report ? (
        <div className="st-note" role="status">
          <p>{s.report.failedStage
            ? `Deploy failed at ${s.report.failedStage}; ${s.report.rolledBack ? "the previous release was restored." : "nothing was restored (first install)."}`
            : `Hub is live at ${s.report.url} (API ${s.report.apiVersion}).`}</p>
          {s.report.ownerWindowOpen && s.report.setupUrl ? (
            <>
              <p className="st-hint">Create the owner in this one-time window:</p>
              <p className="st-pre" style={{ userSelect: "text", wordBreak: "break-all" }}>{s.report.setupUrl}</p>
              <div className="st-row">
                <Button onClick={() => void host.copyText(s.report!.setupUrl!)}>Copy setup link</Button>
                <Button tone="primary" onClick={() => void m.lockRegistration()}>I created the owner — close registration</Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <ErrorText text={s.error} />
      <div className="st-note">
        <span className="st-label">Operations</span>
        <div className="st-row">
          <input className="st-input" value={version} onChange={(e) => setVersion(e.currentTarget.value)} placeholder="Hub version (x.y.z)" />
          <input className="st-input" value={updateConfirm} onChange={(e) => setUpdateConfirm(e.currentTarget.value)} placeholder={`Type ${config.host} to update`} />
          <Button disabled={ops.busy !== null || !version.trim() || updateConfirm !== config.host} onClick={() => void run("update")}>{ops.busy === "update" ? "Updating…" : "Update hub"}</Button>
        </div>
        <div className="st-row">
          <Button disabled={ops.busy !== null} onClick={() => void run("backup")}>{ops.busy === "backup" ? "Backing up…" : "Backup now"}</Button>
          <Button disabled={ops.busy !== null} onClick={() => void run("logs")}>{ops.busy === "logs" ? "Reading…" : "Show logs"}</Button>
          <Button disabled={ops.busy !== null} onClick={() => void run("diag")}>{ops.busy === "diag" ? "Checking…" : "Diagnostics"}</Button>
          <Button tone="danger" disabled={ops.busy !== null} onClick={() => void run("uninstall")}>{ops.busy === "uninstall" ? "Removing…" : "Uninstall…"}</Button>
        </div>
        {ops.note ? <p className="st-ok" role="status">{ops.note}</p> : null}
        <ErrorText text={ops.error} />
        {ops.diag ? <p className="st-hint" role="status">{ops.diag}</p> : null}
        {ops.logs ? <pre className="st-log" aria-label="Hub logs">{ops.logs}</pre> : null}
      </div>
    </div>
  );
}
