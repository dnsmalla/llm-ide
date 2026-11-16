// Test-only entry: the project store and the host it reads commands through, in one bundle, so a test can set the
// host bridge and the server mode for the store it drives.
export { projectStore } from "../project-store.ts";
export { setHostBridge, setRemoteModeProvider, setSshModeProvider } from "../host.ts";
