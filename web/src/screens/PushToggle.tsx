import type { PushState } from "../push/controller.ts";

/** "Notify me on this device": hidden unless the desktop serves push and this browser can receive it. */
export function PushToggle({ state, onEnable, onDisable }: { state: PushState; onEnable(): void; onDisable(): void }) {
  if (state.kind === "unavailable") return null;
  return (
    <div className="web-push" role="group" aria-label="Notifications">
      {state.kind === "blocked"
        ? <p className="web-hint">Notifications are blocked for this site. Allow them in the browser's site settings, then reload.</p>
        : <button type="button" disabled={state.kind === "busy"} onClick={state.kind === "on" ? onDisable : onEnable}>
            {state.kind === "on" ? "Stop notifications on this device" : "Notify me on this device"}
          </button>}
      {state.error ? <p className="web-hint" role="alert">{state.error}</p> : null}
    </div>
  );
}
