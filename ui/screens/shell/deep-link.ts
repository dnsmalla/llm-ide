import type { SectionId } from "./sections.ts";

/** The desktop section a `llmide://<tab>` link opens; null for anything malformed or unknown. */
export function deepLinkSection(raw: string): SectionId | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "llmide:" || url.username || url.password || url.port || url.pathname !== "") return null;
  const tab = url.hostname.toLowerCase();
  switch (tab) {
    case "transcript": return "live";
    case "plan": return "gantt";
    case "review": return "conflicts";
    case "history": return "chat";
    case "settings": return "settings";
    default: return null;
  }
}
