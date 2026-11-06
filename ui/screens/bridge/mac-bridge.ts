// The Mac app's Mobile Control WebSocket is the local automation bridge. The desktop pairs like the iPhone
// (Settings → Mobile Control shows the PIN) and then reads/controls the Mac's own AutoTask and Loop services.
// Nothing here re-implements a task or a loop: it sends the SharedProtocol messages and renders the replies.
export const BRIDGE_URL = "ws://127.0.0.1:3006";
const STORE_KEY = "llmide.macBridge";

export type BridgePhase = "idle" | "connecting" | "needs-pin" | "connected" | "error";

export interface AutoTaskInfo { id: string; label: string; enabled: boolean; lastError: string | null }
export interface AutoTaskState {
  masterEnabled: boolean;
  isRunning: boolean;
  currentTask: string | null;
  currentStep: string | null;
  statusMessage: string | null;
  lastRunDate: number | null;
  createdCount: number;
  implementedCount: number;
  failedCount: number;
  tasks: AutoTaskInfo[];
}
export interface LoopStage { name: string; kind: string; severity: string; enabled: boolean; order: number; stageId?: string | null }
export interface LoopState {
  configured: boolean;
  projectName: string | null;
  running: boolean;
  startedHere: boolean;
  iteration: number;
  maxIterations: number;
  logTail: string[];
  lastStatusSummary: string | null;
  lastFinishedAt: number | null;
  stages: LoopStage[];
  queuedCount: number;
}
export interface AutoTaskLogLine { id: string; timestamp: number; level: string; text: string }
export interface AutoTaskLogs { currentTask: string | null; tasks: { id: string; label: string; lines: AutoTaskLogLine[] }[] }
export interface LoopRun { id: string; startedAt: number; durationSeconds: number; iterationsUsed: number; statusCode: string; statusSummary: string; trigger: string }
export interface AutoTaskSetup {
  hasProject: boolean;
  projectName: string | null;
  templates: { id: string; name: string; body: string }[];
  configs: { taskId: string; inputPath: string | null; outputPath: string | null; skillName: string | null; templateId: string | null }[];
  skills: { name: string; description: string }[];
  folders: string[];
}
export interface BridgeSnapshot {
  phase: BridgePhase;
  deviceName: string | null;
  capabilities: string[];
  error: string | null;
  autoTasks: AutoTaskState | null;
  loop: LoopState | null;
  acks: { ok: boolean; message: string | null; code: string | null; at: number }[];
  history: { actionText: string; status: string; lastUpdated: number }[];
  logs: AutoTaskLogs | null;
  loopRuns: LoopRun[];
  setup: AutoTaskSetup | null;
}

type Msg = Record<string, unknown> & { type?: unknown };

// The Mac grants the desktop class only at a PIN pairing it approved; a phone-class record is refused desktop types.
export const PAIR_AGAIN = "Auto Tasks control is not allowed for this pairing. Pair again from Settings → Mobile Bridge to allow Auto Tasks control (Forget pairing, then enter the PIN and allow it on your Mac).";

/** What to show for a Mac refusal: `desktop_only` means this pairing is a phone record. */
export function refusalText(code: string | null, message: string | null): string {
  if (code === "desktop_only") return PAIR_AGAIN;
  if (code === "desktop_denied" && !message) return PAIR_AGAIN;
  return message ?? "The Mac refused that request.";
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;

function decodeAutoTask(v: unknown): AutoTaskState | null {
  if (!isObj(v)) return null;
  const tasks = Array.isArray(v.tasks)
    ? v.tasks.filter(isObj).map((t) => ({
        id: str(t.id) ?? "",
        label: str(t.label) ?? "Task",
        enabled: bool(t.enabled),
        lastError: str(t.lastError),
      })).filter((t) => t.id !== "")
    : [];
  return {
    masterEnabled: bool(v.masterEnabled), isRunning: bool(v.isRunning),
    currentTask: str(v.currentTask), currentStep: str(v.currentStep), statusMessage: str(v.statusMessage),
    lastRunDate: num(v.lastRunDate), createdCount: num(v.createdCount) ?? 0,
    implementedCount: num(v.implementedCount) ?? 0, failedCount: num(v.failedCount) ?? 0, tasks,
  };
}

function decodeLoop(v: unknown): LoopState | null {
  if (!isObj(v)) return null;
  const stages = Array.isArray(v.stages)
    ? v.stages.filter(isObj).map((s, i) => ({
        name: str(s.name) ?? `Stage ${i + 1}`, kind: str(s.kind) ?? "", severity: str(s.severity) ?? "",
        enabled: bool(s.enabled), order: num(s.order) ?? i, stageId: str(s.stageId),
      }))
    : [];
  return {
    configured: bool(v.configured), projectName: str(v.projectName), running: bool(v.running),
    startedHere: bool(v.startedHere), iteration: num(v.iteration) ?? 0, maxIterations: num(v.maxIterations) ?? 0,
    logTail: Array.isArray(v.logTail) ? v.logTail.filter((x): x is string => typeof x === "string").slice(-200) : [],
    lastStatusSummary: str(v.lastStatusSummary), lastFinishedAt: num(v.lastFinishedAt),
    stages, queuedCount: num(v.queuedCount) ?? 0,
  };
}

function randomId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class MacBridge {
  private ws: WebSocket | null = null;
  private heartbeat: number | null = null;
  private snapshot: BridgeSnapshot = { phase: "idle", deviceName: null, capabilities: [], error: null, autoTasks: null, loop: null, acks: [], history: [], logs: null, loopRuns: [], setup: null };
  private listeners = new Set<() => void>();
  private deviceId: string;
  private token: string | null = null;

  constructor() {
    let saved: { deviceId?: string } = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as typeof saved; } catch { /* fresh */ }
    this.deviceId = typeof saved.deviceId === "string" && saved.deviceId ? saved.deviceId : randomId();
    // The pairing token is kept in memory only; saving rewrites the store without any token left over from older builds.
    this.save();
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = (): BridgeSnapshot => this.snapshot;
  get paired(): boolean { return this.token !== null; }

  private save(): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ deviceId: this.deviceId })); } catch { /* session only */ }
  }
  private emit(patch: Partial<BridgeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l();
  }

  connect(pin = ""): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!pin && !this.token) { this.emit({ phase: "needs-pin", error: null }); return; }
    this.emit({ phase: "connecting", error: null });
    let ws: WebSocket;
    try { ws = new WebSocket(BRIDGE_URL); } catch { this.emit({ phase: "error", error: "Could not open the Mac bridge socket." }); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: "pairing", pin, token: this.token ?? undefined, deviceId: this.deviceId, deviceName: "LLM-IDE Desktop", clientClass: "desktop" });
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => this.emit({ phase: "error", error: "The Mac app is not reachable on port 3006." });
    ws.onclose = () => {
      if (this.ws !== ws) return; // a replaced socket closing must not clear the current one
      this.stopHeartbeat();
      this.ws = null;
      if (this.snapshot.phase !== "error") this.emit({ phase: this.token ? "idle" : "needs-pin" });
    };
  }

  disconnect(): void {
    this.stopHeartbeat();
    try { this.ws?.close(); } catch { /* gone */ }
    this.ws = null;
    this.emit({ phase: "idle", autoTasks: null, loop: null });
  }

  forget(): void {
    this.token = null;
    this.save();
    this.disconnect();
    this.emit({ phase: "needs-pin", deviceName: null, capabilities: [], autoTasks: null, loop: null });
  }

  private send(msg: Msg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => this.send({ type: "heartbeat" }), 10_000);
  }
  private stopHeartbeat(): void {
    if (this.heartbeat !== null) { window.clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  private onMessage(data: unknown): void {
    let msg: Msg;
    try { msg = JSON.parse(typeof data === "string" ? data : "") as Msg; } catch { return; }
    switch (msg.type) {
      case "connected": {
        const token = str(msg.token);
        if (token) { this.token = token; this.save(); }
        this.emit({ phase: "connected", deviceName: str(msg.deviceName), capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.filter((x): x is string => typeof x === "string") : [], error: null });
        this.startHeartbeat();
        this.send({ type: "auto_task_list" });
        this.send({ type: "auto_task_logs_list" });
        this.send({ type: "auto_task_setup_list" });
        this.send({ type: "loop_status_list" });
        this.send({ type: "loop_history" });
        break;
      }
      case "error": {
        // CommandError from the Mac's tier gate or a bridge refusal; a refused desktop pairing also shows in Settings.
        const code = str(msg.code);
        const text = refusalText(code, str(msg.message));
        this.emit({
          acks: [{ ok: false, message: text, code, at: Date.now() }, ...this.snapshot.acks].slice(0, 20),
          ...(code === "desktop_only" || str(msg.commandId) === "pairing" ? { error: text } : {}),
        });
        break;
      }
      case "auth_failed":
        this.token = null;
        this.save();
        this.emit({ phase: "needs-pin", error: str(msg.message) ?? "The Mac refused the pairing." });
        break;
      case "disconnected":
        this.emit({ phase: this.token ? "idle" : "needs-pin", error: str(msg.reason) ?? "The Mac closed the bridge." });
        break;
      case "auto_task_state":
        this.emit({ autoTasks: decodeAutoTask(msg) });
        break;
      case "auto_task_ack":
        this.emit({ acks: [{ ok: bool(msg.ok), message: str(msg.message), code: str(msg.code), at: Date.now() }, ...this.snapshot.acks].slice(0, 20) });
        break;
      case "auto_task_history_reply":
        this.emit({
          history: Array.isArray(msg.entries)
            ? msg.entries.filter(isObj).map((e) => ({ actionText: str(e.actionText) ?? "", status: str(e.status) ?? "", lastUpdated: num(e.lastUpdated) ?? 0 }))
            : [],
        });
        break;
      case "loop_state":
        this.emit({ loop: decodeLoop(msg) });
        break;
      case "loop_history_reply":
        this.emit({
          loopRuns: Array.isArray(msg.runs)
            ? msg.runs.filter(isObj).map((r) => ({
                id: str(r.id) ?? "",
                startedAt: num(r.startedAt) ?? 0,
                durationSeconds: num(r.durationSeconds) ?? 0,
                iterationsUsed: num(r.iterationsUsed) ?? 0,
                statusCode: str(r.statusCode) ?? "",
                statusSummary: str(r.statusSummary) ?? "",
                trigger: str(r.trigger) ?? "",
              })).filter((r) => r.id !== "")
            : [],
        });
        break;
      case "auto_task_setup_reply": {
        const templates = Array.isArray(msg.templates) ? msg.templates.filter(isObj).map((t) => ({ id: str(t.id) ?? "", name: str(t.name) ?? "Template", body: str(t.body) ?? "" })).filter((t) => t.id !== "") : [];
        const configs = Array.isArray(msg.configs) ? msg.configs.filter(isObj).map((c) => ({ taskId: str(c.taskId) ?? "", inputPath: str(c.inputPath), outputPath: str(c.outputPath), skillName: str(c.skillName), templateId: str(c.templateId) })).filter((c) => c.taskId !== "") : [];
        const skills = Array.isArray(msg.skills) ? msg.skills.filter(isObj).map((k) => ({ name: str(k.name) ?? "", description: str(k.description) ?? "" })).filter((k) => k.name !== "") : [];
        this.emit({ setup: { hasProject: bool(msg.hasProject), projectName: str(msg.projectName), templates, configs, skills, folders: Array.isArray(msg.folders) ? msg.folders.filter((x): x is string => typeof x === "string") : [] } });
        break;
      }
      case "auto_task_logs_reply": {
        const tasks = Array.isArray(msg.tasks)
          ? msg.tasks.filter(isObj).map((t) => ({
              id: str(t.id) ?? "", label: str(t.label) ?? "Task",
              lines: Array.isArray(t.lines) ? t.lines.filter(isObj).map((l) => ({
                id: str(l.id) ?? "", timestamp: num(l.timestamp) ?? 0, level: str(l.level) ?? "info", text: str(l.text) ?? "",
              })).filter((l) => l.text !== "") : [],
            })).filter((t) => t.id !== "")
          : [];
        this.emit({ logs: { currentTask: str(msg.currentTask), tasks } });
        break;
      }
      case "loop_ack":
        this.emit({ acks: [{ ok: bool(msg.accepted), message: str(msg.message), code: null, at: Date.now() }, ...this.snapshot.acks].slice(0, 20) });
        break;
      default:
        break;
    }
  }

  refresh(): void {
    if (!this.send({ type: "auto_task_list" })) return;
    this.send({ type: "auto_task_logs_list" });
    this.send({ type: "auto_task_setup_list" });
    this.send({ type: "loop_status_list" });
  }
  history(): void { this.send({ type: "auto_task_history" }); }
  run(task: string | null): void { this.send({ type: "auto_task_run", task }); }
  stopAuto(): void { this.send({ type: "auto_task_stop" }); }
  toggle(task: string | null, enabled: boolean): void { this.send({ type: "auto_task_toggle", task, enabled }); }
  loopHistory(): void { this.send({ type: "loop_history" }); }
  loopRefresh(): void { this.send({ type: "loop_status_list" }); }
}

export const macBridge = new MacBridge();
