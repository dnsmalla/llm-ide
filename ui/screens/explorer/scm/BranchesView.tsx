// Branches tab: local branches (switch, create, delete), local tags (list and create) and stashes (list, stash,
// apply, pop, drop). Every destructive step asks in a native host dialog too; the in-page steps only name it.
import { useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ScmController, ScmSnapshot } from "./controller";
import { branchNameError, displayLine, messageError, tagNameError } from "./model";

/** Local tags, newest first, with a small form to create one at HEAD (the Mac's "Create Tag…"). */
export function TagsList({ controller, snap }: { controller: ScmController; snap: ScmSnapshot }) {
  const t = snap.tags;
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const nameErr = name === "" ? null : tagNameError(name);
  const msgErr = messageError("tag", message);
  const busy = snap.busy !== null;
  return (
    <section className="scm-tags" aria-labelledby="scm-tags-title">
      <h3 id="scm-tags-title" className="scm-subtitle">Tags</h3>
      <form
        className="scm-newtag"
        aria-label="New tag"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nameErr && !msgErr && name && !busy) void controller.createTag(name, message).then((ok) => { if (ok) { setName(""); setMessage(""); } });
        }}
      >
        <input className="scm-input" aria-label="New tag name" aria-invalid={nameErr ? true : undefined} aria-describedby="scm-tag-help" placeholder="Tag name, for example v1.0" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="scm-input" aria-label="Tag message (optional)" aria-invalid={msgErr ? true : undefined} aria-describedby="scm-tag-help" placeholder="Message (optional, makes an annotated tag)" value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="scm-commit-row">
          <button type="submit" className="ex-btn" aria-label="Create tag" disabled={!name || !!nameErr || !!msgErr || busy}>Create tag</button>
          <span id="scm-tag-help" className="scm-help">{nameErr ?? msgErr ?? "Created at the current commit (HEAD). A message makes it annotated, with your git identity as the tagger."}</span>
        </div>
      </form>
      {t.error && <StatusBanner severity="error" message={`${t.error.title}. ${t.error.detail}`} />}
      {t.loading && t.list.length === 0 && <div className="scm-empty" role="status">Loading tags</div>}
      {!t.loading && !t.error && t.list.length === 0 && <div className="scm-empty">No tags yet.</div>}
      <ul className="scm-tag-list" aria-label="Local tags">
        {t.list.map((tag) => (
          <li key={tag.name} className="scm-tag-item">
            <span className="scm-name">{displayLine(tag.name)}</span>
            <span className="scm-meta">{`${tag.target}${tag.annotated ? " · annotated" : " · lightweight"}`}</span>
          </li>
        ))}
      </ul>
      {t.truncated && <StatusBanner severity="info" message="Showing the 500 newest tags." />}
    </section>
  );
}

/** Stash entries with stash-changes form, plus apply, pop and drop per entry. Drop asks in the page first. */
export function StashList({ controller, snap }: { controller: ScmController; snap: ScmSnapshot }) {
  const s = snap.stashes;
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(true);
  const msgErr = messageError("stash", message);
  const busy = snap.busy !== null;
  const drop = snap.pendingStashDrop;
  return (
    <section className="scm-stash" aria-labelledby="scm-stash-title">
      <h3 id="scm-stash-title" className="scm-subtitle">Stash</h3>
      <form
        className="scm-newtag"
        aria-label="Stash changes"
        onSubmit={(e) => {
          e.preventDefault();
          if (!msgErr && !busy) void controller.stashChanges(message, untracked).then((ok) => ok && setMessage(""));
        }}
      >
        <input className="scm-input" aria-label="Stash message (optional)" aria-invalid={msgErr ? true : undefined} placeholder="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        <label className="scm-help">
          <input type="checkbox" aria-label="Include untracked files" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} /> Include untracked files
        </label>
        <div className="scm-commit-row">
          <button type="submit" className="ex-btn" aria-label="Stash changes" disabled={!!msgErr || busy}>Stash changes</button>
          <span className="scm-help">{msgErr ?? "Stashes your uncommitted changes and leaves the working tree clean."}</span>
        </div>
      </form>
      {s.error && <StatusBanner severity="error" message={`${s.error.title}. ${s.error.detail}`} />}
      {s.loading && s.list.length === 0 && <div className="scm-empty" role="status">Loading stashes</div>}
      {!s.loading && !s.error && s.list.length === 0 && <div className="scm-empty">No stashes.</div>}
      {drop && (
        <div className="scm-confirm" role="alert">
          <p>{`Drop the stash “${displayLine(drop.message)}”? Its changes are removed from the list and cannot be recovered from LLM-IDE.`}</p>
          <div className="scm-commit-row">
            <button type="button" className="ex-btn" aria-label={`Drop stash ${drop.index} now`} disabled={busy} onClick={() => void controller.dropStash()}>Drop stash</button>
            <button type="button" className="ex-tool" aria-label="Keep stash" onClick={() => controller.cancelDropStash()}>Keep it</button>
          </div>
        </div>
      )}
      <ul className="scm-stash-list" aria-label="Stashes">
        {s.list.map((st) => (
          <li key={st.hash} className="scm-stash-item">
            <span className="scm-name">{displayLine(st.message)}</span>
            <span className="scm-meta">{`stash ${st.index}`}</span>
            <div className="scm-commit-row">
              <button type="button" className="ex-tool" aria-label={`Apply stash ${st.index}`} disabled={busy} onClick={() => void controller.applyStash(st)}>Apply</button>
              <button type="button" className="ex-tool" aria-label={`Pop stash ${st.index}`} disabled={busy} onClick={() => void controller.popStash(st)}>Pop</button>
              <button type="button" className="ex-tool" aria-label={`Drop stash ${st.index}`} disabled={busy} onClick={() => controller.askDropStash(st)}>Drop</button>
            </div>
          </li>
        ))}
      </ul>
      {s.truncated && <StatusBanner severity="info" message="Showing the 100 newest stashes." />}
    </section>
  );
}

export function BranchesView({ controller, snap }: { controller: ScmController; snap: ScmSnapshot }) {
  const b = snap.branches;
  const [name, setName] = useState("");
  const err = name === "" ? null : branchNameError(name);
  const busy = snap.busy !== null;
  const dirty = snap.counts.staged + snap.counts.changes;
  const pending = snap.pendingBranchDelete;
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
          <li key={br.name} className="scm-branch-row">
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
            {!br.current && (
              <>
                <button type="button" className="ex-tool scm-merge" aria-label={`Merge ${displayLine(br.name)} into current branch`} disabled={busy} onClick={() => void controller.mergeBranch(br.name)}>
                  Merge into current
                </button>
                <button type="button" className="ex-tool scm-delete" aria-label={`Delete ${displayLine(br.name)}`} disabled={busy} onClick={() => void controller.deleteBranch(br.name)}>
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {pending && (
        <div className="scm-confirm" role="alert">
          <p>{`Branch “${displayLine(pending.name)}” has commits that are not merged, so Git kept it. Nothing was deleted.`}</p>
          <div className="scm-commit-row">
            <button
              type="button"
              className="ex-btn"
              aria-label={`Delete anyway ${displayLine(pending.name)}`}
              disabled={busy}
              onClick={() => void controller.forceDeleteBranch()}
            >
              {`Delete anyway (loses ${pending.unique} ${pending.unique === 1 ? "commit" : "commits"} not on any other branch)`}
            </button>
            <button type="button" className="ex-tool" aria-label={`Keep branch ${displayLine(pending.name)}`} onClick={() => controller.cancelBranchDelete()}>
              Keep branch
            </button>
          </div>
        </div>
      )}
      {b.truncated && <StatusBanner severity="info" message="Showing the 500 most recently updated branches." />}
      <TagsList controller={controller} snap={snap} />
      <StashList controller={controller} snap={snap} />
    </div>
  );
}
