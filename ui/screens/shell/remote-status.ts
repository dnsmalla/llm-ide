// Remote-mode status and the explicit offline fallback. The app never silently starts a local core:
// only `remoteFallbackAction` writes the local mode and asks the host to restart.
export type RemoteState = "connecting" | "online" | "offline";

export function remoteBanner(state: RemoteState, hasSession: boolean): { title: string; body: string } | null {
  if (state === "online") return null;
  if (state === "connecting") return { title: "Connecting to the hub…", body: "No chats or projects are available until the hub answers." };
  return {
    title: "Hub unreachable",
    body: hasSession
      ? "No new data until the hub is back. You can keep this window open and retry, or work offline with the local core."
      : "The hub did not answer. Check the address and certificate, or work offline with the local core.",
  };
}

export async function remoteFallbackAction(deps: { setMode(mode: "local"): Promise<void>; restart(): Promise<void> }): Promise<void> {
  await deps.setMode("local");
  await deps.restart();
}
