// Settings → Server & Backend → Remote server → Deploy (Phase 2). The host owns SSH, the secret
// env file and the health check; this card only shows the plan, the blockers and the typed-domain
// confirmation. No secret is ever rendered or stored here.
import { type ReactNode } from "react";
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
          <p>{s.report.rolledBack ? `Deploy failed at ${s.report.failedStage ?? "a stage"}; the previous release was restored.` : `Hub is live at ${s.report.url} (API ${s.report.apiVersion}).`}</p>
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
    </div>
  );
}
