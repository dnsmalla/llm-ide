// Settings → Server & Backend → Remote server → Deploy (Phase 2). The pure model: it validates the
// domain, asks for an explicit typed confirmation, and never carries a secret. The host commands
// own SSH, the env file and the health check; this model only sequences them.
import { Store } from "./store.ts";
import type { RemoteServerConfig } from "./host.ts";

export interface DeployStage { id: string; title: string; mutating: boolean; detail: string }
export interface DeployPlan {
  id: string; version: string; domain: string; arch: string; stages: DeployStage[];
  blockers: string[]; warnings: string[]; confirmation: string; bundlePath: string; createdAt: number;
}
export interface Bootstrap { installed: boolean; command: string; staging: string }
export interface DeployReport {
  version: string; url: string; apiVersion: number; hub: boolean; ownerWindowOpen: boolean;
  setupUrl: string | null; rolledBack: boolean; failedStage: string | null;
}
export interface DeployTarget { host: string; port: number; user: string; keyPath: string }

export interface DeployIo {
  plan(target: DeployTarget, domain: string, reviewAck: boolean): Promise<DeployPlan>;
  bootstrap(target: DeployTarget): Promise<Bootstrap>;
  run(target: DeployTarget, planId: string, confirmation: string): Promise<DeployReport>;
  lock(target: DeployTarget): Promise<void>;
  rollback(target: DeployTarget): Promise<void>;
}

export type DeployPhase = "idle" | "planning" | "bootstrapping" | "deploying" | "open" | "done" | "failed";

export interface DeployState {
  domain: string;
  confirmation: string;
  reviewAck: boolean;
  phase: DeployPhase;
  plan: DeployPlan | null;
  report: DeployReport | null;
  bootstrap: Bootstrap | null;
  error: string | null;
}

export const DEPLOY_INITIAL: DeployState = {
  domain: "", confirmation: "", reviewAck: false, phase: "idle", plan: null, report: null, bootstrap: null, error: null,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function decodeDeployPlan(raw: unknown): DeployPlan | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.domain !== "string" || typeof raw.version !== "string") return null;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : null;
  const blockers = strings(raw.blockers); const warnings = strings(raw.warnings);
  if (!blockers || !warnings || !Array.isArray(raw.stages)) return null;
  const stages: DeployStage[] = [];
  for (const s of raw.stages) {
    if (!isRecord(s) || typeof s.id !== "string" || typeof s.title !== "string" || typeof s.mutating !== "boolean" || typeof s.detail !== "string") return null;
    stages.push({ id: s.id, title: s.title, mutating: s.mutating, detail: s.detail });
  }
  if (typeof raw.confirmation !== "string" || typeof raw.bundlePath !== "string" || typeof raw.createdAt !== "number") return null;
  return { id: raw.id, version: raw.version, domain: raw.domain, arch: String(raw.arch ?? ""), stages, blockers, warnings,
    confirmation: raw.confirmation, bundlePath: raw.bundlePath, createdAt: raw.createdAt };
}

export function decodeDeployReport(raw: unknown): DeployReport | null {
  if (!isRecord(raw) || typeof raw.version !== "string" || typeof raw.url !== "string" || typeof raw.hub !== "boolean"
    || typeof raw.ownerWindowOpen !== "boolean" || typeof raw.rolledBack !== "boolean" || typeof raw.apiVersion !== "number") return null;
  return {
    version: raw.version, url: raw.url, apiVersion: raw.apiVersion, hub: raw.hub, ownerWindowOpen: raw.ownerWindowOpen,
    setupUrl: typeof raw.setupUrl === "string" ? raw.setupUrl : null,
    rolledBack: raw.rolledBack,
    failedStage: typeof raw.failedStage === "string" ? raw.failedStage : null,
  };
}

export function decodeBootstrap(raw: unknown): Bootstrap | null {
  if (!isRecord(raw) || typeof raw.installed !== "boolean" || typeof raw.command !== "string" || typeof raw.staging !== "string") return null;
  return { installed: raw.installed, command: raw.command, staging: raw.staging };
}

export const targetOf = (c: RemoteServerConfig): DeployTarget => ({ host: c.host.trim(), port: c.port, user: c.user.trim(), keyPath: c.keyPath.trim() });
export const deployReady = (c: RemoteServerConfig): boolean => c.host.trim().length > 0 && c.user.trim().length > 0 && c.keyPath.trim().length > 0;
export const canDeploy = (s: DeployState): boolean => s.plan !== null && s.plan.blockers.length === 0 && s.confirmation === s.plan.confirmation && s.phase !== "deploying";

export class RemoteDeployModel extends Store<DeployState> {
  readonly #io: DeployIo;
  readonly #config: () => RemoteServerConfig;
  constructor(io: DeployIo, config: () => RemoteServerConfig) { super({ ...DEPLOY_INITIAL }); this.#io = io; this.#config = config; }

  setDomain(domain: string): void { this.set({ domain: domain.trim().toLowerCase(), plan: null, report: null, error: null, phase: "idle" }); }
  setConfirmation(v: string): void { this.set({ confirmation: v.trim() }); }
  setReviewAck(v: boolean): void { this.set({ reviewAck: v, plan: null, error: null }); }

  async preflight(): Promise<void> {
    const c = this.#config();
    if (!deployReady(c)) { this.set({ error: "Enter the server details and save them first." }); return; }
    this.set({ phase: "planning", error: null, report: null });
    try {
      const plan = await this.#io.plan(targetOf(c), this.getState().domain, this.getState().reviewAck);
      this.set({ plan, phase: "idle", error: plan.blockers.length ? `Cannot deploy: ${plan.blockers.join(", ")}` : null });
    } catch (e) { this.set({ phase: "failed", error: text(e) }); }
  }

  async bootstrapHelper(): Promise<void> {
    const c = this.#config();
    this.set({ phase: "bootstrapping", error: null });
    try { this.set({ bootstrap: await this.#io.bootstrap(targetOf(c)), phase: "idle" }); }
    catch (e) { this.set({ phase: "failed", error: text(e) }); }
  }

  async deploy(): Promise<void> {
    const s = this.getState();
    if (!s.plan || !canDeploy(s)) { this.set({ error: "Run the preflight and type the domain to confirm." }); return; }
    this.set({ phase: "deploying", error: null });
    try {
      const report = await this.#io.run(targetOf(this.#config()), s.plan.id, s.confirmation);
      this.set({ report, phase: report.rolledBack || report.failedStage ? "failed" : report.ownerWindowOpen ? "open" : "done",
        error: report.rolledBack ? `Deploy failed at ${report.failedStage ?? "a stage"}; the previous release was restored.` : null });
    } catch (e) { this.set({ phase: "failed", error: text(e) }); }
  }

  async lockRegistration(): Promise<void> {
    this.set({ phase: "deploying", error: null });
    try { await this.#io.lock(targetOf(this.#config())); this.set({ phase: "done", report: this.getState().report ? { ...this.getState().report!, ownerWindowOpen: false } : null }); }
    catch (e) { this.set({ phase: "failed", error: text(e) }); }
  }

  async rollback(): Promise<void> {
    this.set({ phase: "deploying", error: null });
    try { await this.#io.rollback(targetOf(this.#config())); this.set({ phase: "idle", error: "Rolled back to the previous release." }); }
    catch (e) { this.set({ phase: "failed", error: text(e) }); }
  }
}

function text(e: unknown): string {
  if (typeof e === "string") return e;
  if (isRecord(e) && typeof e.message === "string") return e.message;
  return e instanceof Error ? e.message : "The deploy failed.";
}
