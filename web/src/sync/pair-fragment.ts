// Imported first by main.tsx: takes the #pair=… fragment and removes it from the address bar and history before any
// other module runs (design 5.2; schema/sync/v1 "Enrollment" item 1). The link stays in this module's memory only.
let link: string | null = null;
if (typeof location !== "undefined" && typeof history !== "undefined" && location.hash.startsWith("#pair=")) {
  link = location.href;
  history.replaceState(null, "", location.pathname + location.search);
}
export function takePairLink(): string | null { const l = link; link = null; return l; }
