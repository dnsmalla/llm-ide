// A tiny toast store + host. `toast.show(...)` works from anywhere (no provider); <ToastHost/> renders them once, in an
// aria-live region (errors are assertive).
import { useSyncExternalStore } from "react";
import { IconButton } from "./primitives.tsx";

export interface ToastItem { id: number; message: string; tone: "info" | "success" | "warn" | "error" }
let items: readonly ToastItem[] = [];
let next = 1;
const subs = new Set<() => void>();
const emit = () => { for (const fn of subs) fn(); };
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const toast = {
  show(message: string, tone: ToastItem["tone"] = "info", ms = tone === "error" ? 7000 : 4000): number {
    const id = next++;
    items = [...items.slice(-3), { id, message, tone }];
    emit();
    timers.set(id, setTimeout(() => toast.dismiss(id), ms));
    return id;
  },
  dismiss(id: number) {
    clearTimeout(timers.get(id)); timers.delete(id);
    items = items.filter((t) => t.id !== id);
    emit();
  },
  /** For tests and the gallery. */
  clear() { for (const id of [...timers.keys()]) toast.dismiss(id); items = []; emit(); },
};
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
const get = () => items;

export function ToastHost() {
  const list = useSyncExternalStore(subscribe, get, get);
  return (
    <div className="ui-toasts">
      <div role="status" aria-live="polite" style={{ display: "contents" }}>
        {list.filter((t) => t.tone !== "error").map((t) => <ToastView key={t.id} t={t} />)}
      </div>
      <div role="alert" style={{ display: "contents" }}>
        {list.filter((t) => t.tone === "error").map((t) => <ToastView key={t.id} t={t} />)}
      </div>
    </div>
  );
}
function ToastView({ t }: { t: ToastItem }) {
  return <div className="ui-toast" data-tone={t.tone}><span>{t.message}</span><IconButton icon="x" label="Dismiss" size="sm" onClick={() => toast.dismiss(t.id)} /></div>;
}
