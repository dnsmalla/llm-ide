// The Graph section's page choice, persisted like the Mac's `graphSectionPage` AppStorage value. System is the
// default, as on the Mac; an unknown stored value reads as System.
export type GraphPage = "system" | "code";

const KEY = "llmide.graphPage";

export function readGraphPage(storage: Storage | undefined = globalThis.localStorage): GraphPage {
  try {
    return storage?.getItem(KEY) === "code" ? "code" : "system";
  } catch {
    return "system";
  }
}

export function storeGraphPage(page: GraphPage, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, page);
  } catch {
    // Storage unavailable: the in-memory choice stands for this session.
  }
}
