// A launcher for stdio MCP servers: runs the real command in its OWN process
// group and kills that whole group when the server exits, when this launcher is
// told to stop, or when its parent (the LLM-IDE server) disappears. The MCP
// SDK's stdio transport spawns the child itself and cannot make it a group
// leader, so a server that forks helpers would leave them running after the
// turn; routing the spawn through this file fixes that without touching the SDK.
//
// Usage: node spawn-group.mjs <command> [args...]    (stdio is inherited)
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) process.exit(2);

const child = spawn(command, args, { stdio: 'inherit', detached: true, shell: false });
const parent = process.ppid;
let finishing = false;

const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { /* group already gone */ } };

function finish(code) {
  if (finishing) return;
  finishing = true;
  clearInterval(watch);
  killGroup('SIGTERM');
  // The 'exit' handler below sends SIGKILL to whatever ignored the SIGTERM.
  setTimeout(() => process.exit(code), 500);
}

child.on('error', () => finish(127));
child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => finish(1));
process.on('exit', () => killGroup('SIGKILL'));
// If the parent dies without closing us (SIGKILL), stdin EOF reaches the server
// but not us; notice the re-parenting and clean up.
const watch = setInterval(() => { if (process.ppid !== parent) finish(1); }, 1000);
