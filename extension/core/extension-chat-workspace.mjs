// The working directory an extension side-panel chat turn runs in.
//
// The v2 engine needs a workspace root (the SDK's cwd). The extension has no
// project folder and must not name filesystem paths, so a turn that says
// `agentContext.surface: 'extension'` without a workspaceRoot gets this
// server-owned scratch folder instead: empty, inside the install's data
// directory (or the OS temp dir when running from a source checkout), never a
// user project. The chat is read-only (mode 'ask'), so nothing is written here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.mjs';

export function extensionChatWorkspace(dataDir = config.dataDir) {
  const dir = path.join(dataDir || path.join(os.tmpdir(), 'llm-ide'), 'extension-chat');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
