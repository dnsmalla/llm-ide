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
// Maximum number of messages kept in chrome.storage.local.  The 5 MB quota
// is shared with the transcript store; capping chat history here prevents
// one long session from crowding out transcripts.  The in-context MAX_HISTORY
// (prompt size) is separate and unchanged.
const MAX_STORED_MESSAGES = 200;

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
    // Prune to the most recent MAX_STORED_MESSAGES before writing so the
    // chat store doesn't crowd out transcripts in the shared 5 MB quota.
    // The in-context MAX_HISTORY (prompt size) is a separate, smaller cap.
    const toStore = messages.length > MAX_STORED_MESSAGES ? messages.slice(-MAX_STORED_MESSAGES) : messages;
    chrome.storage?.local?.set({ [STORAGE_KEY]: toStore }).catch((err: Error) => {
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
