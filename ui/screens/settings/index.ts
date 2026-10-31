// Public surface of the Settings screen: `import { SettingsScreen } from "@llmide/screens/settings"`.
export { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen.tsx";
export { settingsRegistry, createSettingsRegistry, type SectionComponent } from "./registry-default.ts";
export { SettingsRegistry, type CardDef, type SectionDef } from "./registry.ts";
export type { SettingsEnv, SettingsHost, DiagnosticsInfo, CoreTrust, ThemeChoice } from "./host.ts";
export type { CoreClient, CoreResponse } from "./core-api.ts";
