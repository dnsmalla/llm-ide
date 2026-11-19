// Review of learned knowledge that came from another project (plan 2026-11-19, phase 5). Items wait in
// `<project>/system/self-improvement/inbox/<source>/` (moved there by ensureOwnFolder, or copied there by the user);
// nothing in the inbox is ever read into a prompt. This module lists and decides the two kinds the core owns, memory
// facts and Self-Heal notes; the Loop page decides lessons and Loop changes itself (ui/screens/loop/native/improve).
// Adopt writes the item into this project's own file through the same writer (and caps) as a local one; both Adopt
// and Dismiss then remove it from the inbox file.
import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfImprovementDir } from './paths.mjs';
import { ensureOwnFolder, INBOX, MANIFEST, SOURCE_RE } from './self-improvement-folder.mjs';
import { appendChatMemory, factIndex, parseChatMemoryFacts, renderChatMemoryFile } from './memory-writer.mjs';
import { appendNotes } from '../core/self-heal-batch.mjs';

const NOTE_MAX = 4000;
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  try { writeFileSync(tmp, text, 'utf8'); renameSync(tmp, path); } catch (err) { try { unlinkSync(tmp); } catch { /* gone */ } throw err; }
}

/** The `## …` sections of a notes file, each trimmed and capped. */
export function noteSections(text) {
  return String(text ?? '').split('\n## ').slice(1).map((s) => `## ${s.trim()}`.slice(0, NOTE_MAX));
}

function sourceDirs(root) {
  const dir = join(selfImprovementDir(root), INBOX);
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && SOURCE_RE.test(d.name)).map((d) => d.name).sort();
  } catch { return []; }
}

/**
 * The inbox after making sure the folder is this project's own: per source, its project name, memory facts and
 * Self-Heal notes, and how many lessons and Loop changes wait for the Loop page.
 */
export function readInbox(root) {
  const { moved } = ensureOwnFolder(root);
  const base = join(selfImprovementDir(root), INBOX);
  const sources = sourceDirs(root).map((name) => {
    const dir = join(base, name);
    let projectName = name;
    try { const m = JSON.parse(readText(join(dir, MANIFEST)) ?? '{}'); if (typeof m.projectName === 'string' && m.projectName) projectName = m.projectName.slice(0, 100); } catch { /* the folder name */ }
    let lessons = 0;
    try { lessons = (JSON.parse(readText(join(dir, 'lessons.json')) ?? '{}').lessons ?? []).length; } catch { /* none readable */ }
    const changes = (readText(join(dir, 'changes.jsonl')) ?? '').split('\n').filter((l) => l.trim() !== '').length;
    return {
      name, projectName,
      memory: parseChatMemoryFacts(readText(join(dir, 'memory.md')) ?? ''),
      notes: noteSections(readText(join(dir, 'self-heal.md'))),
      lessons, changes,
    };
  });
  return { moved, sources };
}

/**
 * Adopt or dismiss one memory fact or Self-Heal note of `source`. Returns false when the source or item is unknown
 * (already decided, or a stale screen). The item leaves the inbox only after an adopt was written.
 */
export function decideInboxItem(root, { source, kind, key, action }) {
  if (typeof source !== 'string' || !SOURCE_RE.test(source) || !sourceDirs(root).includes(source)) return false;
  const dir = join(selfImprovementDir(root), INBOX, source);
  if (kind === 'memory') {
    const file = join(dir, 'memory.md');
    const facts = parseChatMemoryFacts(readText(file) ?? '');
    const fact = facts.find((f) => factIndex(f) === factIndex(String(key ?? '')));
    if (!fact) return false;
    if (action === 'adopt') appendChatMemory({ root, facts: [fact] });
    writeAtomic(file, renderChatMemoryFile(facts.filter((f) => f !== fact)));
    return true;
  }
  if (kind === 'note') {
    const file = join(dir, 'self-heal.md');
    const sections = noteSections(readText(file));
    const at = sections.indexOf(String(key ?? ''));
    if (at < 0) return false;
    if (action === 'adopt') {
      const own = join(selfImprovementDir(root), 'self-heal.md');
      writeAtomic(own, appendNotes(readText(own) ?? '', [`\n${sections[at]}\n`]));
    }
    const rest = sections.filter((_, k) => k !== at);
    writeAtomic(file, appendNotes('', rest.map((s) => `\n${s}\n`)));
    return true;
  }
  return false;
}

