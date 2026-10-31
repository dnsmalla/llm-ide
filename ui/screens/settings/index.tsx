// Public surface of the Settings screen: `import { SettingsScreen } from "@llmide/screens/settings"`.
export { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen.tsx";
export { settingsRegistry, createSettingsRegistry, type SectionComponent } from "./registry-default.ts";
export { SettingsRegistry, type CardDef, type SectionDef } from "./registry.ts";
export type { SettingsEnv, SettingsHost, DiagnosticsInfo, CoreTrust, ThemeChoice } from "./host.ts";
export type { CoreClient, CoreResponse } from "./core-api.ts";

// ---- section entry ---------------------------------------------------------------------------------
// The shell lazy-loads the default export (SectionProps). The environment comes from the shell's adapter.
import { useEffect, useMemo, useState } from "react";
import { core, coreStatusStore, getTheme, host as shellHost, invokeHost, projectStore, setTheme, shellBus, type SectionProps } from "@llmide/screens/shell";
import { createSettingsEnv } from "../shell/settings-adapter";
import { SettingsScreen } from "./SettingsScreen.tsx";
import type { ThemeChoice } from "./host.ts";

declare const __APP_VERSION__: string | undefined;

export default function SettingsSection({ projectRoot }: SectionProps) {
  const root = useMemo(() => ({ current: projectRoot }), []);
  root.current = projectRoot;
  const env = useMemo(
    () =>
      createSettingsEnv({
        core,
        coreStatus: () => coreStatusStore.getSnapshot().status,
        invoke: invokeHost,
        hostAvailable: shellHost.isAvailable,
        activeProjectRoot: () => root.current ?? projectStore.getSnapshot().project?.root ?? null,
        theme: { get: () => getTheme() as ThemeChoice, set: (t) => setTheme(t) },
        appVersion: () => (typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"),
        platform: () => (typeof navigator === "undefined" ? "unknown" : navigator.platform || "unknown"),
        clipboard: () => (typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null),
      }),
    [root],
  );
  // "Open Settings at <anchor>" requests (the status bar's Claude-missing notice): taken on mount, and live afterwards.
  const [target, setTarget] = useState<{ anchor: string | undefined; n: number }>({ anchor: undefined, n: 0 });
  useEffect(() => {
    const take = (ev: { section: string; anchor?: string } | null) => {
      if (ev && ev.section === "settings") setTarget((t) => ({ anchor: ev.anchor, n: t.n + 1 }));
    };
    take(shellBus.takePending("goto-section"));
    return shellBus.subscribe("goto-section", (ev) => {
      shellBus.takePending("goto-section");
      take(ev);
    });
  }, []);
  return <SettingsScreen key={target.n} env={env} initialSection={target.anchor} />;
}
