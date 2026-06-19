import { useState, useCallback, useEffect, useRef } from 'react';
import { getServerUrl, REQUEST_TIMEOUT_MS, authFetch } from '../../lib/config';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// How many prior messages we send to the LLM as context per /chat request.
// This is a PROMPT-SIZE bound, not a storage bound — it keeps Claude fast
// and stops the context from growing unboundedly on long sessions.
const MAX_HISTORY = 10;
const STORAGE_KEY = 'chatMessages';

// NOTE: we intentionally do NOT cap persisted chat history.  The user owns
// their conversation and may want to scroll back through weeks of threads.
// chrome.storage.local has a ~5 MB per-extension quota which comfortably
// holds tens of thousands of chat messages; if a write ever fails with
// QUOTA_BYTES, we surface it as a warning rather than silently dropping
// old messages.

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaWarning, setQuotaWarning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hydratedRef = useRef(false);

  // Rehydrate from storage on mount, then persist on every change.
  useEffect(() => {
    chrome.storage?.local
      ?.get(STORAGE_KEY)
      .then((result) => {
        const saved = result?.[STORAGE_KEY];
        if (Array.isArray(saved)) setMessages(saved);
      })
      .catch(() => {})
      .finally(() => {
        hydratedRef.current = true;
      });
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    // Persist the full conversation.  If chrome.storage reports a quota
    // error (QUOTA_BYTES ~5 MB), surface a non-fatal warning instead of
    // silently dropping messages — the user asked for no retention cap.
    chrome.storage?.local?.set({ [STORAGE_KEY]: messages }).catch((err: Error) => {
      const msg = err?.message || String(err);
      if (/QUOTA_BYTES|quota/i.test(msg)) {
        setQuotaWarning(
          "Chat history is approaching Chrome's 5 MB storage limit. " +
            'Export what you want to keep, then click Clear chat.',
        );
      }
    });
  }, [messages]);

  const sendMessage = useCallback(
    async (userMessage: string, transcript: string, language?: string) => {
      const trimmed = userMessage.trim();
      if (!trimmed || isLoading) return;
      setError(null);

      const userMsg: ChatMessage = {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };

      let historySnapshot: ChatMessage[] = [];
      setMessages((prev) => {
        const updated = [...prev, userMsg];
        historySnapshot = updated.slice(-MAX_HISTORY);
        return updated;
      });

      setIsLoading(true);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const serverUrl = await getServerUrl();
        const response = await authFetch(`${serverUrl}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, transcript, history: historySnapshot, language }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Server error' }));
          throw new Error(err.error || `Server error: ${response.status}`);
        }

        const data = await response.json();
        if (typeof data?.reply !== 'string' || !data.reply.trim()) {
          throw new Error('Empty response from server');
        }
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: data.reply,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        clearTimeout(timeout);
        setIsLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [isLoading],
  );

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setQuotaWarning(null);
    setIsLoading(false);
    chrome.storage?.local?.remove(STORAGE_KEY).catch(() => {});
  }, []);

  return { messages, isLoading, error, quotaWarning, sendMessage, clearChat };
}
