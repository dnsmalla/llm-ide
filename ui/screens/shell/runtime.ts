// Process-wide singletons the screens share: the core status store and the core client.
import { createCoreClient } from "./core";
import { createChatBinding } from "./chat-binding";
import { host, invokeHost, isHostAvailable } from "./host";
import { createStatusStore } from "./status-store";

export const coreStatusStore = createStatusStore({ fetchStatus: () => host.coreStatus() });

/** The one core client. Its base URL follows the supervised core (it changes across restarts). */
export const core = createCoreClient({
  baseUrl: () => {
    const s = coreStatusStore.getSnapshot().status;
    return s && s.state === "ready" && s.url ? s.url : null;
  },
});

/** Binds the signed-in session to the host's chat store (desktop only; a no-op in a plain browser). */
export const chatBinding = createChatBinding(core, invokeHost, isHostAvailable);

// A restarted or replaced core means the host's bound session (and its core URL) is stale: bind again with the
// current token. Only a change of URL or restart count while ready triggers it.
let lastBind = "";
coreStatusStore.subscribe(() => {
  const st = coreStatusStore.getSnapshot().status;
  if (!st || st.state !== "ready") return;
  const key = `${st.url}#${st.restarts}`;
  if (lastBind !== "" && key !== lastBind) core.republishAccessToken();
  lastBind = key;
});
