// One AttachmentManager per chat, kept outside the composer instance. The composer remounts for reasons other than
// a chat switch ("Add memory to prompt", Plan "Refine", an empty-chat suggestion, Graph "Ask in Chat"); a manager
// owned by the composer would drop the user's attached files each time and the next send would go without them.
import { AttachmentManager, type ManagerDeps } from "./manager";

interface Slot { manager: AttachmentManager; host: unknown; project: unknown; blobs: unknown }

export interface AttachmentRegistry {
  /** The chat's manager; rebuilt (the old one disposed) only when the host, project reader or blob seam changed. */
  get(chatId: string, deps: ManagerDeps): AttachmentManager;
  /** Screen unmount: cancel every read and release every handle. */
  disposeAll(): void;
}

export function createAttachmentRegistry(make: (deps: ManagerDeps) => AttachmentManager = (d) => new AttachmentManager(d)): AttachmentRegistry {
  const slots = new Map<string, Slot>();
  return {
    get(chatId, deps) {
      const slot = slots.get(chatId);
      if (slot && slot.host === deps.host && slot.project === (deps.project ?? null) && slot.blobs === (deps.blobs ?? null)) return slot.manager;
      slot?.manager.dispose();
      const manager = make(deps);
      slots.set(chatId, { manager, host: deps.host, project: deps.project ?? null, blobs: deps.blobs ?? null });
      return manager;
    },
    disposeAll() {
      for (const s of slots.values()) s.manager.dispose();
      slots.clear();
    },
  };
}
