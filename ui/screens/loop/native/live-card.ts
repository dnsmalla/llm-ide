// The one run currently executing, written by the Loop runner and read by the Board. localStorage is enough: both
// views live in the same webview, and the card must survive switching from Editor to Board mid-run.
export interface LiveLoopCard {
  loopName: string;
  runId: string;
  stageName: string;
  startedAt: string;
  /** The model the running agent step uses; absent for shell steps and unknown routing. */
  model?: string | null;
}

const KEY = "llmide.loopLive";

export function setLiveCard(card: LiveLoopCard): void {
  try { localStorage.setItem(KEY, JSON.stringify(card)); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent("llmide-loop-live")); } catch { /* no window in tests */ }
}

export function updateLiveStage(runId: string, stageName: string): void {
  const cur = readLiveCard();
  if (!cur || cur.runId !== runId || !stageName) return;
  setLiveCard({ ...cur, stageName });
}

export function updateLiveModel(runId: string, model: string | null): void {
  const cur = readLiveCard();
  if (!cur || cur.runId !== runId || (cur.model ?? null) === model) return;
  setLiveCard({ ...cur, model });
}

/** The live card's status line: `Running now`, plus the model while an agent step runs. */
export function liveCardNote(card: Pick<LiveLoopCard, "model">): string {
  return card.model ? `Running now · ${card.model}` : "Running now";
}

export function clearLiveCard(runId?: string): void {
  const cur = readLiveCard();
  if (runId && cur && cur.runId !== runId) return;
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent("llmide-loop-live")); } catch { /* no window */ }
}

export function readLiveCard(): LiveLoopCard | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LiveLoopCard>;
    return typeof v.loopName === "string" && typeof v.runId === "string" && typeof v.stageName === "string" && typeof v.startedAt === "string"
      ? { loopName: v.loopName, runId: v.runId, stageName: v.stageName, startedAt: v.startedAt, ...(typeof v.model === "string" ? { model: v.model } : {}) } : null;
  } catch { return null; }
}
