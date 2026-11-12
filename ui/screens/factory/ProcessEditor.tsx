// Factory → Process: the project's system/factory-template.json in a plain editor. Every problem is shown with its line
// and Save stays off until there are none, so a saved template always runs. Reset fills in the default after showing
// what would change; nothing is written until Save.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { createHostFs } from "../explorer/fs";
import { TEMPLATE_FILE, defaultFactoryTemplate, formatFactoryTemplate, lineDiff, lineStart, parseFactoryTemplate, problemCountLabel, readTemplateFile } from "../loop/native/factory-template.ts";
import { loadOrCreateFactoryLoop } from "../loop/native/run-manager.ts";

const codeOf = (e: unknown): string => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");

export default function ProcessEditor({ active, projectRoot }: { active: boolean; projectRoot: string | null }): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [migration, setMigration] = useState<string | null>(null);
  const [spoken, setSpoken] = useState("");
  const area = useRef<HTMLTextAreaElement | null>(null);
  const resetOpener = useRef<HTMLButtonElement | null>(null);
  const resetFirst = useRef<HTMLButtonElement | null>(null);
  const wasResetOpen = useRef(false);
  const dirtyRef = useRef(false);
  const loadedRoot = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      let file = await readTemplateFile(fs);
      // A project that never ran the Factory has no template yet: the same helper a run uses writes it from the loop.
      if (file.kind === "missing") {
        // The migration writes the file even when it could not keep a step; its message must reach the person.
        try { await loadOrCreateFactoryLoop(fs); } catch (e) { setMigration(e instanceof Error ? e.message : String(e)); }
        file = await readTemplateFile(fs);
      }
      if (file.kind === "missing") { setLoadError("The Factory process could not be created: system/loop.json is missing or unreadable."); return; }
      setText(file.text);
      setSaved(file.text);
      setHash(file.hash);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [fs]);

  const parse = useMemo(() => parseFactoryTemplate(text), [text]);
  const errors = parse.ok ? [] : parse.errors;
  const dirty = saved !== null && text !== saved;
  dirtyRef.current = dirty;

  // Coming back to the tab re-reads the file, but never over unsaved text; another project always loads its own file.
  useEffect(() => {
    if (!active || !projectRoot) return;
    if (loadedRoot.current === projectRoot && dirtyRef.current) return;
    loadedRoot.current = projectRoot;
    void load();
  }, [active, projectRoot, load]);

  // Screen readers hear the number of problems once typing pauses, not the whole list on every keystroke.
  useEffect(() => {
    if (saved === null) return;
    const t = setTimeout(() => setSpoken(problemCountLabel(errors.length)), 700);
    return () => clearTimeout(t);
  }, [errors.length, saved]);

  useEffect(() => {
    if (confirmReset) { wasResetOpen.current = true; resetFirst.current?.focus(); }
    else if (wasResetOpen.current) { wasResetOpen.current = false; resetOpener.current?.focus(); }
  }, [confirmReset]);
  const defaultText = useMemo(() => formatFactoryTemplate(defaultFactoryTemplate()), []);

  const goToLine = (line: number) => {
    const el = area.current;
    if (!el) return;
    const at = lineStart(text, line);
    el.focus();
    el.setSelectionRange(at, at);
  };

  const save = async () => {
    if (!parse.ok || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await fs.write(TEMPLATE_FILE, text, { expected_hash: hash });
      setSaved(text);
      setHash(r.hash);
      setNotice("Saved. The next Factory run uses these steps.");
    } catch (e) {
      if (codeOf(e) === "conflict") {
        setNotice("The file changed on disk since it was opened, so it was reloaded. Make your change again.");
        await load();
      } else setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!projectRoot) return <p className="fx-empty">Open a project to edit its Factory process.</p>;
  return (
    <div className="fx-board-root fx-process">
      {migration ? <StatusBanner severity="warning" message={migration} /> : null}
      {loadError ? <StatusBanner severity="error" message={loadError} onDismiss={() => setLoadError(null)} /> : null}
      {notice ? <StatusBanner severity="info" message={notice} onDismiss={() => setNotice(null)} /> : null}
      <div className="fx-head">
        <span className="fx-hint">
          <code>{TEMPLATE_FILE}</code> · each step has a <code>role</code>: setup, intake, intakeGate, plan, implement, verify, review, reviewGate (fixed skills; change name, prompt, command, timeout) or custom (your own <code>shellCommand</code> — <code>"auto"</code> = the detected lint/TypeScript/Ruff check —, <code>skill</code> or <code>artifactCheck</code> verdict check). Add <code>{'{"role": "intake"}'}</code> and <code>{'{"role": "intakeGate"}'}</code> first to bring Intake back. implement, verify, review and reviewGate are required, stay blocking, come in that order, and reviewGate comes last.
        </span>
        <span className="fx-spacer" />
        <button type="button" ref={resetOpener} className="fx-btn" disabled={busy} onClick={() => setConfirmReset(true)}>Reset to default…</button>
        <button type="button" className="fx-btn" disabled={busy || !dirty} onClick={() => { if (saved !== null) setText(saved); }}>Revert</button>
        <button type="button" className="fx-btn fx-primary" disabled={busy || !dirty || !parse.ok} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </div>
      {confirmReset ? (
        <div className="fx-form fx-process-reset" role="alertdialog" aria-label="Reset to the default process" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirmReset(false); } }}>
          <p className="fx-hint">Replace the editor text with the default Factory process? Lines marked − go, lines marked + come in. Nothing is saved until you press Save.</p>
          <pre className="fx-log fx-process-diff" tabIndex={0} aria-label="Changes the reset makes">
            {lineDiff(text, defaultText).map((d, i) => <span key={i} className="fx-process-diff-line" data-kind={d.kind === "+" ? "add" : d.kind === "-" ? "del" : "same"}>{`${d.kind} ${d.text}\n`}</span>)}
          </pre>
          <div className="fx-actions">
            <button type="button" ref={resetFirst} className="fx-btn fx-primary" onClick={() => { setText(defaultText); setConfirmReset(false); }}>Use the default</button>
            <button type="button" className="fx-btn" onClick={() => setConfirmReset(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <label className="fx-field fx-process-field">
        <span>Factory process (JSON)</span>
        <textarea
          ref={area}
          className="fx-process-text"
          value={text}
          spellCheck={false}
          aria-invalid={!parse.ok}
          aria-describedby="fx-process-problems"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="fx-sr" role="status" aria-live="polite">{spoken}</p>
      <div id="fx-process-problems">
        {saved === null ? null : errors.length === 0 ? (
          <p className="fx-hint">{dirty ? "No problems. Save to use it at the next run." : "No problems."}</p>
        ) : (
          <ul className="fx-process-problems" aria-label="Problems in the Factory process">
            {errors.map((e, i) => (
              <li key={i}>
                <button type="button" className="fx-process-problem" onClick={() => goToLine(e.line)}>
                  <span className="fx-process-line">Line {e.line}</span> {e.path ? <code>{e.path}</code> : null} {e.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
