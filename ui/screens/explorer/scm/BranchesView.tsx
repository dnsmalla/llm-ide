// Branches tab: local branches, switch (native confirmation host-side) and create.
import { useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ScmController, ScmSnapshot } from "./controller";
import { branchNameError, displayLine } from "./model";

export function BranchesView({ controller, snap }: { controller: ScmController; snap: ScmSnapshot }) {
  const b = snap.branches;
  const [name, setName] = useState("");
  const err = name === "" ? null : branchNameError(name);
  const busy = snap.busy !== null;
  const dirty = snap.counts.staged + snap.counts.changes;
  return (
    <div className="scm-branches">
      <form
        className="scm-newbranch"
        aria-label="Create branch"
        onSubmit={(e) => {
          e.preventDefault();
          if (!err && name && !busy) void controller.createBranch(name).then((ok) => ok && setName(""));
        }}
      >
        <input className="scm-input" aria-label="New branch name" aria-invalid={err ? true : undefined} aria-describedby="scm-branch-help" placeholder="New branch name (from the current commit)" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="ex-btn" disabled={!name || !!err || busy}>Create and switch</button>
        <span id="scm-branch-help" className="scm-help">{err ?? (dirty > 0 ? "Your uncommitted changes come along." : "")}</span>
      </form>
      {b.error && <StatusBanner severity="error" message={`${b.error.title}. ${b.error.detail}`} />}
      {b.loading && b.list.length === 0 && <div className="scm-empty" role="status">Loading branches</div>}
      {!b.loading && !b.error && b.list.length === 0 && <div className="scm-empty">No branches yet. Commit to create the first one.</div>}
      <ul className="scm-branch-list" aria-label="Local branches">
        {b.list.map((br) => (
          <li key={br.name}>
            <button
              type="button"
              className="scm-branch-item"
              aria-current={br.current ? "true" : undefined}
              aria-label={`${displayLine(br.name)}${br.current ? ", current branch" : ""}`}
              disabled={br.current || busy}
              onClick={() => void controller.checkout(br.name)}
            >
              <span className="scm-name">{displayLine(br.name)}</span>
              <span className="scm-meta">{`${br.hash}${br.upstream ? ` · ${displayLine(br.upstream)}` : ""}`}</span>
              {br.current && <span className="ex-badge">current</span>}
            </button>
          </li>
        ))}
      </ul>
      {b.truncated && <StatusBanner severity="info" message="Showing the 500 most recently updated branches." />}
    </div>
  );
}
