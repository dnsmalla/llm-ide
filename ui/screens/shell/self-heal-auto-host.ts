// Wires Self-Heal's daily automatic run (settings/self-heal-auto.ts) into the running app: its saved switch and state,
// the Loop run manager for "a Loop run is busy", the shared host adapter for the fix run, and the host's
// `self_heal` notification. Started by the Shell's Self-Heal effect; does nothing until the host says this build records.
import { AUTO_CHECK_MS, autoTickOnce, loadAutoConfig, loadAutoState, saveAutoState, type AutoDeps } from "../settings/self-heal-auto";
import { decodeIncidents } from "../settings/self-heal-model";
import { runSelfHealFix } from "../settings/self-heal-run";
import type { CoreClient } from "./core";
import { notifyUser } from "./notify/notify";
import { selfHealEnabled } from "./self-heal";
import { createSelfHealHost } from "./self-heal-host";
import { settingsClientFrom } from "./settings-adapter";

const FIRST_CHECK_MS = 60_000;

/** Ids of the incidents that need a person (status needsHuman). */
async function needsHumanIds(core: Pick<CoreClient, "request">): Promise<Set<string>> {
  const list = decodeIncidents(await core.request<unknown>("/kb/self-heal/incidents"));
  return new Set(list.filter((i) => i.status === "needsHuman").map((i) => i.id));
}

/** Starts the checks; returns the stop function. A check never overlaps the previous one. */
export function startSelfHealAuto(d: {
  core: Pick<CoreClient, "request" | "requestRaw">;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  /** Signed in, the core ready and trusted: until then a check is skipped without using the day. */
  ready: () => boolean;
}): () => void {
  // The run manager is loaded lazily by the Shell too; until it is, no Loop run can be live.
  let liveRuns: (() => readonly unknown[]) | null = null;
  void import("../loop/native/run-manager.ts").then((m) => { liveRuns = m.liveRuns; }, () => undefined);
  const deps: AutoDeps = {
    now: () => new Date(),
    config: loadAutoConfig,
    state: loadAutoState,
    save: saveAutoState,
    recording: selfHealEnabled,
    ready: d.ready,
    loopBusy: () => (liveRuns?.().length ?? 0) > 0,
    needsHuman: () => needsHumanIds(d.core),
    run: () => runSelfHealFix(settingsClientFrom(d.core), createSelfHealHost(d), undefined, { auto: true }),
    notify: () => notifyUser("self_heal"),
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    try {
      await autoTickOnce(deps);
    } catch {
      // best effort: the next check tries again
    }
    if (!stopped) timer = setTimeout(() => void tick(), AUTO_CHECK_MS);
  };
  timer = setTimeout(() => void tick(), FIRST_CHECK_MS);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
