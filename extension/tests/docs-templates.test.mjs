// docs-kit K1: Doc Gen template and command logic, ported from the Swift
// tests so the Node server can take over the project-folder files.
//
// Each test names the Swift test it ports (`// ported from <Suite>:<name>`).
// Cases that stay Swift-only (UI, the kit cache, the Swift stores until K3) are
// listed in the NOT PORTED block at the bottom, with the reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as T from '../kb/doc-templates.mjs';
import * as F from '../kb/doc-project-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'docgen', 'project');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A throwaway project root with the LLM-IDE marker. Returns its realpath. */
function tmpProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-k1-')));
  fs.mkdirSync(path.join(root, 'system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 'project.json'), '{}');
  return root;
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

// ---------------------------------------------------------------------------
// Golden bytes: what HEAD's Swift `renderedMarkdown()` writes. The Swift side
// asserts these same literals (DocGenServerParityTests.swift). An older Mac
// build must read these bytes, so they must not drift.
// ---------------------------------------------------------------------------

import { GOLDEN_VISUAL_TEMPLATE, GOLDEN_DOC_TEMPLATE, GOLDEN_DOC_COMMAND, GOLDEN_VISUAL_COMMAND, GOLDEN_KIT_VISUAL_SEED } from './fixtures/docgen/golden.mjs';

test('golden: visual template bytes match HEAD renderedMarkdown()', () => {
  const out = T.renderTemplateMarkdown({
    name: 'Sprint Review', sections: ['Summary', 'Decisions'], surface: 'visual',
  });
  assert.equal(out, GOLDEN_VISUAL_TEMPLATE);
});

test('golden: doc template bytes use the bare marker (unchanged file for Doc Gen)', () => {
  const out = T.renderTemplateMarkdown({
    name: 'Retro', sections: ['Went well', 'Improve'], surface: 'doc',
  });
  assert.equal(out, GOLDEN_DOC_TEMPLATE);
});

test('golden: doc command bytes have no trailing newline', () => {
  const out = T.renderCommandMarkdown({
    name: 'Summarize', instruction: 'Summarize the source into five bullet points.', surface: 'doc',
  });
  assert.equal(out, GOLDEN_DOC_COMMAND);
});

test('golden: visual command bytes', () => {
  const out = T.renderCommandMarkdown({
    name: 'Visual Brief', instruction: 'Describe the frame.', surface: 'visual',
  });
  assert.equal(out, GOLDEN_VISUAL_COMMAND);
});

test('golden: a kit template stamped visual (ensure) matches the seed bytes', () => {
  const body = '# Image Analysis\n\n## What It Shows\n\n## Details Worth Noting\n';
  assert.equal(T.ensureSurfaceMarker(body, T.TEMPLATE_MARKER, 'visual'), GOLDEN_KIT_VISUAL_SEED);
});

test('golden: rawContent wins over the rendered body (renderedMarkdown rule)', () => {
  const raw = '# Kept\n\nhand-written\n';
  assert.equal(T.renderTemplateMarkdown({ rawContent: raw, name: 'X', sections: ['A'] }), raw);
  assert.equal(T.renderCommandMarkdown({ rawContent: raw, name: 'X', instruction: 'a' }), raw);
});

test('golden: the K1a fixture bytes parse back to HEAD shapes', () => {
  const v2 = fixture('template-md.v2-visual-marker.md');
  assert.equal(T.readSurface(v2, T.TEMPLATE_MARKER), 'visual');
  assert.equal(T.templateDisplayName(v2, 'sprint-review'), 'Sprint Review');
  assert.deepEqual(T.sectionsFrom(v2), ['Summary', 'Decisions']);
});

// ---------------------------------------------------------------------------
// DocCommandTests (13)
// ---------------------------------------------------------------------------

test('testInstructionStripsTitleAndMarker', () => {
  // ported from DocCommandTests:testInstructionStripsTitleAndMarker
  const md = '# Summarize\n\n<!-- llmide:doc-command -->\n\nSummarize the selected sources in five bullets.\nKeep it terse.';
  assert.equal(T.commandInstruction(md), 'Summarize the selected sources in five bullets.\nKeep it terse.');
});

test('testDisplayNameFallsBackToHumanizedFolder', () => {
  // ported from DocCommandTests:testDisplayNameFallsBackToHumanizedFolder
  assert.equal(T.commandDisplayName('no heading here', 'release-notes'), 'Release Notes');
});

test('testDisplayNamePrefersHeading', () => {
  // ported from DocCommandTests:testDisplayNamePrefersHeading
  assert.equal(T.commandDisplayName('# Explain Code\n\nbody', 'explain-code'), 'Explain Code');
});

test('testStableIDIsStableAndDistinctFromTemplates', () => {
  // ported from DocCommandTests:testStableIDIsStableAndDistinctFromTemplates
  const a = T.stableId('my-command', 'command');
  assert.equal(a, T.stableId('my-command', 'command'));
  assert.notEqual(a, T.stableId('my-command', 'template'));
});

test.skip('testSeedIDsAreUsedForSeedFolders', () => {
  // ported from DocCommandTests:testSeedIDsAreUsedForSeedFolders
  // SKIPPED, as in Swift: DocCommand.seedDefinitions is empty (every seeded
  // command comes from the kit, and kit folders get stableId by folder name).
});

test('testMarkdownBodyRoundTrips', () => {
  // ported from DocCommandTests:testMarkdownBodyRoundTrips
  const md = T.renderCommandBody('Terse', 'Be brief.');
  assert.equal(T.commandDisplayName(md, 'terse'), 'Terse');
  assert.equal(T.commandInstruction(md), 'Be brief.');
});

test('testSlugSanitizes', () => {
  // ported from DocCommandTests:testSlugSanitizes
  assert.equal(T.slugFor('Release  Notes!', 'command'), 'release-notes');
});

test('testSecondH1InBodyIsKept', () => {
  // ported from DocCommandTests:testSecondH1InBodyIsKept
  const md = '# Summarize\n\n<!-- llmide:doc-command -->\n\nFirst point.\n# Second heading\nLast point.';
  assert.equal(T.commandInstruction(md), 'First point.\n# Second heading\nLast point.');
  assert.equal(T.commandDisplayName(md, 'summarize'), 'Summarize');
});

test('testOnlyTheFirstTitleLineIsDropped', () => {
  // ported from DocCommandTests:testOnlyTheFirstTitleLineIsDropped
  const md = '# Title\n# Not a title\n\nBody.';
  assert.equal(T.commandInstruction(md), '# Not a title\n\nBody.');
  assert.equal(T.commandDisplayName(md, 'x'), 'Title');
});

test('testFencedShellCommentIsKept', () => {
  // ported from DocCommandTests:testFencedShellCommentIsKept
  const md = ['# Install', '', 'Run these steps:', '', '```bash', '# install deps', 'npm ci',
    '# run tests', 'npm test', '```'].join('\n');
  const instruction = T.commandInstruction(md);
  assert.ok(instruction.includes('# install deps'), instruction);
  assert.ok(instruction.includes('# run tests'), instruction);
  assert.ok(!instruction.startsWith('# Install'), instruction);
  assert.equal(T.commandDisplayName(md, 'install'), 'Install');
});

test('testBodyWithoutAnyHashLineIsUnchanged', () => {
  // ported from DocCommandTests:testBodyWithoutAnyHashLineIsUnchanged
  const md = 'Just a body.\nTwo lines, no heading.';
  assert.equal(T.commandInstruction(md), 'Just a body.\nTwo lines, no heading.');
  assert.equal(T.commandDisplayName(md, 'just-a-body'), 'Just A Body');
});

test('testCRLFBodyDropsOnlyTheTitleAndKeepsParagraphs', () => {
  // ported from DocCommandTests:testCRLFBodyDropsOnlyTheTitleAndKeepsParagraphs
  const md = '# Summarize\r\n\r\n<!-- llmide:doc-command -->\r\n\r\nFirst.\r\n# Kept\r\n\r\nLast.';
  assert.equal(T.commandInstruction(md), 'First.\n# Kept\n\nLast.');
  assert.equal(T.commandDisplayName(md, 'summarize'), 'Summarize');
});

test('testIndentedTitleIsTheSameLineForNameAndInstruction', () => {
  // ported from DocCommandTests:testIndentedTitleIsTheSameLineForNameAndInstruction
  const md = '   # Indented\n\nBody.';
  assert.equal(T.commandDisplayName(md, 'x'), 'Indented');
  assert.equal(T.commandInstruction(md), 'Body.');
});

// ---------------------------------------------------------------------------
// DocCommandStoreTests (6). The Swift store keeps kit commands in memory and
// talks to a published array; the server twin is the folder files themselves.
// ---------------------------------------------------------------------------

function kitEntry(id, body, surface = 'doc') {
  return { id, body, surface, family: id.split('/')[0] };
}

test('testSeederWritesEveryKitCommand', () => {
  // ported from DocCommandStoreTests:testSeederWritesEveryKitCommand
  const root = tmpProject();
  try {
    const kit = [kitEntry('commands/summarize', '# Summarize\n\nShorten it.'),
      kitEntry('commands/translate', '# Translate\n\nInto Japanese.')];
    F.seedProjectFiles(root, { commands: kit });
    for (const entry of kit) {
      const folder = entry.id.split('/')[1];
      const file = path.join(root, 'commands', folder, 'command.md');
      assert.ok(fs.existsSync(file), `missing ${folder}/command.md`);
      const written = fs.readFileSync(file, 'utf8');
      for (const fragment of entry.body.split('\n\n').filter(Boolean)) {
        assert.ok(written.includes(fragment), `missing kit text: ${fragment}`);
      }
      assert.ok(written.includes('llmide:doc-command'), 'lost its surface marker');
    }
  } finally {
    cleanup(root);
  }
});

test('testSeederIsIdempotentAndKeepsEdits', () => {
  // ported from DocCommandStoreTests:testSeederIsIdempotentAndKeepsEdits
  const root = tmpProject();
  try {
    const kit = { commands: [kitEntry('commands/summarize', '# Summarize\n\nShipped text.')] };
    F.seedProjectFiles(root, kit);
    const file = path.join(root, 'commands', 'summarize', 'command.md');
    const edited = '# Summarize\n\n<!-- llmide:doc-command -->\n\nEdited.';
    fs.writeFileSync(file, edited, 'utf8');
    F.seedProjectFiles(root, kit);
    assert.equal(fs.readFileSync(file, 'utf8'), edited, 're-seeding overwrote an edited command');
  } finally {
    cleanup(root);
  }
});

test('testReloadPublishesProjectCommands', () => {
  // ported from DocCommandStoreTests:testReloadPublishesProjectCommands
  // Folder order (aa-, zz-) and display-name order disagree on purpose.
  const root = tmpProject();
  try {
    F.seedProjectFiles(root, { commands: [
      kitEntry('commands/aa-long', '# Zulu Long\n\nBody.'),
      kitEntry('commands/zz-brief', '# Alpha Brief\n\nBody.'),
    ] });
    const commands = F.scanCommands(root);
    assert.equal(commands.length, 2);
    assert.ok(commands.every((c) => c.isProjectCommand === true));
    assert.deepEqual(commands.map((c) => c.name), ['Alpha Brief', 'Zulu Long']);
  } finally {
    cleanup(root);
  }
});

test('testFallsBackToBuiltinsWithNoProject', () => {
  // ported from DocCommandStoreTests:testFallsBackToBuiltinsWithNoProject (partial).
  // The Swift fallback is the kit cache, which is client-side. The server twin
  // is: a project with no commands/ folder lists nothing and invents nothing.
  const root = tmpProject();
  try {
    assert.deepEqual(F.scanCommands(root), []);
  } finally {
    cleanup(root);
  }
});

test('testImportWritesIntoProjectAndSelectsIt', () => {
  // ported from DocCommandStoreTests:testImportWritesIntoProjectAndSelectsIt (partial).
  // The Swift import reads an .md file on disk; the server write takes the
  // file's text (rawContent) and the folder the slug logic picked.
  const root = tmpProject();
  try {
    F.seedProjectFiles(root, { commands: [] });
    const raw = '# Tighten\n\nRemove filler words.';
    const folder = T.slugForUnique(T.commandDisplayName(raw, 'incoming'), new Set(), 'command');
    const saved = F.writeCommand(root, folder, { name: 'Tighten', rawContent: raw });
    assert.equal(saved.name, 'Tighten');
    assert.equal(saved.instruction, 'Remove filler words.');
    assert.ok(F.scanCommands(root).some((c) => c.name === 'Tighten'));
  } finally {
    cleanup(root);
  }
});

test('testDeleteRemovesTheFolder', () => {
  // ported from DocCommandStoreTests:testDeleteRemovesTheFolder
  const root = tmpProject();
  try {
    F.seedProjectFiles(root, { commands: [kitEntry('commands/summarize', '# Summarize\n\nShorten it.')] });
    const target = F.scanCommands(root).find((c) => c.folderName === 'summarize');
    assert.ok(target);
    assert.equal(F.deleteFolder(root, 'commands', target.folderName), true);
    assert.ok(!F.scanCommands(root).some((c) => c.folderName === 'summarize'));
    assert.ok(!fs.existsSync(path.join(root, 'commands', 'summarize')));
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// DocTemplateRewriteTests (6)
// ---------------------------------------------------------------------------

const REWRITE_RAW = [
  '# Meeting Summary', '', '<!-- llmide:doc-template surface=doc -->', '',
  'Write for an executive reader.', '',
  '## Decisions', 'List each decision with its owner.', '',
  '## Risks', 'Only risks with a mitigation.', '',
  '## Next Steps', 'Dated, owned.',
].join('\n');

test('reorderKeepsBodies', () => {
  // ported from DocTemplateRewriteTests:reorderKeepsBodies
  const out = T.rewriteTemplateMarkdown(REWRITE_RAW, 'Weekly Summary', ['Risks', 'Decisions', 'Next Steps']);
  assert.ok(out.startsWith('# Weekly Summary\n'));
  assert.ok(out.includes('<!-- llmide:doc-template surface=doc -->'));
  assert.ok(out.includes('Write for an executive reader.'));
  assert.ok(out.indexOf('## Risks') < out.indexOf('## Decisions'));
  assert.ok(out.includes('## Risks\nOnly risks with a mitigation.'));
  assert.ok(out.includes('## Decisions\nList each decision with its owner.'));
  assert.deepEqual(T.sectionsFrom(out), ['Risks', 'Decisions', 'Next Steps']);
});

test('removeAndAdd', () => {
  // ported from DocTemplateRewriteTests:removeAndAdd
  const out = T.rewriteTemplateMarkdown(REWRITE_RAW, 'Meeting Summary', ['Decisions', 'Open Questions']);
  assert.ok(!out.includes('Risks'));
  assert.ok(!out.includes('mitigation'));
  assert.ok(out.includes('List each decision with its owner.'));
  assert.ok(out.endsWith('## Open Questions\n'));
});

test('noHeadings', () => {
  // ported from DocTemplateRewriteTests:noHeadings
  const out = T.rewriteTemplateMarkdown('# T\n\nJust prose here.\n', 'T2', ['A', 'B']);
  assert.ok(out.startsWith('# T2\n'));
  assert.ok(out.includes('Just prose here.'));
  assert.deepEqual(T.sectionsFrom(out), ['A', 'B']);
});

test('roundTrip', () => {
  // ported from DocTemplateRewriteTests:roundTrip
  const out = T.rewriteTemplateMarkdown(REWRITE_RAW, 'Meeting Summary', ['Decisions', 'Risks', 'Next Steps']);
  assert.deepEqual(T.sectionsFrom(out), T.sectionsFrom(REWRITE_RAW));
  assert.ok(out.includes('Dated, owned.'));
});

test('crlf', () => {
  // ported from DocTemplateRewriteTests:crlf
  const crlf = REWRITE_RAW.replaceAll('\n', '\r\n');
  const out = T.rewriteTemplateMarkdown(crlf, 'Meeting Summary', ['Risks', 'Decisions', 'Next Steps']);
  assert.ok(out.includes('Only risks with a mitigation.'));
  assert.ok(out.includes('List each decision with its owner.'));
  assert.deepEqual(T.sectionsFrom(out), ['Risks', 'Decisions', 'Next Steps']);
});

test('duplicateHeadings', () => {
  // ported from DocTemplateRewriteTests:duplicateHeadings
  const dup = '# T\n\n## Notes\nfirst\n\n## Notes\nsecond\n';
  const out = T.rewriteTemplateMarkdown(dup, 'T', ['Notes', 'Notes']);
  assert.ok(out.indexOf('first') < out.indexOf('second'));
  assert.equal(out.split('## Notes').length, 3);
});

// ---------------------------------------------------------------------------
// DocGenOutputConfigTests: the three resolution rules (the rest stays Swift).
// ---------------------------------------------------------------------------

test('testResolvedDirectoryDefaultsToProjectData', () => {
  // ported from DocGenOutputConfigTests:testResolvedDirectoryDefaultsToProjectData
  assert.equal(F.resolveOutputDirectory({ projectRoot: '/tmp/proj' }), path.join('/tmp/proj', 'data'));
});

test('testResolvedDirectoryPrefersExplicitPath', () => {
  // ported from DocGenOutputConfigTests:testResolvedDirectoryPrefersExplicitPath
  assert.equal(F.resolveOutputDirectory({ localFolderPath: '/tmp/custom-out', projectRoot: '/tmp/proj' }), '/tmp/custom-out');
});

test('testResolvedDirectoryIsNilWithNoProjectAndNoPath', () => {
  // ported from DocGenOutputConfigTests:testResolvedDirectoryIsNilWithNoProjectAndNoPath
  assert.equal(F.resolveOutputDirectory({}), null);
});

// ---------------------------------------------------------------------------
// DocGenLegacyStateTests (project-folder cases) and AutoTaskTemplateStoreTests
// (auto_task skip). Read straight from the K1a fixtures.
// ---------------------------------------------------------------------------

test('testProjectTemplatesWithBareAndSurfaceMarkersParse', () => {
  // ported from DocGenLegacyStateTests:testProjectTemplatesWithBareAndSurfaceMarkersParse
  const root = tmpProject();
  try {
    write(root, 'templates/retro/template.md', fixture('template-md.v0-bare-marker.md'));
    write(root, 'templates/sprint-review/template.md', fixture('template-md.v2-visual-marker.md'));
    write(root, 'templates/auto_task/prompt.md', '# Prompt\n\nDo the thing.');
    write(root, 'templates/meeting-note/template.md',
      '# {{title}}\n\n<!-- llmide:ingest-template source=meeting -->\n\n## Summary\n');
    const templates = F.scanTemplates(root);
    assert.deepEqual(templates.map((t) => t.folderName), ['retro', 'sprint-review']);
    const retro = templates.find((t) => t.folderName === 'retro');
    assert.equal(retro.name, 'Retro');
    assert.deepEqual(retro.sections, ['Went well', 'Improve']);
    assert.equal(retro.surface, 'doc', 'a template with no surface= attribute is Doc Gen');
    assert.equal(retro.isProjectTemplate, true);
    assert.equal(templates.find((t) => t.folderName === 'sprint-review').surface, 'visual');
  } finally {
    cleanup(root);
  }
});

test('testProjectCommandWithBareMarkerParsesInstructionAndSurface', () => {
  // ported from DocGenLegacyStateTests:testProjectCommandWithBareMarkerParsesInstructionAndSurface
  const root = tmpProject();
  try {
    write(root, 'commands/summarize/command.md', fixture('command-md.v0-bare-marker.md'));
    write(root, 'commands/visual-brief/command.md',
      '# Visual Brief\n\n<!-- llmide:doc-command surface=visual -->\n\nDescribe the frame.');
    const commands = F.scanCommands(root);
    const summarize = commands.find((c) => c.folderName === 'summarize');
    assert.equal(summarize.name, 'Summarize');
    assert.equal(summarize.instruction, 'Summarize the source into five bullet points.',
      'the marker line and the title are not sent to the model as instruction');
    assert.equal(summarize.surface, 'doc');
    const brief = commands.find((c) => c.folderName === 'visual-brief');
    assert.equal(brief.instruction, 'Describe the frame.');
    assert.equal(brief.surface, 'visual');
  } finally {
    cleanup(root);
  }
});

test('auto_task folder is skipped by the template scan', () => {
  // ported from AutoTaskTemplateStoreTests (auto_task folder skip, line 325)
  const root = tmpProject();
  try {
    write(root, 'templates/auto_task/prompt.md', '# Prompt\n\nDo the thing.');
    assert.deepEqual(F.scanTemplates(root), []);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// GenerationContractLab (19 expect call sites), one test per assertion.
// ---------------------------------------------------------------------------

const TPL = '<!-- llmide:doc-template -->';
const CMD = '<!-- llmide:doc-command -->';

test('lab: a Doc Gen template writes the BARE marker', () => {
  // ported from GenerationContractLab:expect(line(templateMarker, .doc))
  assert.equal(T.surfaceMarkerLine(TPL, 'doc'), TPL);
});
test('lab: a Visual template writes the surface into its marker', () => {
  // ported from GenerationContractLab:expect(line(templateMarker, .visual))
  assert.equal(T.surfaceMarkerLine(TPL, 'visual'), '<!-- llmide:doc-template surface=visual -->');
});
test('lab: commands use the same attribute on their own marker', () => {
  // ported from GenerationContractLab:expect(line(commandMarker, .visual))
  assert.equal(T.surfaceMarkerLine(CMD, 'visual'), '<!-- llmide:doc-command surface=visual -->');
});
test('lab: no surface attribute means Doc Gen', () => {
  // ported from GenerationContractLab:expect(surface(in: bare) == .doc)
  assert.equal(T.readSurface(`# T\n\n${TPL}\n\n## A\n`, TPL), 'doc');
});
test('lab: an attributed marker reads back as its surface', () => {
  // ported from GenerationContractLab:expect(surface(in: visual) == .visual)
  assert.equal(T.readSurface('# T\n\n<!-- llmide:doc-template surface=visual -->\n\n## A\n', TPL), 'visual');
});
test('lab: a file with no marker at all is Doc Gen', () => {
  // ported from GenerationContractLab:expect(surface(in: "# T\n\n## A\n") == .doc)
  assert.equal(T.readSurface('# T\n\n## A\n', TPL), 'doc');
});
test('lab: extra spacing in a hand-edited marker still reads', () => {
  // ported from GenerationContractLab:expect(surface(in: spaced) == .visual)
  assert.equal(T.readSurface('# T\n\n<!--   llmide:doc-template   surface=visual   -->\n', TPL), 'visual');
});
test('lab: an unrecognised surface falls back to Doc Gen', () => {
  // ported from GenerationContractLab:expect(surface(in: typo) == .doc)
  assert.equal(T.readSurface('# T\n\n<!-- llmide:doc-template surface=vsual -->\n', TPL), 'doc');
});
test("lab: a command's marker is not a template's", () => {
  // ported from GenerationContractLab:expect(surface(in: cmd, base: templateMarker) == .doc)
  assert.equal(T.readSurface('# C\n\n<!-- llmide:doc-command surface=visual -->\n', TPL), 'doc');
});
test('lab: an imported file is stamped, so it stays in the menu it was imported into', () => {
  // ported from GenerationContractLab:expect(surface(in: stamped) == .visual)
  const stamped = T.ensureSurfaceMarker('# Imported\n\nSome body text.\n', TPL, 'visual');
  assert.equal(T.readSurface(stamped, TPL), 'visual');
});
test('lab: and its own content is untouched', () => {
  // ported from GenerationContractLab:expect(stamped.contains("# Imported") && ...)
  const stamped = T.ensureSurfaceMarker('# Imported\n\nSome body text.\n', TPL, 'visual');
  assert.ok(stamped.includes('# Imported') && stamped.includes('Some body text.'));
});
test('lab: re-stamping moves the file to the other menu', () => {
  // ported from GenerationContractLab:expect(surface(in: restamped) == .doc)
  const stamped = T.ensureSurfaceMarker('# Imported\n\nSome body text.\n', TPL, 'visual');
  assert.equal(T.readSurface(T.ensureSurfaceMarker(stamped, TPL, 'doc'), TPL), 'doc');
});
test('lab: re-stamping replaces the marker, it does not add a second', () => {
  // ported from GenerationContractLab:expect(markerCount == 1)
  const stamped = T.ensureSurfaceMarker('# Imported\n\nSome body text.\n', TPL, 'visual');
  const restamped = T.ensureSurfaceMarker(stamped, TPL, 'doc');
  assert.equal(restamped.split('\n').filter((l) => l.includes('llmide:doc-template')).length, 1);
});
test('lab: a file with no title still gets its marker', () => {
  // ported from GenerationContractLab:expect(surface(in: untitled) == .visual)
  assert.equal(T.readSurface(T.ensureSurfaceMarker('just text\n', TPL, 'visual'), TPL), 'visual');
});
test('lab: a kit template seeded as visual reads back as visual', () => {
  // ported from GenerationContractLab:expect(surface(in: seeded) == .visual)
  const seeded = T.ensureSurfaceMarker('# Image Analysis\n\n## What It Shows\n\n## Details Worth Noting\n', TPL, 'visual');
  assert.equal(T.readSurface(seeded, TPL), 'visual');
});
test("lab: the kit's sections survive the stamping verbatim", () => {
  // ported from GenerationContractLab:expect(seeded.contains("## What It Shows") && ...)
  const seeded = T.ensureSurfaceMarker('# Image Analysis\n\n## What It Shows\n\n## Details Worth Noting\n', TPL, 'visual');
  assert.ok(seeded.includes('## What It Shows') && seeded.includes('## Details Worth Noting'));
});
test('lab: the title stays first', () => {
  // ported from GenerationContractLab:expect(seeded.hasPrefix("# Image Analysis"))
  const seeded = T.ensureSurfaceMarker('# Image Analysis\n\n## What It Shows\n', TPL, 'visual');
  assert.ok(seeded.startsWith('# Image Analysis'));
});
test('lab: a kit template with no surface seeds as Doc Gen and keeps the bare marker', () => {
  // ported from GenerationContractLab:expect(surface(in: seededDoc) == .doc) and expect(contains(templateMarker))
  const seededDoc = T.ensureSurfaceMarker('# Meeting Summary\n\n## Key Decisions\n', TPL, 'doc');
  assert.equal(T.readSurface(seededDoc, TPL), 'doc');
  assert.ok(seededDoc.includes(TPL));
});

// ---------------------------------------------------------------------------
// Project-folder confinement and folder rules (no Swift twin: the Mac relied
// on the file system; the server must enforce this itself).
// ---------------------------------------------------------------------------

test('scan: a symlinked template file pointing outside the project is skipped', () => {
  const root = tmpProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), '# Leak\n\n## Stolen\n');
    fs.mkdirSync(path.join(root, 'templates', 'leak'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'templates', 'leak', 'template.md'));
    write(root, 'templates/ok/template.md', '# Ok\n\n## A\n');
    assert.deepEqual(F.scanTemplates(root).map((t) => t.folderName), ['ok']);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('scan: a symlinked folder pointing outside the project is not followed', () => {
  const root = tmpProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'template.md'), '# Out\n\n## X\n');
    fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'templates', 'evil'));
    assert.deepEqual(F.scanTemplates(root), []);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('scan: dotfiles and oversize files are skipped', () => {
  const root = tmpProject();
  try {
    write(root, 'templates/.hidden/template.md', '# Hidden\n\n## A\n');
    write(root, 'templates/big/template.md', `# Big\n\n${'x'.repeat(F.MAX_FILE_BYTES + 1)}`);
    write(root, 'templates/fine/template.md', '# Fine\n\n## A\n');
    assert.deepEqual(F.scanTemplates(root).map((t) => t.folderName), ['fine']);
  } finally {
    cleanup(root);
  }
});

test('scan: invalid UTF-8 is skipped (Swift String(contentsOf:encoding:.utf8) fails on it)', () => {
  const root = tmpProject();
  try {
    fs.mkdirSync(path.join(root, 'templates', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(root, 'templates', 'bad', 'template.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    assert.deepEqual(F.scanTemplates(root), []);
  } finally {
    cleanup(root);
  }
});

test('folder names: traversal, separators, dotfiles, reserved and over-long are refused', () => {
  for (const bad of ['..', '../x', 'a/b', '.hidden', 'auto_task', '', 'x'.repeat(81), 'a b', 'a\0b']) {
    assert.throws(() => F.assertFolderName(bad), (err) => err instanceof F.DocFilesError, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(F.assertFolderName('meeting-summary'), 'meeting-summary');
  assert.equal(F.assertFolderName('会議録'), '会議録');
});

test('write refuses a templates/ folder that is a symlink out of the project', () => {
  const root = tmpProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'templates'));
    assert.throws(() => F.writeTemplate(root, 'x', { name: 'X', sections: ['A'] }),
      (err) => err.code === 'UNSAFE_PATH');
    assert.deepEqual(fs.readdirSync(outside), [], 'wrote outside the project');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('write: the written file is exactly the golden bytes, and no temp file is left behind', () => {
  const root = tmpProject();
  try {
    F.writeTemplate(root, 'sprint-review', { name: 'Sprint Review', sections: ['Summary', 'Decisions'], surface: 'visual' });
    const dir = path.join(root, 'templates', 'sprint-review');
    assert.equal(fs.readFileSync(path.join(dir, 'template.md'), 'utf8'), GOLDEN_VISUAL_TEMPLATE);
    assert.deepEqual(fs.readdirSync(dir), ['template.md']);
  } finally {
    cleanup(root);
  }
});

test('rewrite: rawContent wins over rewrite (the schema rule), and rewrite alone keeps the body', () => {
  const root = tmpProject();
  try {
    write(root, 'templates/retro/template.md', REWRITE_RAW.replace('Meeting Summary', 'Retro'));
    const raw = F.writeTemplate(root, 'retro', { name: 'Ignored', rewrite: true, rawContent: '# Raw\n\n## Only\n' });
    assert.equal(raw.rawContent, '# Raw\n\n## Only\n');
    write(root, 'templates/retro/template.md', REWRITE_RAW.replace('Meeting Summary', 'Retro'));
    const kept = F.writeTemplate(root, 'retro', { name: 'Retro 2', sections: ['Risks'], rewrite: true });
    assert.ok(kept.rawContent.includes('Only risks with a mitigation.'));
  } finally {
    cleanup(root);
  }
});

test('rewrite: saving a template keeps its body text (the Swift manager-sheet rule)', () => {
  const root = tmpProject();
  try {
    write(root, 'templates/retro/template.md', REWRITE_RAW.replace('Meeting Summary', 'Retro'));
    const saved = F.writeTemplate(root, 'retro', { name: 'Retro 2', sections: ['Risks'], rewrite: true });
    assert.ok(saved.rawContent.includes('Only risks with a mitigation.'));
    assert.deepEqual(saved.sections, ['Risks']);
  } finally {
    cleanup(root);
  }
});

test('slugFor: spaces, punctuation, empty and Unicode names', () => {
  assert.equal(T.slugFor('Meeting  Summary!'), 'meeting-summary');
  assert.equal(T.slugFor('***'), 'template');
  assert.equal(T.slugFor('***', 'command'), 'command');
  assert.equal(T.slugFor('会議録'), '会議録');
});

test('slugFor: uniqueness appends -2, -3, ...', () => {
  const existing = new Set(['retro', 'retro-2']);
  assert.equal(T.slugForUnique('Retro', existing), 'retro-3');
  assert.equal(T.slugForUnique('Fresh', existing), 'fresh');
});

test('stableId: UUID shape, version 4 and variant bits, uppercase', () => {
  const id = T.stableId('retro', 'template');
  assert.match(id, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
});

test('humanizeFolder: release-notes → Release Notes', () => {
  assert.equal(T.humanizeFolder('release-notes'), 'Release Notes');
});

// ---------------------------------------------------------------------------
// Latency: list 200 templates. The budget is < 50 ms locally (docs-kit §6);
// the assertion is generous (200 ms) so a loaded CI runner does not flake.
// ---------------------------------------------------------------------------

test('latency: scanTemplates over 200 template folders', (t) => {
  const root = tmpProject();
  try {
    for (let i = 0; i < 200; i++) {
      write(root, `templates/t-${String(i).padStart(3, '0')}/template.md`,
        `# Template ${i}\n\n<!-- llmide:doc-template -->\n\n## Summary\n\n## Details\n\nBody ${i}.\n`);
    }
    F.scanTemplates(root);                      // warm the page cache once
    const started = performance.now();
    const templates = F.scanTemplates(root);
    const ms = performance.now() - started;
    t.diagnostic(`scanTemplates(200) took ${ms.toFixed(1)} ms`);
    assert.equal(templates.length, 200);
    assert.ok(ms < 200, `scan took ${ms.toFixed(1)} ms`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

test('seed: writes the README files and kit templates, and only writes what is absent', () => {
  const root = tmpProject();
  try {
    const first = F.seedProjectFiles(root, {
      templates: [kitEntry('templates/retro', '# Retro\n\n## Went well\n', 'doc')],
      commands: [kitEntry('commands/summarize', '# Summarize\n\nShorten it.', 'doc')],
    });
    assert.ok(first.includes('templates/README.md'));
    assert.ok(first.includes('templates/retro/template.md'));
    assert.ok(first.includes('commands/summarize/command.md'));
    const again = F.seedProjectFiles(root, {
      templates: [kitEntry('templates/retro', '# Retro\n\n## Went well\n', 'doc')],
      commands: [kitEntry('commands/summarize', '# Summarize\n\nShorten it.', 'doc')],
    });
    assert.deepEqual(again, [], 'a second seed writes nothing');
  } finally {
    cleanup(root);
  }
});

test('seed: the README text is the Swift seeder text (ends with the readme marker, no trailing newline)', () => {
  const root = tmpProject();
  try {
    F.seedProjectFiles(root, {});
    const readme = fs.readFileSync(path.join(root, 'templates', 'README.md'), 'utf8');
    assert.ok(readme.startsWith('# Doc Gen Templates\n'));
    assert.ok(readme.endsWith('<!-- llmide:doc-template-readme -->'));
  } finally {
    cleanup(root);
  }
});

test('seed: a kit entry whose folder name is reserved or invalid is not written', () => {
  const root = tmpProject();
  try {
    F.seedProjectFiles(root, { templates: [kitEntry('templates/auto_task', '# X\n\n## A\n'), kitEntry('templates/..', '# Y')] });
    assert.ok(!fs.existsSync(path.join(root, 'templates', 'auto_task')));
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Output-directory and project-root rules
// ---------------------------------------------------------------------------

test('validateProjectRoot: accepts a marked project and refuses the rest', () => {
  const root = tmpProject();
  // The fake home lives OUTSIDE the project, so the project is not its ancestor.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-home-')));
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  try {
    assert.equal(F.validateProjectRoot(root, { home }), root);
    assert.equal(code(() => F.validateProjectRoot('/', { home })), 'INVALID_ROOT', 'filesystem root');
    assert.equal(code(() => F.validateProjectRoot(home, { home })), 'INVALID_ROOT', 'home itself');
    assert.equal(code(() => F.validateProjectRoot(path.dirname(home), { home })), 'INVALID_ROOT', 'ancestor of home');
    assert.equal(code(() => F.validateProjectRoot(elsewhere, { home })), 'NOT_A_PROJECT', 'no LLM-IDE marker');
    assert.equal(code(() => F.validateProjectRoot('relative/path', { home })), 'INVALID_ROOT', 'relative');
    assert.equal(code(() => F.validateProjectRoot(`${root}\nx`, { home })), 'INVALID_ROOT', 'control character');
    assert.equal(code(() => F.validateProjectRoot(path.join(root, 'missing'), { home })), 'ROOT_NOT_FOUND', 'missing');
    const link = path.join(os.tmpdir(), `docgen-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(root, link);
    try {
      assert.equal(code(() => F.validateProjectRoot(link, { home })), 'INVALID_ROOT', 'symlinked root');
    } finally {
      fs.unlinkSync(link);
    }
  } finally {
    cleanup(root);
    cleanup(home);
  }
});

test('isOverBroadRoot mirrors SystemBridge.isOverBroadRoot', () => {
  assert.equal(F.isOverBroadRoot('/', '/Users/a'), true);
  assert.equal(F.isOverBroadRoot('/Users', '/Users/a'), true);
  assert.equal(F.isOverBroadRoot('/Users/a', '/Users/a'), true);
  assert.equal(F.isOverBroadRoot('/Users/a/proj', '/Users/a'), false);
  assert.equal(F.isOverBroadRoot('/Users/ab', '/Users/a'), false, 'a prefix of a name is not an ancestor');
});

test('resolveOutputDirectory: explicit path wins over the project data folder', () => {
  assert.equal(F.resolveOutputDirectory({ localFolderPath: '/x', projectRoot: '/p' }), '/x');
});
