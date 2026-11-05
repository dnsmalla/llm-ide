// Give every production build its own service-worker cache name. Without this, a deploy that only changes
// index.html and hashed assets leaves sw.js byte-identical, the browser keeps the old worker, and old assets
// are never evicted. `npm run build` rewrites the placeholder in dist/sw.js after Vite copies public/.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SW_MARKER = "__SW_BUILD__";

export function stampSw(path, seed = `${Date.now()}-${Math.random()}`) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(SW_MARKER)) throw new Error(`${path} has no ${SW_MARKER} marker`);
  const id = createHash("sha256").update(`${seed}\n${source}`).digest("hex").slice(0, 12);
  const out = source.replaceAll(SW_MARKER, id);
  writeFileSync(path, out);
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const path = resolve(process.argv[2] ?? "dist/sw.js");
  const id = stampSw(path);
  console.log(`stamped ${path} with ${id}`);
}
