// Wires Monaco to the Swift MonacoBridge (see MonacoBridge.swift for the
// message shapes) and exposes window.__llmide as the ONLY surface
// MonacoHost's Swift code calls into via callAsyncJavaScript. Kept as a
// hand-authored source file (copied verbatim by build-monaco-bundle.mjs,
// never minified/regenerated) so it stays readable and diffable.
(function () {
  'use strict';

  function post(message) {
    try {
      window.webkit.messageHandlers.monacoBridge.postMessage(message);
    } catch (e) {
      // No bridge (e.g. loaded outside a WKWebView while iterating on this
      // file locally) — degrade to a no-op rather than throwing.
    }
  }

  require.config({ paths: { vs: './vs' } });

  window.__llmide = {
    editor: null,
    diffEditor: null,
    decorationIds: [],

    // Per-file models + saved view state, keyed by the `path` Swift passes to
    // setContent. Insertion order of `models` doubles as LRU order.
    models: new Map(),
    viewStates: new Map(),
    currentPath: null,
    pendingTimer: null,
    MAX_MODELS: 32,
    SMALL_DOC_CHARS: 128 * 1024,

    modelFor: function (path, text, language) {
      var entry = this.models.get(path);
      if (entry && !entry.isDisposed()) {
        this.models.delete(path); // re-insert below = mark most recently used
        if (entry.getValue() !== text) entry.setValue(text); // external reload only
        monaco.editor.setModelLanguage(entry, language);
      } else {
        entry = monaco.editor.createModel(text, language);
      }
      this.models.set(path, entry);
      this.evictModels();
      return entry;
    },

    evictModels: function () {
      var self = this;
      this.models.forEach(function (model, key) {
        if (self.models.size <= self.MAX_MODELS) return;
        if (key === self.currentPath) return;
        model.dispose();
        self.models.delete(key);
        self.viewStates.delete(key);
      });
    },

    // Swift signals a closed tab: drop that file's model and view state.
    closeFile: function (path) {
      var model = this.models.get(path);
      if (model) {
        if (this.editor && this.editor.getModel() === model) this.editor.setModel(null);
        model.dispose();
      }
      this.models.delete(path);
      this.viewStates.delete(path);
      if (this.currentPath === path) this.currentPath = null;
    },

    // Full text of the current model. Swift's save path awaits this so a
    // Cmd-S right after typing never sees text still held by the debounce.
    getContent: function () {
      this.flushContent();
      return this.editor ? this.editor.getValue() : null;
    },

    // Post the whole document now and cancel the pending debounced post.
    flushContent: function () {
      if (this.pendingTimer === null) return;
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      if (this.editor) post({ type: 'contentChanged', text: this.editor.getValue() });
    },

    // `path` is optional for backward compatibility; without it all content
    // shares one anonymous model slot.
    setContent: function (text, language, path) {
      var key = path || '';
      var container = document.getElementById('container');
      container.style.display = 'block';
      document.getElementById('diff-container').style.display = 'none';
      if (this.diffEditor) { this.diffEditor.dispose(); this.diffEditor = null; }
      if (!this.editor) {
        this.editor = monaco.editor.create(container, {
          model: this.modelFor(key, text, language),
          automaticLayout: true,
          // No minimap. It is a VS Code signature, not something an editor
          // needs: it costs a continuous render of the whole document and
          // eats horizontal space that matters more in this app's split
          // layout (tree + editor in one window) than it does in VS Code.
          minimap: { enabled: false },
        });
        this.currentPath = key;
        this.editor.onDidChangeModelContent(function () {
          // Small documents post immediately (exact old semantics); large
          // ones debounce, since each post ships the whole text.
          var self = window.__llmide;
          if (self.pendingTimer !== null) { clearTimeout(self.pendingTimer); self.pendingTimer = null; }
          if (self.editor.getModel().getValueLength() <= self.SMALL_DOC_CHARS) {
            post({ type: 'contentChanged', text: self.editor.getValue() });
            return;
          }
          self.pendingTimer = setTimeout(function () {
            self.pendingTimer = null;
            post({ type: 'contentChanged', text: self.editor.getValue() });
          }, 150);
        });
        this.editor.onDidBlurEditorWidget(function () { window.__llmide.flushContent(); });
        window.addEventListener('blur', function () { window.__llmide.flushContent(); });
        window.addEventListener('pagehide', function () { window.__llmide.flushContent(); });
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') window.__llmide.flushContent();
        });
        this.editor.onDidChangeCursorPosition(function (e) {
          post({ type: 'cursorMoved', line: e.position.lineNumber, column: e.position.column });
        });
        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
          window.__llmide.flushContent(); // text first, so Swift saves what is on screen
          post({ type: 'requestSave' });
        });
        this.editor.onMouseDown(function (e) {
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
              && e.target.position) {
            post({ type: 'gutterAction', line: e.target.position.lineNumber, action: 'stage' });
          }
        });
        return;
      }
      if (key !== this.currentPath) {
        // Drop (do NOT flush) the pending post: it carries the OLD file's
        // text and Swift has already moved on to the new file's content.
        if (this.pendingTimer !== null) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
        this.viewStates.set(this.currentPath, this.editor.saveViewState());
        var model = this.modelFor(key, text, language);
        this.editor.setModel(model);
        this.currentPath = key;
        var state = this.viewStates.get(key);
        if (state) this.editor.restoreViewState(state);
      } else {
        // Same file: only an external change touches the model (keeps undo).
        this.modelFor(key, text, language);
      }
    },

    setDecorations: function (decorations) {
      if (!this.editor) return;
      var monacoDecorations = decorations.map(function (d) {
        var cls = 'llmide-gutter-' + d.kind;
        return {
          range: new monaco.Range(d.line, 1, d.line, 1),
          options: { isWholeLine: false, linesDecorationsClassName: cls },
        };
      });
      this.decorationIds = this.editor.deltaDecorations(this.decorationIds, monacoDecorations);
    },

    setTheme: function (themeJSON) {
      var theme = JSON.parse(themeJSON);
      monaco.editor.defineTheme('llmide', theme);
      monaco.editor.setTheme('llmide');
    },

    reveal: function (line) {
      if (this.editor) this.editor.revealLineInCenter(line);
    },

    showDiff: function (original, modified, language) {
      var diffContainer = document.getElementById('diff-container');
      document.getElementById('container').style.display = 'none';
      diffContainer.style.display = 'block';
      if (!this.diffEditor) {
        this.diffEditor = monaco.editor.createDiffEditor(diffContainer, { automaticLayout: true });
      }
      var originalModel = monaco.editor.createModel(original, language);
      var modifiedModel = monaco.editor.createModel(modified, language);
      this.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    },

    setReadOnly: function (readOnly) {
      if (this.editor) this.editor.updateOptions({ readOnly: readOnly });
    },
  };

  require(['vs/editor/editor.main'], function () {
    post({ type: 'ready' });
  });
})();
