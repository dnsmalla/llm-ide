// Public surface of the shell slice for other screens.
//   import { host, core, useCoreSession } from "@llmide/screens/shell";
// A screen is a lazily loaded module `ui/screens/<name>/index.tsx` whose default export is a
// component taking `SectionProps`; the shell mounts it when the section is first opened and keeps
// it mounted (hidden) afterwards so its state survives section switches.
export * from "./host";
export * from "./core";
export * from "./status-view";
export { coreStatusStore, core, chatBinding, describeCoreError } from "./runtime";
export { describeCoreErrorFor, coreNotReadyReason } from "./core-explain";
export type { ChatBinding, BindSnapshot, BindState } from "./chat-binding";
export { useCoreSession, useCoreStatusView, useActiveProject } from "./use-shell";
export { useStoreSelector } from "./hooks";
export type { SectionProps } from "./sections";
export { shellBus, createShellBus, safeRelativePath, relativeToProject, type ShellBus, type ShellEvent } from "./bus";
export { getTheme, setTheme, subscribeTheme, seedThemeFromHost, hasStoredTheme, THEMES } from "./theme";
export { projectStore } from "./project-store";
