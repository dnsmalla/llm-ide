// The working directory an extension side-panel chat turn runs in.
//
// The v2 engine needs a workspace root (the SDK's cwd). The extension has no
// project folder and must not name filesystem paths, so a turn that says
// `agentContext.surface: 'extension'` without a workspaceRoot gets this
// server-owned scratch folder instead: empty, inside the install's data
// directory (or the OS temp dir when running from a source checkout), never a
// user project. The chat is read-only (mode 'ask'), so nothing is written here.
//
// R-034 #4: when a userId is given the scratch folder is PER USER
// (`<data>/extension-chat/<user>`), so two members' phone/browser/extension
// chats never share a workspace on a hub. No userId keeps the old shared path
// for tests and single-user callers.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.mjs';

function userSegment(userId) {
  if (userId === null || userId === undefined || userId === '') return null;
  const raw = String(userId);
  // Ids are server-generated (u<id> / a UUID); anything else is hashed rather than trusted as a path.
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function extensionChatWorkspace(dataDir = config.dataDir, userId = null) {
  const base = path.join(dataDir || path.join(os.tmpdir(), 'llm-ide'), 'extension-chat');
  const segment = userSegment(userId);
  const dir = segment ? path.join(base, segment) : base;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
