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

    setContent: function (text, language) {
      var container = document.getElementById('container');
      container.style.display = 'block';
      document.getElementById('diff-container').style.display = 'none';
      if (this.diffEditor) { this.diffEditor.dispose(); this.diffEditor = null; }
      if (this.editor) {
        var model = this.editor.getModel();
        monaco.editor.setModelLanguage(model, language);
        model.setValue(text);
      } else {
        this.editor = monaco.editor.create(container, {
          value: text,
          language: language,
          automaticLayout: true,
          minimap: { enabled: true },
        });
        this.editor.onDidChangeModelContent(function () {
          post({ type: 'contentChanged', text: window.__llmide.editor.getValue() });
        });
        this.editor.onDidChangeCursorPosition(function (e) {
          post({ type: 'cursorMoved', line: e.position.lineNumber, column: e.position.column });
        });
        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
          post({ type: 'requestSave' });
        });
        this.editor.onMouseDown(function (e) {
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
              && e.target.position) {
            post({ type: 'gutterAction', line: e.target.position.lineNumber, action: 'stage' });
          }
        });
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
