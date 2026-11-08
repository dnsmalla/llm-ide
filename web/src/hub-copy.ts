// A hub is the always-online core; offline sync/MEGA is a local-desktop feature (ADR 0020). The host
// says which it is in `host.hello.hostKind`; a missing/older value reads as a desktop.
export interface HelloLike { hostKind?: unknown }

export const isHubHello = (hello: HelloLike | null | undefined): boolean => hello?.hostKind === "hub";
export const hubCopy = (hello: HelloLike | null | undefined): string | null =>
  isHubHello(hello) ? "Connected to an always-online hub. Offline sync is a local-desktop feature." : null;
export const syncEntryVisible = (hello: HelloLike | null | undefined): boolean => !isHubHello(hello);
