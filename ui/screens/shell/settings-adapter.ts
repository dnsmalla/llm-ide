// Adapts the shell (core client, host commands, theme and project stores) to the narrow `SettingsEnv` the Settings
// screen codes against (ui/screens/settings/host.ts, core-api.ts). Everything is injected so it is tested with fakes.
//
// Host-backed items (only offered when a desktop host is present; in a plain browser Settings shows its
// "needs the desktop host" placeholder instead of pretending):
//  - archiving mode, router/cap, compress/learn, Terminal feature: host prefs (`get_prefs` / `set_prefs`, prefs.rs),
//    applied by the host at the NEXT app start.
//  - pickFolder: `pick_folder` (no side effect) then a single-use `pick_folder_redeem`; confirmTrust: `trust_confirm`.
// Still not provided: nothing blocks a macOS build; Windows/Linux hosts share the same commands.
import type { CoreClient as SettingsCoreClient, CoreResponse } from "../settings/core-api";
import { decodeComponentStatus, decodeCoreLog, decodeRtkStatus } from "../settings/components-model";
import { decodeMemory, decodePaths } from "../settings/project-model";
import { decodeRemoteServerConfig, decodeRemoteSshResult } from "../settings/remote-model";
import { decodeBootstrap, decodeDeployPlan, decodeDeployReport } from "../settings/remote-deploy-model";
import { decodeLegacyImportReport, decodeLegacyImportStatus } from "../settings/legacy-import-model";
import { decodeTrayStatus } from "../settings/misc-model";
import { decodeDiff, decodePrepared, decodeVerified } from "../settings/self-heal-model";
import { AGENT_TIMEOUT_MS } from "../settings/self-heal-run";
import { flushSelfHealNow } from "./self-heal";
import type { CoreTrust, DiagnosticsInfo, RemoteServerConfig, SettingsEnv, SettingsHost, ThemeChoice } from "../settings/host";
import { decodeUpdateStatus, type UpdateStatusView } from "../settings/updates-model";
import { CoreError, type CoreClient } from "./core";
import { decodePickedChoice, decodePickedFolder, decodePrefsView, type HostPrefsPatch, type HostPrefsView } from "./host-prefs";
import type { CoreStatus } from "./host";

export interface SettingsAdapterDeps {
  core: Pick<CoreClient, "requestRaw" | "login" | "logout">;
  coreStatus: () => CoreStatus | null;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  hostAvailable: () => boolean;
  activeProjectRoot: () => string | null;
  theme: { get(): ThemeChoice; set(t: ThemeChoice): void };
  /** Developer tools flag (sections.ts); absent = the Settings switch is hidden. */
  devTools?: { get(): boolean; set(on: boolean): void };
  appVersion: () => string;
  platform: () => string;
  clipboard: () => { writeText(text: string): Promise<void> } | null;
}

/** Settings' request shape over the shell client: a non-2xx answer is data, not an exception. */
export function settingsClientFrom(core: Pick<CoreClient, "requestRaw">): SettingsCoreClient {
  return {
    async request(method, path, body, signal): Promise<CoreResponse> {
      try {
        const r = await core.requestRaw(path, { method, body, signal });
        return { status: r.status, body: r.body ?? null };
      } catch (e) {
        // The shell client clears the session itself on a 401 and throws; Settings wants the status.
        if (e instanceof CoreError && e.status === 401) return { status: 401, body: { error: { code: "SESSION_EXPIRED", message: e.message } } };
        throw e;
      }
    },
  };
}

const mustDecode = (v: UpdateStatusView | null): UpdateStatusView => { if (!v) throw new Error("bad update status from host"); return v; };

export function trustOf(status: CoreStatus | null): CoreTrust {
  if (status?.trust === "remote_pinned") return "remote-pinned";
  return status?.trust === "spawned" ? "spawned" : "adopted-unverified";
}

export function createSettingsEnv(d: SettingsAdapterDeps): SettingsEnv {
  let launch: HostPrefsView["launch"] | null = null;
  const readPrefs = async (): Promise<HostPrefsView> => {
    const v = decodePrefsView(await d.invoke<unknown>("get_prefs"));
    if (!v) throw new Error("the desktop host returned preferences this app cannot read");
    launch = v.launch;
    return v;
  };
  const writePrefs = async (patch: HostPrefsPatch): Promise<HostPrefsView> => {
    const v = decodePrefsView(await d.invoke<unknown>("set_prefs", { patch }));
    if (!v) throw new Error("the desktop host returned preferences this app cannot read");
    launch = v.launch;
    return v;
  };
  const hostPart: Partial<SettingsHost> = d.hostAvailable()
    ? {
        getLtaMode: async () => (await readPrefs()).stored.ltaMode,
        setLtaMode: async (mode) => { await writePrefs({ ltaMode: mode }); },
        launchLtaMode: () => launch?.ltaMode ?? "off",
        getRoutePrefs: async () => { const p = (await readPrefs()).stored; return { router: p.router, cap: p.cap }; },
        setRoutePrefs: async (p) => { await writePrefs({ router: p.router, cap: p.router ? p.cap : false }); },
        getExtraPrefs: async () => { const p = (await readPrefs()).stored; return { compress: p.compress, learn: p.learn, terminal: p.terminal, continueSummary: p.continueSummary,
          hostApiTls: p.hostApiTls, hostApiRead: p.hostApiRead, hostApiCompose: p.hostApiCompose, hostApiPush: p.hostApiPush, hostApiToolApprovals: p.hostApiToolApprovals }; },
        setExtraPrefs: async (p) => { await writePrefs(p); },
        getLoopDefaults: async () => (await readPrefs()).stored.loopDefaults,
        setLoopDefaults: async (loopDefaults) => { const p = (await writePrefs({ loopDefaults })).stored; return p.loopDefaults; },
        getGraphAutoUpdate: async () => (await readPrefs()).stored.graphAutoUpdateMinutes,
        setGraphAutoUpdate: async (graphAutoUpdateMinutes) => (await writePrefs({ graphAutoUpdateMinutes })).stored.graphAutoUpdateMinutes,
        getUpdateChecks: async () => (await readPrefs()).stored.updateChecks,
        setUpdateChecks: async (updateChecks) => (await writePrefs({ updateChecks })).stored.updateChecks,
        updateStatus: async () => mustDecode(decodeUpdateStatus(await d.invoke<unknown>("update_status"))),
        checkForUpdate: async () => mustDecode(decodeUpdateStatus(await d.invoke<unknown>("update_check"))),
        installUpdate: async () => (await d.invoke<unknown>("update_install")) === true,
        async pickFolder(title) {
          const choice = decodePickedChoice(await d.invoke<unknown>("pick_folder", { title }));
          if (!choice) return null;
          const path = decodePickedFolder(await d.invoke<unknown>("pick_folder_redeem", { token: choice.token }));
          if (!path) throw new Error("the desktop host returned a folder this app cannot use");
          return path;
        },
        confirmTrust: async (path) => (await d.invoke<unknown>("trust_confirm", { path })) === true,
        async getFeatureProfile() {
          const v = await readPrefs();
          return { stored: v.stored.features, launch: v.launch.features };
        },
        async setFeatureProfile(features) {
          const v = await writePrefs({ features });
          return { stored: v.stored.features, launch: v.launch.features };
        },
        async getBackendConfig() {
          const p = (await readPrefs()).stored;
          return { source: p.backendSource, node: p.backendNode, dir: p.backendDir, port: p.backendPort, autoStart: p.backendAutoStart };
        },
        async setBackendConfig(patch) {
          // Node and folder are host-only (set by the native pickers); the webview sends the source toggle, port and launch toggle.
          const cur = (await readPrefs()).stored;
          const next = {
            backendSource: patch.source ?? cur.backendSource,
            backendPort: patch.port ?? cur.backendPort,
            backendAutoStart: patch.autoStart ?? cur.backendAutoStart,
          };
          const v = await writePrefs(next);
          const p = v.stored;
          return { source: p.backendSource, node: p.backendNode, dir: p.backendDir, port: p.backendPort, autoStart: p.backendAutoStart };
        },
        async getRemoteServer() {
          const stored = (await readPrefs()).stored.remoteServer;
          const config = decodeRemoteServerConfig(stored);
          if (!config) throw new Error("the desktop host returned remote settings this app cannot read");
          return config;
        },
        async setRemoteServer(config: RemoteServerConfig) {
          // Only the non-secret fields are sent: mode, host, port, user, key PATH and label. Key contents never leave disk.
          const v = await writePrefs({ remoteServer: config });
          const saved = decodeRemoteServerConfig(v.stored.remoteServer);
          if (!saved) throw new Error("the desktop host returned remote settings this app cannot read");
          return saved;
        },
        async testRemoteSsh(config: RemoteServerConfig) {
          const target = { host: config.host.trim(), port: config.port, user: config.user.trim(), keyPath: config.keyPath.trim() };
          const result = decodeRemoteSshResult(await d.invoke<unknown>("remote_ssh_test", { target }));
          if (!result) throw new Error("the desktop host returned an SSH result this app cannot read");
          return result;
        },
        async remoteDeployPlan(target, domain, reviewAck) {
          const plan = decodeDeployPlan(await d.invoke<unknown>("remote_deploy_plan", { target, domain, reviewAck }));
          if (!plan) throw new Error("the desktop host returned a deploy plan this app cannot read");
          return plan;
        },
        async remoteDeployBootstrap(target) {
          const b = decodeBootstrap(await d.invoke<unknown>("remote_deploy_bootstrap", { target }));
          if (!b) throw new Error("the desktop host returned a bootstrap result this app cannot read");
          return b;
        },
        async remoteDeployRun(target, planId, confirmation) {
          const r = decodeDeployReport(await d.invoke<unknown>("remote_deploy_run", { target, planId, confirmation }));
          if (!r) throw new Error("the desktop host returned a deploy report this app cannot read");
          return r;
        },
        async remoteDeployLock(target) { await d.invoke("remote_deploy_lock", { target }); },
        async remoteDeployRollback(target) { await d.invoke("remote_deploy_rollback", { target }); },
        async remoteTlsProbe(hubUrl) {
          const r = await d.invoke<{ fingerprint?: unknown }>("remote_tls_probe", { hubUrl });
          if (!r || typeof r.fingerprint !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/.test(r.fingerprint)) throw new Error("the desktop host returned an invalid TLS fingerprint");
          return { fingerprint: r.fingerprint };
        },
        async remoteTlsPin(hubUrl, fingerprint) { await d.invoke("remote_tls_pin", { hubUrl, fingerprint }); },
        async restartApp() { await d.invoke("app_restart"); },
        async remoteUpdate(target, version, confirmation) { await d.invoke("remote_update", { target, version, confirmation }); },
        async remoteBackupNow(target) { await d.invoke("remote_backup_now", { target }); },
        async remoteLogs(target, lines) { const r = await d.invoke<unknown>("remote_logs", { target, lines }); return typeof r === "string" ? r : ""; },
        async remoteDiagnostics(target) { return await d.invoke("remote_diagnostics", { target }); },
        async remoteUninstall(target, confirmation, purge) { await d.invoke("remote_uninstall", { target, confirmation, purge }); },
        async pickNode() {
          const r = await d.invoke<unknown>("backend_pick_node");
          return typeof r === "string" && r.length > 0 ? r : null;
        },
        async pickBackendDir() {
          const r = await d.invoke<unknown>("backend_pick_dir");
          return typeof r === "string" && r.length > 0 ? r : null;
        },
        async detectBackend() {
          const raw = await d.invoke<unknown>("backend_detect");
          const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          return { node: typeof o.node === "string" ? o.node : "", dir: typeof o.dir === "string" ? o.dir : "" };
        },
        async coreStop() {
          await d.invoke<unknown>("core_stop");
        },
        async coreStart() {
          await d.invoke<unknown>("core_start");
        },
        async coreRestart() {
          await d.invoke<unknown>("core_restart");
        },
        async cloneRepository(args) {
          const raw = await d.invoke<unknown>("repo_clone", args);
          const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          if (typeof o.path !== "string" || typeof o.name !== "string") throw new Error("the host returned no cloned path");
          return { path: o.path, name: o.name };
        },
        async rebuildFeatures(features) {
          const raw = await d.invoke<unknown>("feature_rebuild", { features });
          const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          return {
            started: o.started === true,
            message: typeof o.message === "string" ? o.message.slice(0, 300) : "The rebuild did not start.",
          };
        },
        async mermaidStatus() {
          const s = decodeComponentStatus(await d.invoke<unknown>("mermaid_runtime_status"));
          if (!s) throw new Error("the desktop host returned a component status this app cannot read");
          return s;
        },
        async installMermaid() {
          const s = decodeComponentStatus(await d.invoke<unknown>("mermaid_runtime_install"));
          if (!s) throw new Error("the desktop host returned a component status this app cannot read");
          return s;
        },
        async removeMermaid() {
          const s = decodeComponentStatus(await d.invoke<unknown>("mermaid_runtime_remove"));
          if (!s) throw new Error("the desktop host returned a component status this app cannot read");
          return s;
        },
        selfHeal: {
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
        },
        async legacyImportStatus() {
          const r = decodeLegacyImportStatus(await d.invoke<unknown>("legacy_import_status"));
          if (!r) throw new Error("the desktop host returned an old-data status this app cannot read");
          return r;
        },
        async runLegacyImport(force) {
          const r = decodeLegacyImportReport(await d.invoke<unknown>("legacy_import_run", { force }));
          if (!r) throw new Error("the desktop host returned an old-data report this app cannot read");
          return r;
        },
        async coreLog() {
          const l = decodeCoreLog(await d.invoke<unknown>("core_log_read"));
          if (!l) throw new Error("the desktop host returned a log this app cannot read");
          return l;
        },
        async clearCoreLog() {
          await d.invoke<unknown>("core_log_clear");
        },
        async projectPaths() {
          const p = decodePaths(await d.invoke<unknown>("project_paths"));
          if (!p) throw new Error("the desktop host returned a project layout this app cannot read");
          return p;
        },
        async rebuildProjectFolders() {
          await d.invoke<unknown>("project_rebuild_folders");
        },
        async projectMemory() {
          const m = decodeMemory(await d.invoke<unknown>("project_memory"));
          if (!m) throw new Error("the desktop host returned project memory this app cannot read");
          return m;
        },
        async revealPath(relPath) {
          await d.invoke<unknown>("reveal_in_os", { relPath });
        },
        async rtkStatus() {
          const s = decodeRtkStatus(await d.invoke<unknown>("rtk_status"));
          if (!s) throw new Error("the desktop host returned an rtk status this app cannot read");
          return s;
        },
        async installRtk() {
          const s = decodeRtkStatus(await d.invoke<unknown>("rtk_install"));
          if (!s) throw new Error("the desktop host returned an rtk status this app cannot read");
          return s;
        },
        async getTrayIcon() {
          const s = decodeTrayStatus(await d.invoke<unknown>("tray_status"));
          if (!s) throw new Error("the desktop host returned a tray status this app cannot read");
          return s.iconVisible;
        },
        async setTrayIcon(on) {
          const s = decodeTrayStatus(await d.invoke<unknown>("tray_set_icon_visible", { visible: on }));
          if (!s) throw new Error("the desktop host returned a tray status this app cannot read");
          return s.iconVisible;
        },
      }
    : {};
  const host: SettingsHost = {
    async diagnostics(): Promise<DiagnosticsInfo> {
      return { appVersion: d.appVersion(), coreTrust: trustOf(d.coreStatus()), coreLogPath: d.coreStatus()?.core_log_path ?? null, platform: d.platform(), coreUrl: d.coreStatus()?.url ?? null, coreState: d.coreStatus()?.state ?? null };
    },
    getTheme: () => d.theme.get(),
    setTheme: (t) => {
      d.theme.set(t);
      // Mirrored into the host's prefs.json so the choice survives a cleared webview store. Best effort.
      if (d.hostAvailable()) void writePrefs({ theme: t }).catch(() => undefined);
    },
    ...hostPart,
    ...(d.devTools ? { getDevTools: () => d.devTools!.get(), setDevTools: (on: boolean) => d.devTools!.set(on) } : {}),
    activeProjectPath: () => d.activeProjectRoot(),
    async notesFolderPath() {
      if (!d.hostAvailable()) return null;
      const r = await d.invoke<{ root?: unknown } | null>("notes_root_get");
      return r && typeof r.root === "string" ? r.root : null;
    },
    async copyText(text) {
      const c = d.clipboard();
      if (!c) throw new Error("clipboard unavailable");
      await c.writeText(text);
    },
    async signIn(email, password) {
      await d.core.login(email, password);
    },
    async signOut() {
      await d.core.logout();
    },
  };
  return { client: settingsClientFrom(d.core), host };
}
