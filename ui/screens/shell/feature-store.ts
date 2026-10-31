// The feature profile as the shell sees it: what this build compiled in, what the user stored, what this launch
// actually runs (the core's env was fixed at startup) and therefore what is usable now. Pure data + a tiny store;
// the host prefs are the authority (empty list = every feature).
import { ALL_FEATURES, compiledFeatures, featuresFromPrefs, usableFeatures, type AppFeature } from "./features";
import { invokeHost, isHostAvailable } from "./host";
import { decodePrefsView } from "./host-prefs";

export interface FeatureSnapshot {
  /** False until the first read finished; the UI treats the initial state as "every feature" meanwhile. */
  ready: boolean;
  compiled: ReadonlySet<AppFeature>;
  /** What is stored for the next start. */
  active: ReadonlySet<AppFeature>;
  /** What this launch runs (the core env was set from it). */
  launch: ReadonlySet<AppFeature>;
  /** Active ∩ compiled ∩ dependencies: what the UI may show now. */
  usable: ReadonlySet<AppFeature>;
}

const ALL: ReadonlySet<AppFeature> = new Set(ALL_FEATURES);

export class FeatureStore {
  #snap: FeatureSnapshot = {
    ready: false,
    compiled: compiledFeatures(),
    active: ALL,
    launch: ALL,
    usable: usableFeatures(ALL, compiledFeatures()),
  };
  #listeners = new Set<() => void>();
  #inflight: Promise<void> | null = null;

  getSnapshot = (): FeatureSnapshot => this.#snap;

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  };

  /** Reads prefs once; later calls share the in-flight read. Safe when the host is absent (plain browser). */
  load(): Promise<void> {
    this.#inflight ??= this.#read().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #read(): Promise<void> {
    const compiled = compiledFeatures();
    let active: ReadonlySet<AppFeature> = ALL;
    let launch: ReadonlySet<AppFeature> = ALL;
    if (isHostAvailable()) {
      try {
        const v = decodePrefsView(await invokeHost<unknown>("get_prefs"));
        if (v) {
          active = featuresFromPrefs(v.stored.features);
          launch = featuresFromPrefs(v.launch.features);
        }
      } catch {
        // No readable prefs: behave like a fresh install (every feature).
      }
    }
    this.#set({ ready: true, compiled, active, launch, usable: usableFeatures(launch, compiled) });
  }

  /** The Settings screen after a write: the stored set changed, the running one did not. */
  apply(active: readonly string[]): void {
    const stored = featuresFromPrefs(active);
    const s = this.#snap;
    this.#set({ ...s, ready: true, active: stored, usable: usableFeatures(s.launch, s.compiled) });
  }

  #set(next: FeatureSnapshot): void {
    const prev = this.#snap;
    if (
      prev.ready === next.ready &&
      prev.compiled === next.compiled &&
      prev.active === next.active &&
      prev.launch === next.launch &&
      prev.usable === next.usable
    ) {
      return;
    }
    this.#snap = next;
    for (const l of [...this.#listeners]) l();
  }
}

/** The app uses one store; tests construct their own. */
export const featureStore = new FeatureStore();
