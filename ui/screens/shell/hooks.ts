import { useRef, useSyncExternalStore } from "react";

interface ReadableStore<S> {
  getSnapshot(): S;
  subscribe(listener: () => void): () => void;
}

/**
 * Subscribe to a slice of an external store. The component re-renders only when `isEqual`
 * says the selected value changed (default `Object.is`), not on every store notification.
 * `selector` must be pure and cheap.
 */
export function useStoreSelector<S, T>(store: ReadableStore<S>, selector: (s: S) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ state: S; value: T } | null>(null);
  const get = (): T => {
    const state = store.getSnapshot();
    const prev = last.current;
    if (prev && prev.state === state) return prev.value;
    const value = selector(state);
    if (prev && isEqual(prev.value, value)) {
      last.current = { state, value: prev.value };
      return prev.value;
    }
    last.current = { state, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}
