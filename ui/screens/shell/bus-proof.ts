// The command-bus host proof, held in MEMORY ONLY. The host derives it from its per-launch approval key
// (`host_bus_proof`, desktop/src-tauri/src/host_approval.rs) and returns it solely to the main window and solely while
// the core is the one the host spawned and verified. It is a bearer secret equal in power to the Bypass key for bus
// approvals: this store never persists it, never exposes it to a log or the DOM, and `get()` returns it only while the
// core status says `ready` + `spawned` (an adopted, pending or restarting core never sees it).
import type { CoreStatus } from "./host";

const PROOF = /^[0-9a-f]{64}$/;

export interface BusProofStore {
  /** The proof for the current core, or null. */
  get(): string | null;
}

export interface BusProofOptions {
  invoke: (command: string) => Promise<unknown>;
  getStatus: () => CoreStatus | null;
  subscribeStatus: (listener: () => void) => () => void;
  /** False in a plain browser / tests: there is no host to ask. */
  isHost: () => boolean;
}

export function createBusProofStore(o: BusProofOptions): BusProofStore {
  let proof: string | null = null;
  let fetching = false;
  const eligible = (): boolean => {
    const s = o.getStatus();
    return o.isHost() && !!s && s.state === "ready" && s.trust === "spawned";
  };
  const refresh = (): void => {
    if (!eligible()) {
      proof = null;
      return;
    }
    if (proof !== null || fetching) return;
    fetching = true;
    o.invoke("host_bus_proof")
      .then((v) => {
        proof = typeof v === "string" && PROOF.test(v) && eligible() ? v : null;
      })
      .catch(() => {
        proof = null;
      })
      .finally(() => {
        fetching = false;
      });
  };
  o.subscribeStatus(refresh);
  refresh();
  return { get: () => (eligible() ? proof : null) };
}
