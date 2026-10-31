import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { LibraryState, LibraryStore } from "./library-store.ts";

/** The store's state; re-renders on every change (the store batches: one change per list page or head batch). */
export function useLibraryState(store: LibraryStore): LibraryState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Scroll position and viewport height of a scroller, updated on scroll and resize. `initialHeight` is used until measured (and in server rendering). */
export function useScroller(ref: RefObject<HTMLElement | null>, initialHeight = 600): { scrollTop: number; height: number } {
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(initialHeight);
  const raf = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setHeight(el.clientHeight || initialHeight);
    measure();
    const onScroll = (): void => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [ref, initialHeight]);
  return { scrollTop, height };
}

/** Runs `fn` with an AbortSignal that is aborted when `deps` change or the component unmounts. */
export function useAbortable(fn: (signal: AbortSignal) => void, deps: readonly unknown[]): void {
  useEffect(() => {
    const ac = new AbortController();
    fn(ac.signal);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
