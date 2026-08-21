// Tests for extension/connectors/connector-state.mjs — per-user selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshEnv() {
  // The state module reads LLMIDE_PLUGIN_DIR's parent dir (same override
  // convention as plugins/state.mjs and mcp/state.mjs).
  const dir = mkdtempSync(join(tmpdir(), 'connector-state-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  process.env.LLMIDE_PLUGIN_DIR = join(dir, 'plugins');
  return dir;
}

async function loadModule() {
  // Fresh import per test so module-level caching cannot leak state.
  const mod = await import(`../connectors/connector-state.mjs?${Date.now()}-${Math.random()}`);
  return mod;
}

test('first read pre-selects box and slack (existing users see no change)', async () => {
  const dir = freshEnv();
  try {
    const { selectedConnectors } = await loadModule();
    const selected = selectedConnectors('user-1');
    assert.deepEqual([...selected].sort(), ['box', 'slack']);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('select/deselect round-trips and persists across module reloads', async () => {
  const dir = freshEnv();
  try {
    const m1 = await loadModule();
    assert.equal(m1.selectConnector('user-1', 'miro'), true);
    assert.equal(m1.selectedConnectors('user-1').has('miro'), true);
    const m2 = await loadModule();
    assert.equal(m2.selectedConnectors('user-1').has('miro'), true);
    m2.deselectConnector('user-1', 'miro');
    assert.equal(m2.selectedConnectors('user-1').has('miro'), false);
    assert.equal((await loadModule()).selectedConnectors('user-1').has('miro'), false);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown catalog ids are refused', async () => {
  const dir = freshEnv();
  try {
    const { selectConnector } = await loadModule();
    assert.equal(selectConnector('user-1', 'not-a-connector'), false);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selections are per-user', async () => {
  const dir = freshEnv();
  try {
    const m = await loadModule();
    m.selectConnector('user-1', 'miro');
    assert.equal(m.selectedConnectors('user-2').has('miro'), false);
    assert.deepEqual([...m.selectedConnectors('user-2')].sort(), ['box', 'slack']);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneOrphanSelections drops ids removed from the catalog', async () => {
  const dir = freshEnv();
  try {
    const m = await loadModule();
    m.selectConnector('user-1', 'miro');
    // Hand-write an orphan id behind the module's back.
    writeFileSync(join(dir, 'connector-state.json'),
      JSON.stringify({ 'user-1': { selected: ['miro', 'retired-one'] } }), 'utf8');
    m.pruneOrphanSelections();
    assert.equal(m.selectedConnectors('user-1').has('retired-one'), false);
    assert.equal(m.selectedConnectors('user-1').has('miro'), true);
  } finally {
    delete process.env.LLMIDE_PLUGIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
