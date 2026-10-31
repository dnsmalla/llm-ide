import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { CoreClient } from "./core-api.ts";
import type { SettingsEnv } from "./host.ts";
import { ProvidersApi, ProvidersModel } from "./providers-model.ts";
import type { Store } from "./store.ts";

const Ctx = createContext<SettingsEnv | null>(null);

export function SettingsEnvProvider({ env, children }: { env: SettingsEnv; children: ReactNode }) {
  return <Ctx.Provider value={env}>{children}</Ctx.Provider>;
}

export function useEnv(): SettingsEnv {
  const v = useContext(Ctx);
  if (!v) throw new Error("Settings components must be rendered inside SettingsEnvProvider");
  return v;
}

/** Subscribes a component to a model store. */
export function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** One model instance per component mount (created lazily, never recreated on re-render). */
export function useModel<M>(make: () => M): M {
  const ref = useRef<M | null>(null);
  if (ref.current === null) ref.current = make();
  return ref.current;
}

/** Runs `refresh` once now and again whenever the window regains focus. No timers: Settings never polls. */
export function useRefreshOnFocus(refresh: () => void): void {
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    fn.current();
    const onFocus = () => fn.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}

const providerModels = new WeakMap<CoreClient, ProvidersModel>();
/** Providers and Model routing read the same catalog: one shared model per core client. */
export function sharedProvidersModel(client: CoreClient): ProvidersModel {
  let m = providerModels.get(client);
  if (!m) {
    m = new ProvidersModel(new ProvidersApi(client));
    providerModels.set(client, m);
  }
  return m;
}
