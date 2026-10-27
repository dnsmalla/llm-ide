// Golden bytes for what HEAD's Swift renderedMarkdown() writes (docs-kit K1).
// The Swift side asserts the same literals in mac/Tests/LlmIdeMacTests/DocGenServerParityTests.swift.
// Plain module (no tests) so other test files can import it without re-running suites.

export const GOLDEN_VISUAL_TEMPLATE =
  '# Sprint Review\n\n<!-- llmide:doc-template surface=visual -->\n\n'
  + 'Template for Visual. Edit the `##` sections below to change structure.\n\n'
  + '## Summary\n\n## Decisions\n';
export const GOLDEN_DOC_TEMPLATE =
  '# Retro\n\n<!-- llmide:doc-template -->\n\n'
  + 'Template for Doc Gen. Edit the `##` sections below to change structure.\n\n'
  + '## Went well\n\n## Improve\n';
export const GOLDEN_DOC_COMMAND =
  '# Summarize\n\n<!-- llmide:doc-command -->\n\nSummarize the source into five bullet points.';
export const GOLDEN_VISUAL_COMMAND =
  '# Visual Brief\n\n<!-- llmide:doc-command surface=visual -->\n\nDescribe the frame.';
export const GOLDEN_KIT_VISUAL_SEED =
  '# Image Analysis\n\n<!-- llmide:doc-template surface=visual -->\n\n'
  + '## What It Shows\n\n## Details Worth Noting\n';

