// Monaco-backed `EditorHost` for the Explorer (the only Explorer module that imports `monaco-editor`).
//
// Memory: one model per open file; clean models of tabs that are not showing are disposed beyond
// MAX_MODELS / MAX_MODEL_CHARS (least recently shown first) and re-read when the tab is activated again.
// A model with unsaved edits is NEVER evicted. Large files open in large-file mode (plain text, no minimap,
// no decorations). Dirtiness uses Monaco's alternative version id, so undoing back to the saved text is clean.
// Models are views of the file on disk, not a store.
import type { editor as MonacoEditorNs } from "monaco-editor";
import { monaco } from "./monacoEnv";
import { applyMonacoTheme, editorFontOptions, THEME_NAME } from "./monacoTheme";
import { MAX_MODELS, MAX_MODEL_CHARS, type EditorCallbacks, type EditorHost, type OpenDoc } from "../../../ui/screens/explorer/editor-types";

interface Entry {
  model: MonacoEditorNs.ITextModel;
  /** Alternative version id of the text last saved or loaded. */
  baseline: number;
  /** Rename of a dirty buffer: stays dirty until saved even though the new model starts at its own baseline. */
  forcedDirty: boolean;
  dirty: boolean;
  readOnly: boolean;
  large: boolean;
  lastShown: number;
  sub: { dispose(): void };
}

const uriFor = (path: string) => monaco.Uri.from({ scheme: "llmide", path: `/${path}` });

const NORMAL: MonacoEditorNs.IEditorOptions = {
  minimap: { enabled: true },
  folding: true,
  occurrencesHighlight: "singleFile",
  links: true,
  colorDecorators: true,
  bracketPairColorization: { enabled: true },
  guides: { indentation: true },
  renderValidationDecorations: "editable",
  quickSuggestions: true,
  stopRenderingLineAfter: 10000,
  wordWrap: "off",
};

const LARGE: MonacoEditorNs.IEditorOptions = {
  minimap: { enabled: false },
  folding: false,
  occurrencesHighlight: "off",
  links: false,
  colorDecorators: false,
  bracketPairColorization: { enabled: false },
  guides: { indentation: false },
  renderValidationDecorations: "off",
  quickSuggestions: false,
  stopRenderingLineAfter: 2000,
  wordWrap: "off",
};

export function createMonacoEditorHost(): EditorHost {
  const models = new Map<string, Entry>();
  let cb: EditorCallbacks | null = null;
  let editor: MonacoEditorNs.IStandaloneCodeEditor | null = null;
  let diff: MonacoEditorNs.IStandaloneDiffEditor | null = null;
  let diffOriginal: MonacoEditorNs.ITextModel | null = null;
  let editorEl: HTMLDivElement | null = null;
  let diffEl: HTMLDivElement | null = null;
  let current: string | null = null;
  let clock = 0;

  const setDirty = (path: string, e: Entry) => {
    const dirty = e.forcedDirty || e.model.getAlternativeVersionId() !== e.baseline;
    if (dirty !== e.dirty) {
      e.dirty = dirty;
      cb?.onDirty(path, dirty);
    }
  };

  const create = (doc: OpenDoc): Entry => {
    const model = monaco.editor.createModel(doc.text, doc.large ? "plaintext" : doc.language, uriFor(doc.path));
    const entry: Entry = {
      model, baseline: model.getAlternativeVersionId(), forcedDirty: false, dirty: false, readOnly: doc.readOnly, large: doc.large, lastShown: 0,
      sub: model.onDidChangeContent(() => {
        const e = models.get(doc.path);
        if (e) {
          e.forcedDirty = false;
          setDirty(doc.path, e);
        }
      }),
    };
    models.set(doc.path, entry);
    return entry;
  };

  const chars = () => [...models.values()].reduce((n, e) => n + e.model.getValueLength(), 0);

  // Keep inside the memory budget: drop the least recently shown CLEAN models that are not showing.
  const evict = () => {
    if (models.size <= MAX_MODELS && chars() <= MAX_MODEL_CHARS) return;
    const order = [...models.entries()].filter(([p, e]) => p !== current && !e.dirty && !e.forcedDirty).sort((a, b) => a[1].lastShown - b[1].lastShown);
    for (const [p, e] of order) {
      if (models.size <= MAX_MODELS && chars() <= MAX_MODEL_CHARS) break;
      e.sub.dispose();
      e.model.dispose();
      models.delete(p);
      cb?.onEvict(p);
    }
  };

  const showModel = (path: string, e: Entry) => {
    if (!editor) return;
    hideDiff();
    e.lastShown = ++clock;
    current = path;
    editor.updateOptions({ readOnly: e.readOnly, ...(e.large ? LARGE : NORMAL) });
    editor.setModel(e.model);
    evict();
  };

  const hideDiff = () => {
    if (!diff) return;
    diff.setModel(null);
    diffOriginal?.dispose();
    diffOriginal = null;
    diff.dispose();
    diff = null;
    if (diffEl) diffEl.hidden = true;
    if (editorEl) editorEl.hidden = false;
    editor?.layout();
  };

  return {
    mount(el, callbacks) {
      cb = callbacks;
      el.replaceChildren();
      editorEl = document.createElement("div");
      diffEl = document.createElement("div");
      for (const d of [editorEl, diffEl]) {
        d.style.cssText = "position:absolute;inset:0";
        el.appendChild(d);
      }
      diffEl.hidden = true;
      applyMonacoTheme();
      editor = monaco.editor.create(editorEl, {
        model: null,
        theme: THEME_NAME,
        automaticLayout: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        smoothScrolling: false,
        renderWhitespace: "selection",
        ...editorFontOptions(),
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (current) cb?.onSave(current);
      });
    },
    open(doc) {
      const e = models.get(doc.path) ?? create(doc);
      showModel(doc.path, e);
    },
    show(path) {
      const e = models.get(path);
      if (!e) return false;
      showModel(path, e);
      return true;
    },
    has: (path) => models.has(path),
    showNone() {
      hideDiff();
      current = null;
      editor?.setModel(null);
    },
    getText: (path) => models.get(path)?.model.getValue() ?? null,
    snapshot(path) {
      const e = models.get(path);
      return e ? { text: e.model.getValue(), versionId: e.model.getAlternativeVersionId() } : null;
    },
    replace(path, text) {
      const e = models.get(path);
      if (!e) return;
      e.model.setValue(text);
      // Loading from disk is not an edit: undo must not restore the old buffer over it.
      e.model.pushStackElement();
      e.baseline = e.model.getAlternativeVersionId();
      e.forcedDirty = false;
      setDirty(path, e);
    },
    append(path, text) {
      const e = models.get(path);
      if (!e) return;
      const end = e.model.getFullModelRange().getEndPosition();
      e.model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text }]);
      e.baseline = e.model.getAlternativeVersionId();
      setDirty(path, e);
    },
    markSaved(path, versionId) {
      const e = models.get(path);
      if (!e) return true;
      const cur = e.model.getAlternativeVersionId();
      // Typing during the write moved the version: the saved text is the OLD version, so keep dirty.
      e.baseline = versionId ?? cur;
      e.forcedDirty = false;
      setDirty(path, e);
      return e.baseline === cur;
    },
    close(path) {
      const e = models.get(path);
      if (!e) return;
      if (current === path) {
        hideDiff();
        editor?.setModel(null);
        current = null;
      }
      e.sub.dispose();
      e.model.dispose();
      models.delete(path);
    },
    rename(from, to) {
      const e = models.get(from);
      if (!e) return;
      const wasShowing = current === from;
      const text = e.model.getValue();
      const wasDirty = e.dirty;
      if (wasShowing) {
        hideDiff();
        editor?.setModel(null);
      }
      e.sub.dispose();
      e.model.dispose();
      models.delete(from);
      const n = create({ path: to, text, language: e.model.getLanguageId(), readOnly: e.readOnly, large: e.large });
      n.forcedDirty = wasDirty;
      n.dirty = wasDirty;
      if (wasShowing) showModel(to, n);
    },
    showDiff(path, original) {
      const e = models.get(path);
      if (!e || !diffEl || !editorEl) return;
      hideDiff();
      diffOriginal = monaco.editor.createModel(original, e.model.getLanguageId(), monaco.Uri.from({ scheme: "llmide-diff", path: `/${path}` }));
      diff = monaco.editor.createDiffEditor(diffEl, { theme: THEME_NAME, automaticLayout: true, renderSideBySide: true, readOnly: e.readOnly, originalEditable: false, ...editorFontOptions() });
      diff.setModel({ original: diffOriginal, modified: e.model });
      editorEl.hidden = true;
      diffEl.hidden = false;
    },
    hideDiff,
    reveal(path, line, col) {
      const e = models.get(path);
      if (!e || !editor || diff) return;
      const lineNumber = Math.min(Math.max(1, Math.floor(line) || 1), e.model.getLineCount());
      const column = Math.min(Math.max(1, Math.floor(col) || 1), e.model.getLineMaxColumn(lineNumber));
      editor.setPosition({ lineNumber, column });
      editor.revealLineInCenter(lineNumber);
      editor.focus();
    },
    find() {
      const target = diff ? diff.getModifiedEditor() : editor;
      target?.focus();
      void target?.getAction("actions.find")?.run();
    },
    focus: () => (diff ? diff.getModifiedEditor() : editor)?.focus(),
    layout() {
      editor?.layout();
      diff?.layout();
    },
    retheme: () => applyMonacoTheme(),
    modelCount: () => models.size,
    dispose() {
      hideDiff();
      for (const e of models.values()) {
        e.sub.dispose();
        e.model.dispose();
      }
      models.clear();
      editor?.dispose();
      editor = null;
      current = null;
    },
  };
}
