// Adapts the shell (core client, host commands, theme and project stores) to the narrow `SettingsEnv` the Settings
// screen codes against (ui/screens/settings/host.ts, core-api.ts). Everything is injected so it is tested with fakes.
//
// Deliberately NOT provided (Settings then shows its "needs the desktop host" placeholder instead of pretending):
//  - getLtaMode / setLtaMode / launchLtaMode and getRoutePrefs / setRoutePrefs: no host command or core route stores
//    these switches yet (blocked on the host owner; they are env flags read when the core is spawned).
//  - pickFolder: the only native folder dialogs are `project_open` and `notes_root_choose`, and both CHANGE state
//    (the open project, the notes folder). Reusing one as a neutral picker would be a side effect the user did not ask for.
import type { CoreClient as SettingsCoreClient, CoreResponse } from "../settings/core-api";
import type { CoreTrust, DiagnosticsInfo, SettingsEnv, SettingsHost, ThemeChoice } from "../settings/host";
import { CoreError, type CoreClient } from "./core";
import type { CoreStatus } from "./host";

export interface SettingsAdapterDeps {
  core: Pick<CoreClient, "requestRaw" | "login" | "logout">;
  coreStatus: () => CoreStatus | null;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  hostAvailable: () => boolean;
  activeProjectRoot: () => string | null;
  theme: { get(): ThemeChoice; set(t: ThemeChoice): void };
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
  const host: SettingsHost = {
    async diagnostics(): Promise<DiagnosticsInfo> {
      return { appVersion: d.appVersion(), coreTrust: trustOf(d.coreStatus()), coreLogPath: null, platform: d.platform() };
    },
    getTheme: () => d.theme.get(),
    setTheme: (t) => d.theme.set(t),
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
