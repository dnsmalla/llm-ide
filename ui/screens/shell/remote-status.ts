// Remote-mode status and the explicit offline fallback. The app never silently starts a local core:
// only `remoteFallbackAction` writes the local mode and asks the host to restart.
export type RemoteState = "connecting" | "online" | "offline";

export function remoteBanner(state: RemoteState, hasSession: boolean, errorCode: string | null = null): { title: string; body: string } | null {
  if (errorCode === "HUB_PIN_MISMATCH") {
    return {
      title: "Hub certificate changed",
      body: "The hub presents a different certificate than the one you trusted. In Settings → Server & Backend, probe it again and confirm the new fingerprint before using this hub.",
    };
  }
  if (state === "online") return null;
  if (state === "connecting") return { title: "Connecting to the hub…", body: "No chats or projects are available until the hub answers." };
  return {
    title: "Hub unreachable",
    body: hasSession
      ? "No new data until the hub is back. You can keep this window open and retry, or work offline with the local core."
      : "The hub did not answer. Check the address and certificate, or work offline with the local core.",
  };
}

// R-034 #11: the last hub-level error a proxied request answered with. Only the pin mismatch is kept:
// it is the one error the generic "unreachable" text would hide. Any successful answer clears it.
let hubError: string | null = null;
const hubErrorListeners = new Set<() => void>();
export function noteHubError(code: string | null): void {
  const next = code === "HUB_PIN_MISMATCH" ? code : null;
  if (next === hubError) return;
  hubError = next;
  for (const l of [...hubErrorListeners]) l();
}
export function getHubError(): string | null { return hubError; }
export function subscribeHubError(l: () => void): () => void {
  hubErrorListeners.add(l);
  return () => { hubErrorListeners.delete(l); };
}

export async function remoteFallbackAction(deps: { setMode(mode: "local"): Promise<void>; restart(): Promise<void> }): Promise<void> {
  await deps.setMode("local");
  await deps.restart();
}
