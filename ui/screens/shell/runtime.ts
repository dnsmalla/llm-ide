// Process-wide singletons the screens share: the core status store and the core client.
import { createCoreClient } from "./core";
import { host } from "./host";
import { createStatusStore } from "./status-store";

export const coreStatusStore = createStatusStore({ fetchStatus: () => host.coreStatus() });

/** The one core client. Its base URL follows the supervised core (it changes across restarts). */
export const core = createCoreClient({
  baseUrl: () => {
    const s = coreStatusStore.getSnapshot().status;
    return s && s.state === "ready" && s.url ? s.url : null;
  },
});
