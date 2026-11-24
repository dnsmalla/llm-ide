// One bundle for the Self-Heal wiring tests: host.ts, ErrorBoundary.tsx and self-heal.ts must share one Self-Heal
// module instance, which separate `load()` bundles would not.
export { invokeHost, setHostBridge } from "../host";
export { SectionErrorBoundary } from "../ErrorBoundary";
export { pumpOnce, pendingCount, resetSelfHealForTests } from "../self-heal";
