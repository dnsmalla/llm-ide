// Virtualised message list: only the messages near the viewport are in the DOM. Follows a running stream
// while the user is at the bottom, pages older history in near the top (keeping the scroll position).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { MessageView, type MessageHost } from "./MessageView";
import type { Message } from "./state";
import { isNearBottom, prependScrollAdjust, shouldLoadOlder } from "./virtual";
import { useVirtualList } from "./hooks";

export const MESSAGE_ESTIMATE_PX = 120;

interface Props extends MessageHost {
  messages: readonly Message[];
  hasMoreOlder: boolean;
  /** Pages older messages in; resolves with how many were added. */
  onLoadOlder: () => Promise<number>;
  /** Restore this scrollTop on mount (per-chat position); null = bottom. */
  initialScrollTop: number | null;
  onScrollState: (scrollTop: number, stick: boolean) => void;
  empty?: React.ReactNode;
}

function Row({ index, message, host, measure }: { index: number; message: Message; host: MessageHost; measure: (i: number, h: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure(index, el.offsetHeight);
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => measure(index, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, measure]);
  return <div ref={ref} role="listitem" className="chat-row"><MessageView m={message} host={host} /></div>;
}

export function MessageList({ messages, hasMoreOlder, onLoadOlder, initialScrollTop, onScrollState, onOpenLink, onCopy, empty }: Props) {
  const keyOf = useCallback((i: number) => messages[i]?.id ?? String(i), [messages]);
  const { scrollRef, range, measure, offsets, scrollTop, viewport } = useVirtualList(messages.length, keyOf, MESSAGE_ESTIMATE_PX);
  const stick = useRef(initialScrollTop === null);
  const loading = useRef(false);
  const firstId = useRef<string | null>(null);
  const lastCount = useRef(0);
  const host = useMemo<MessageHost>(() => ({ onOpenLink, onCopy }), [onOpenLink, onCopy]);

  // Report position upward (per-chat scroll memory) and track "following the stream".
  useEffect(() => {
    stick.current = isNearBottom(scrollTop, viewport, offsets[messages.length] ?? 0);
    onScrollState(scrollTop, stick.current);
  }, [scrollTop, viewport, offsets, messages.length, onScrollState]);

  // Restore on mount.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && initialScrollTop !== null) el.scrollTop = initialScrollTop;
    else if (el) el.scrollTop = el.scrollHeight;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the stream, or keep the anchor when older messages were prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = messages[0]?.id ?? null;
    const prepended = firstId.current !== null && id !== firstId.current && messages.length > lastCount.current;
    if (prepended) {
      const oldFirst = messages.findIndex((m) => m.id === firstId.current);
      if (oldFirst > 0) el.scrollTop += prependScrollAdjust(offsets, oldFirst);
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstId.current = id;
    lastCount.current = messages.length;
  }, [messages, offsets, scrollRef]);

  // Load older history when scrolled near the top.
  useEffect(() => {
    if (!hasMoreOlder || loading.current || !shouldLoadOlder(scrollTop)) return;
    loading.current = true;
    void onLoadOlder().finally(() => { loading.current = false; });
  }, [scrollTop, hasMoreOlder, onLoadOlder]);

  return (
    <div ref={scrollRef} className="chat-scroll" role="log" aria-label="Conversation" aria-live="off" tabIndex={0}>
      {messages.length === 0 ? (empty ?? null) : (
        <>
        {hasMoreOlder && <p className="chat-muted chat-older" role="status">Loading earlier messages…</p>}
        <div role="list" className="chat-list" style={{ paddingTop: range.padTop, paddingBottom: range.padBottom }}>
          {messages.slice(range.start, range.end).map((m, k) => (
            <Row key={m.id} index={range.start + k} message={m} host={host} measure={measure} />
          ))}
        </div>
        </>
      )}
    </div>
  );
}
