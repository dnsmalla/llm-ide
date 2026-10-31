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
import type { CoreTrust, DiagnosticsInfo, SettingsEnv, SettingsHost, ThemeChoice } from "../settings/host";
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

export function trustOf(status: CoreStatus | null): CoreTrust {
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
        getExtraPrefs: async () => { const p = (await readPrefs()).stored; return { compress: p.compress, learn: p.learn, terminal: p.terminal }; },
        setExtraPrefs: async (p) => { await writePrefs(p); },
        async pickFolder(title) {
          const choice = decodePickedChoice(await d.invoke<unknown>("pick_folder", { title }));
          if (!choice) return null;
          const path = decodePickedFolder(await d.invoke<unknown>("pick_folder_redeem", { token: choice.token }));
          if (!path) throw new Error("the desktop host returned a folder this app cannot use");
          return path;
        },
        confirmTrust: async (path) => (await d.invoke<unknown>("trust_confirm", { path })) === true,
      }
    : {};
  const host: SettingsHost = {
    async diagnostics(): Promise<DiagnosticsInfo> {
      return { appVersion: d.appVersion(), coreTrust: trustOf(d.coreStatus()), coreLogPath: d.coreStatus()?.core_log_path ?? null, platform: d.platform() };
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
