// React glue: controller state with frame-coalesced updates, and the virtual-list hook.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChatController } from "./controller";
import type { ChatState } from "./state";
import { buildOffsets, computeWindow, type WindowRange } from "./virtual";

const raf = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === "function") {
    const h = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(h);
  }
  const h = setTimeout(fn, 16);
  return () => clearTimeout(h);
};

/** One chat's state. Updates are coalesced to one render per frame, however many events arrive. */
export function useChatState(controller: ChatController, id: string): ChatState {
  const subscribe = useCallback((notify: () => void) => {
    let cancel: (() => void) | null = null;
    const off = controller.subscribe(() => { if (!cancel) cancel = raf(() => { cancel = null; notify(); }); });
    return () => { off(); cancel?.(); };
  }, [controller]);
  return useSyncExternalStore(subscribe, () => controller.getState(id), () => controller.getState(id));
}

/** A cheap controller-wide counter for lists that show per-chat flags (busy dots). */
export function useControllerVersion(controller: ChatController): number {
  const subscribe = useCallback((notify: () => void) => {
    let cancel: (() => void) | null = null;
    const off = controller.subscribe(() => { if (!cancel) cancel = raf(() => { cancel = null; notify(); }); });
    return () => { off(); cancel?.(); };
  }, [controller]);
  return useSyncExternalStore(subscribe, controller.getVersion, controller.getVersion);
}

export interface VirtualList {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  range: WindowRange;
  /** Call from an item's ref callback to report its measured height. */
  measure: (index: number, height: number) => void;
  offsets: Float64Array;
  scrollTop: number;
  viewport: number;
}

/**
 * Windowing for a scroll container. `heights(i)` gives a known height (fixed rows) or undefined (measured later);
 * measured heights are cached by `keyOf(i)` so they survive prepends.
 */
export function useVirtualList(count: number, keyOf: (i: number) => string, estimate: number, known?: (i: number) => number | undefined, overscan = 4): VirtualList {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cache = useRef(new Map<string, number>());
  const [tick, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport(el.clientHeight || 600);
    let pending: (() => void) | null = null;
    const onScroll = () => { if (!pending) pending = raf(() => { pending = null; setScrollTop(el.scrollTop); }); };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => setViewport(el.clientHeight || 600)) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", onScroll); ro?.disconnect(); pending?.(); };
  }, []);

  const measure = useCallback((index: number, height: number) => {
    const key = keyOf(index);
    if (height > 0 && Math.abs((cache.current.get(key) ?? 0) - height) > 0.5) {
      cache.current.set(key, height);
      setTick((t) => t + 1);
    }
  }, [keyOf]);

  // Bound the cache: keep only keys still in the list.
  useEffect(() => {
    if (cache.current.size <= count + 64) return;
    const live = new Set<string>();
    for (let i = 0; i < count; i++) live.add(keyOf(i));
    for (const k of cache.current.keys()) if (!live.has(k)) cache.current.delete(k);
  }, [count, keyOf, tick]);

  const offsets = useMemo(() => {
    const heights = new Array<number | undefined>(count);
    for (let i = 0; i < count; i++) heights[i] = known?.(i) ?? cache.current.get(keyOf(i));
    return buildOffsets(heights, count, estimate);
    // tick: the measured-height cache changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, keyOf, estimate, known, tick]);

  const range = useMemo(() => computeWindow(offsets, scrollTop, viewport, overscan), [offsets, scrollTop, viewport, overscan]);
  return { scrollRef, range, measure, offsets, scrollTop, viewport };
}
