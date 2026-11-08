// Every extension test gets a throwaway add-on root: no test may read or write the real
// ~/Library/Application Support/llm-ide state. Spawned servers inherit this env.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.LLMIDE_PLUGIN_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'llmide-test-addons-'));
  process.env.LLMIDE_PLUGIN_DIR = join(dir, 'plugins');
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
}
