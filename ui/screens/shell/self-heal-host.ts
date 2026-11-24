// The Self-Heal fix run's host adapter (plan B): the desktop host's worktree, verify, diff, apply and remove commands
// plus the core's Loop agent. Settings (Try to fix) and the daily automatic run (settings/self-heal-auto.ts) share it.
import type { SelfHealHost } from "../settings/host";
import { decodeDiff, decodePrepared, decodeVerified } from "../settings/self-heal-model";
import { AGENT_TIMEOUT_MS } from "../settings/self-heal-run";
import type { CoreClient } from "./core";
import { flushSelfHealNow } from "./self-heal";

export interface SelfHealHostDeps {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  core: Pick<CoreClient, "requestRaw">;
}

export function createSelfHealHost(d: SelfHealHostDeps): SelfHealHost {
  return {
    async source() {
      const r = await d.invoke<unknown>("self_heal_source");
      if (typeof r !== "string" || r === "") throw new Error("the desktop host returned no source checkout");
      return r;
    },
    async prepare(runId, batch) {
      const p = decodePrepared(await d.invoke<unknown>("self_heal_prepare", { runId, batch }));
      if (!p) throw new Error("the desktop host returned a worktree this app cannot read");
      return p;
    },
    async agentRun(body) {
      const r = await d.core.requestRaw("/kb/loop/agent-run", { method: "POST", body, timeoutMs: AGENT_TIMEOUT_MS + 60_000 });
      return { status: r.status, body: r.body ?? null };
    },
    async verify(runId) {
      const v = decodeVerified(await d.invoke<unknown>("self_heal_verify", { runId }));
      if (!v) throw new Error("the desktop host returned a verify result this app cannot read");
      return v;
    },
    async diff(runId) {
      const v = decodeDiff(await d.invoke<unknown>("self_heal_diff", { runId }));
      if (!v) throw new Error("the desktop host returned a diff this app cannot read");
      return v;
    },
    async apply(runId, patchId) {
      await d.invoke<unknown>("self_heal_apply", { runId, patchId });
    },
    async remove(runId) {
      await d.invoke<unknown>("self_heal_remove", { runId });
    },
    flushIncidents: () => flushSelfHealNow(),
  };
}
