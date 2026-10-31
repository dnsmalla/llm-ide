// isTooBroadTrustRoot: containers are refused, projects inside them are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { isTooBroadTrustRoot as broad } from '../core/broad-root.mjs';

test('containers and system trees are too broad to trust', () => {
  for (const p of ['/', '/Volumes', '/Volumes/Disk', '/Users', '/Users/alice', '/home/bob', '/private/tmp', '/tmp', '/var/tmp', '/private/var/tmp',
    '/System', '/System/Library/x', '/Users/alice/Documents', '/home/bob/Downloads',
    'C:\\', 'C:\\Users', 'C:\\Users\\bob', 'C:\\Windows', 'C:\\Windows\\System32', '\\\\server\\share', '//server/share']) {
    assert.equal(broad(p), true, p);
  }
  const home = os.homedir();
  for (const d of ['Documents', 'Desktop', 'Downloads']) assert.equal(broad(path.join(home, d)), true, d);
});

test('a project inside those containers is fine', () => {
  const home = os.homedir();
  for (const p of [path.join(home, 'Desktop', 'LLM'), path.join(home, 'Documents', 'proj'), '/Volumes/Disk/proj', '/Users/alice/work/app',
    '/home/bob/code', '/private/tmp/proj', '/var/tmp/proj', '//server/share/proj']) {
    assert.equal(broad(p), false, p);
  }
});
