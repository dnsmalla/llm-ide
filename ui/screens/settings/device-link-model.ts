// Settings: the Live Chat pairing list (host_api_devices) and the offline-sync list (sync_devices) are two separate
// registries with no shared id, so a lost phone must be removed from both. This is the pure logic that links the two
// revoke confirmations: which entry of the OTHER list is a likely match, and how the outcome of several revokes is
// reported. No React, no network: the callers pass the revoke calls in.
export type Platform = "ios" | "web";

/** The one line each card shows. */
export const SEPARATE_LISTS_HINT = "Live Chat pairing and offline sync are separate lists. A lost phone or browser may need removing from both.";
export const OFFLINE_UNAVAILABLE_NOTE = "Offline sync could not be checked, so only Live Chat pairing is revoked here. Check Phone and web sync for the same device.";
export const LIVE_UNAVAILABLE_NOTE = "Live Chat pairing could not be checked, so only offline sync is revoked here. Check Live Chat pairing for the same device.";

export interface AlsoCandidate { deviceId: string; label: string; checked: boolean }
export interface OtherEntry { deviceId: string; name: string; platform: Platform | null }

/** Case and whitespace insensitive form used to compare names. */
export const normalizeName = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** A Live Chat device carries only a free-text name (e.g. "iPhone"), so its platform is a hint read from that name; null when it says nothing. */
export function livePlatform(name: string): Platform | null {
  const n = normalizeName(name);
  if (/\b(iphone|ipad|ios)\b/.test(n)) return "ios";
  if (/\b(browser|web|chrome|safari|firefox|edge|brave|opera)\b/.test(n)) return "web";
  return null;
}

/** The id to pre-check, or null. Same platform only; then one normalised name match wins, or the only device of that
 *  platform. Two name matches, or several same-platform devices without a name match, pre-check nothing: never guess between two phones. */
export function pickLikelyMatch(platform: Platform | null, name: string, others: readonly OtherEntry[]): string | null {
  if (!platform) return null;
  const same = others.filter((o) => o.platform === platform);
  const named = same.filter((o) => normalizeName(o.name) === normalizeName(name));
  if (named.length === 1) return named[0].deviceId;
  if (named.length > 1) return null;
  return same.length === 1 ? same[0].deviceId : null;
}

export interface SyncLite { deviceId: string; name: string; tier: Platform }
export interface LiveLite { deviceId: string; name: string }
const tierLabel = (t: Platform): string => (t === "ios" ? "iPhone app" : "browser");

/** Revoking a Live Chat device: the offline-sync devices to offer, with at most one pre-checked. */
export function offlineCandidates(live: LiveLite, sync: readonly SyncLite[]): AlsoCandidate[] {
  const pick = pickLikelyMatch(livePlatform(live.name), live.name, sync.map((s) => ({ deviceId: s.deviceId, name: s.name, platform: s.tier })));
  return sync.map((s) => ({ deviceId: s.deviceId, label: `${s.name} · ${tierLabel(s.tier)}`, checked: s.deviceId === pick }));
}

/** Revoking an offline-sync device: the Live Chat devices to offer, with at most one pre-checked. */
export function liveCandidates(sync: SyncLite, live: readonly LiveLite[]): AlsoCandidate[] {
  const pick = pickLikelyMatch(sync.tier, sync.name, live.map((l) => ({ deviceId: l.deviceId, name: l.name, platform: livePlatform(l.name) })));
  return live.map((l) => ({ deviceId: l.deviceId, label: l.name, checked: l.deviceId === pick }));
}

export interface RevokeStep { label: string; run: () => Promise<boolean> }
export interface RevokeOutcome { label: string; ok: boolean; error: string | null }

/** Runs the primary revoke (steps[0]) first. If it fails nothing else is attempted (the user's main intent did not
 *  happen); otherwise every extra runs on its own, so one failure never hides another. A step is ok only when it returned true. */
export async function runRevokes(steps: readonly RevokeStep[], describe: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e))): Promise<RevokeOutcome[]> {
  const out: RevokeOutcome[] = [];
  for (let i = 0; i < steps.length; i++) {
    try {
      const ok = await steps[i].run();
      out.push({ label: steps[i].label, ok, error: ok ? null : "the core did not confirm it" });
    } catch (e) {
      out.push({ label: steps[i].label, ok: false, error: describe(e) });
    }
    if (i === 0 && !out[0].ok) break;
  }
  return out;
}

/** One sentence per fact; success is never claimed for a step that failed or was not attempted. */
export function summarizeRevokes(outcomes: readonly RevokeOutcome[]): { ok: boolean; text: string } {
  const done = outcomes.filter((o) => o.ok).map((o) => o.label);
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return { ok: true, text: `Removed ${done.join(", ")}.` };
  const failText = failed.map((o) => `Could not remove ${o.label}${o.error ? ` (${o.error})` : ""}.`).join(" ");
  return { ok: false, text: `${done.length ? `Removed ${done.join(", ")}. ` : ""}${failText}` };
}
