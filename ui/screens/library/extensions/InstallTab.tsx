// Install tab: a GitHub address and an optional folder. The core pins the commit and installs it OFF;
// nothing runs. The result shows owner/repo, the full pinned commit and the scan findings as warnings.
import type { ReactNode } from "react";
import type { ExtensionsModel, ExtensionsState } from "./model.ts";
import { kindLabel, repoName } from "./presentation.ts";
import { Badge, FindingList } from "./ui.tsx";

export function InstallTab({ model, state }: { model: ExtensionsModel; state: ExtensionsState }): ReactNode {
  const i = state.install;
  const last = i.last?.item;
  return (
    <div className="ext-install">
      <form
        className="ext-form"
        onSubmit={(e) => {
          e.preventDefault();
          void model.install();
        }}
        aria-label="Install from GitHub"
      >
        <div className="ext-field">
          <label htmlFor="ext-install-url">GitHub address</label>
          <input id="ext-install-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repo" maxLength={400} value={i.url} onChange={(e) => model.setInstallUrl(e.target.value)} aria-invalid={i.fieldError ? true : undefined} aria-describedby="ext-install-help" />
        </div>
        <div className="ext-field">
          <label htmlFor="ext-install-path">Folder inside the repository (optional)</label>
          <input id="ext-install-path" type="text" autoComplete="off" spellCheck={false} placeholder="skills/pdf" maxLength={400} value={i.path} onChange={(e) => model.setInstallPath(e.target.value)} />
        </div>
        <p id="ext-install-help" className="lib-muted">
          Only github.com repositories on your allowed list. The current commit is pinned and installed switched off; nothing runs at install and nothing is installed with it. Allow more sources in Settings under Extension sources.
        </p>
        {i.fieldError && (
          <p className="ext-inline-error" role="alert">
            {i.fieldError}
          </p>
        )}
        <div>
          <button type="submit" className="lib-btn lib-btn-primary" disabled={i.installing || state.catalogOff}>
            {i.installing ? "Installing…" : "Install"}
          </button>
        </div>
      </form>

      {last && (
        <section className="ext-result" aria-label="Installed">
          <h2>{last.name}</h2>
          <p className="lib-muted">{kindLabel(last.kind)}</p>
          <dl className="ext-facts">
            <dt>Repository</dt>
            <dd>
              {repoName(last.sourceUrl)}
              {last.subpath ? ` (folder ${last.subpath})` : ""}
            </dd>
            <dt>Pinned commit</dt>
            <dd>
              <code className="ext-commit">{last.pinnedCommit}</code>
            </dd>
            <dt>State</dt>
            <dd>
              <Badge tone={last.enabled ? "ok" : "neutral"}>{last.enabled ? "On" : "Off"}</Badge> {last.executableKinds.length > 0 && <Badge tone="warn">Runs code when switched on</Badge>}
            </dd>
          </dl>
          {last.scan.count > 0 ? (
            <>
              <p role="status">The scan found {last.scan.count} {last.scan.count === 1 ? "warning" : "warnings"}. Read them before you switch it on.</p>
              <FindingList findings={last.scan.findings} total={last.scan.count} />
            </>
          ) : (
            <p className="lib-muted">The scan found nothing to warn about. It is a heuristic, not a safety verdict.</p>
          )}
          <div className="ext-actions">
            <button
              type="button"
              className="lib-btn lib-btn-primary"
              onClick={() => {
                model.select(last.id);
                void model.showTab("installed");
              }}
            >
              Open in Installed
            </button>
            <button type="button" className="lib-btn" onClick={() => model.dismissLastInstall()}>
              Dismiss
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
