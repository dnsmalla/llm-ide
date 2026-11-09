// Work-item picker for a Factory loop (spec A3): an issue from GET /kb/issues, a spec under llm-doc/, or free text.
// The choice becomes .factory/TASK.md (factory.ts taskMarkdown) in a new worktree of the chosen repository.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { FsApi } from "../../explorer/fs";
import { core } from "../../shell/runtime";
import { readRepoConfig } from "../../settings/repo-config.ts";
import { listSpecFiles, pickerIssues, repoForIssue, workItemFromIssue, workItemFromSpec, workItemFromText, type PickerIssue, type WorkItem } from "./factory.ts";
import { repoPrefixFor } from "./worktree-run.ts";

type Source = "issue" | "spec" | "text";

interface Props {
  fs: Pick<FsApi, "list" | "read">;
  projectRoot: string;
  workRoot: string | null;
  onCancel(): void;
  onStart(item: WorkItem, repoRel: string): void;
}

export function FactoryPicker({ fs, projectRoot, workRoot, onCancel, onStart }: Props): ReactNode {
  const defaultRepo = workRoot === projectRoot ? "" : repoPrefixFor(projectRoot, workRoot ?? "");
  const [source, setSource] = useState<Source>("issue");
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [issues, setIssues] = useState<PickerIssue[] | null>(null);
  const [issueId, setIssueId] = useState("");
  const [specs, setSpecs] = useState<string[] | null>(null);
  const [specPath, setSpecPath] = useState("");
  const [text, setText] = useState("");
  const [repos, setRepos] = useState<string[]>([defaultRepo]);
  const [repoRel, setRepoRel] = useState(defaultRepo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = useMemo(() => readRepoConfig().saved, []);

  useEffect(() => {
    if (source !== "issue") return undefined;
    let live = true;
    setIssues(null);
    void core.request<unknown>(`/kb/issues?provider=${provider}&state=open&limit=100`)
      .then((b) => { if (live) setIssues(pickerIssues(b)); })
      .catch((e: unknown) => { if (live) { setIssues([]); setError(e instanceof Error ? e.message : "The issues could not be loaded."); } });
    return () => { live = false; };
  }, [source, provider]);

  useEffect(() => {
    if (source !== "spec" || specs !== null) return undefined;
    let live = true;
    void listSpecFiles(fs).then((s) => { if (live) setSpecs(s); }).catch(() => { if (live) setSpecs([]); });
    return () => { live = false; };
  }, [source, specs, fs]);

  useEffect(() => {
    let live = true;
    void fs.list("code")
      .then((r) => r.entries.filter((e) => e.kind === "dir" && !e.name.startsWith(".")).map((e) => `code/${e.name}`))
      .catch(() => [] as string[])
      .then((dirs) => { if (live) setRepos((prev) => [...new Set([...prev, ...(workRoot === projectRoot ? [""] : []), ...dirs])]); });
    return () => { live = false; };
  }, [fs, projectRoot, workRoot]);

  const pickIssue = (id: string) => {
    setIssueId(id);
    const issue = issues?.find((i) => i.id === id);
    const mapped = issue ? repoForIssue(issue, saved, projectRoot) : null;
    if (mapped !== null) {
      setRepos((r) => (r.includes(mapped) ? r : [...r, mapped]));
      setRepoRel(mapped);
    }
  };

  const start = async () => {
    setError(null);
    let item: WorkItem | null = null;
    if (source === "issue") {
      const issue = issues?.find((i) => i.id === issueId);
      if (!issue) { setError("Pick an issue."); return; }
      item = workItemFromIssue(issue);
    } else if (source === "spec") {
      if (!specPath) { setError("Pick a spec."); return; }
      setBusy(true);
      try {
        const r = await fs.read(specPath, 400_000);
        if (r.status === "ok" && r.text !== null) item = workItemFromSpec(specPath, r.text);
        else setError("That file is not readable text.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "The spec could not be read.");
      } finally { setBusy(false); }
    } else if (text.trim()) {
      item = workItemFromText(text);
    } else {
      setError("Describe the work first.");
    }
    if (item) onStart(item, repoRel);
  };

  return (
    <section className="loop-card" aria-label="Pick a work item">
      <h2>WORK ITEM</h2>
      <p className="loop-native-hint">The Factory runs one work item in its own worktree. Its text is saved as .factory/TASK.md and treated as data, not instructions.</p>
      {error ? <StatusBanner severity="error" message={error} onDismiss={() => setError(null)} /> : null}
      <label className="loop-field"><span>Source</span><select value={source} onChange={(e) => { setSource(e.target.value as Source); setError(null); }}><option value="issue">Issue</option><option value="spec">Spec in llm-doc/</option><option value="text">Free text</option></select></label>
      {source === "issue" ? <>
        <label className="loop-field"><span>Provider</span><select value={provider} onChange={(e) => { setProvider(e.target.value as "github" | "gitlab"); setIssueId(""); }}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label>
        {issues === null ? <p className="loop-native-hint" role="status">Loading issues…</p>
          : issues.length === 0 ? <p className="loop-native-hint">No open issues. Import them on the Issues screen first.</p>
          : <label className="loop-field"><span>Issue</span><select value={issueId} onChange={(e) => pickIssue(e.target.value)}><option value="">Choose…</option>{issues.map((i) => <option key={i.id} value={i.id}>{i.number !== null ? `#${i.number} ` : ""}{i.title}{i.repo ? ` · ${i.repo}` : ""}</option>)}</select></label>}
      </> : null}
      {source === "spec" ? (specs === null ? <p className="loop-native-hint" role="status">Listing llm-doc/…</p>
        : specs.length === 0 ? <p className="loop-native-hint">No Markdown files under llm-doc/.</p>
        : <label className="loop-field"><span>Spec</span><select value={specPath} onChange={(e) => setSpecPath(e.target.value)}><option value="">Choose…</option>{specs.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>) : null}
      {source === "text" ? <label className="loop-field"><span>What should change?</span><textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} /></label> : null}
      <label className="loop-field"><span>Repository</span><select value={repoRel} onChange={(e) => setRepoRel(e.target.value)}>{repos.map((r) => <option key={r} value={r}>{r === "" ? "(project root)" : r}</option>)}</select></label>
      <div className="loop-inline">
        <button type="button" className="loop-btn loop-btn-primary" disabled={busy} onClick={() => void start()}>Start run</button>
        <button type="button" className="loop-btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
