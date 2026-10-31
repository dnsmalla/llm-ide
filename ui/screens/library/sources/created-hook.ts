// A WriteHost that reports every successful `create` (so the Library list shows fetched notes without a rescan).
import type { SavedNote, WriteHost } from "../write/write-host.ts";

export function withCreatedHook(write: WriteHost, onCreated: (saved: SavedNote, text: string) => void): WriteHost {
  return {
    open: (rel) => write.open(rel),
    save: (rel, text, bom, hash, force) => write.save(rel, text, bom, hash, force),
    create: async (rel, text) => {
      const saved = await write.create(rel, text);
      onCreated(saved, text);
      return saved;
    },
    rename: (a, b) => write.rename(a, b),
    deleteMany: (rels) => write.deleteMany(rels),
  };
}
