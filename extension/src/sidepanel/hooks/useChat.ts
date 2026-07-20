import { useState, useCallback, useEffect, useRef } from 'react';
import { getServerUrl, REQUEST_TIMEOUT_MS, authFetch } from '../../lib/config';
import { listIssues } from '../../lib/kb';
import {
  ensureTranscriptSessionId,
  loadTranscriptMessages,
  appendChatMessage,
  clearChatSessionMessages,
  createChatSession,
  type UnifiedChatMessage,
} from '../../lib/unified-chat';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// How many prior messages we send to the LLM as context per /chat request.
const MAX_HISTORY = 10;
const STORAGE_KEY = 'chatMessages';
const MAX_STORED_MESSAGES = 200;

function toChatMessage(m: UnifiedChatMessage): ChatMessage {
  return { role: m.role as 'user' | 'assistant', content: m.content, timestamp: m.timestamp };
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaWarning, setQuotaWarning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hydratedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const serverBackedRef = useRef(false);

  // Rehydrate from server (preferred) or chrome.storage fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sid = await ensureTranscriptSessionId();
        if (cancelled) return;
        if (sid) {
          sessionIdRef.current = sid;
          serverBackedRef.current = true;
          const serverMsgs = await loadTranscriptMessages(sid);
          if (cancelled) return;
          if (serverMsgs.length > 0) {
            setMessages(serverMsgs.filter((m) => m.role === 'user' || m.role === 'assistant').map(toChatMessage));
            hydratedRef.current = true;
            return;
          }
        }
      } catch {
        // fall through to local storage
      }
      try {
        const result = await chrome.storage?.local?.get(STORAGE_KEY);
        const saved = result?.[STORAGE_KEY];
        if (!cancelled && Array.isArray(saved)) setMessages(saved);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) hydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Local fallback persistence when server sync unavailable.
  useEffect(() => {
    if (!hydratedRef.current || serverBackedRef.current) return;
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

      const issueKeywords = ['issue', 'issues', 'bug', 'ticket', 'github', '#'];
      const asksAboutIssues = issueKeywords.some((k) => trimmed.toLowerCase().includes(k));

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

      const sid = sessionIdRef.current;
      if (serverBackedRef.current && sid) {
        try {
          await appendChatMessage(sid, 'user', trimmed);
        } catch {
          /* non-fatal — still answer */
        }
      }

      setIsLoading(true);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const serverUrl = await getServerUrl();

        let issueContext = '';
        if (asksAboutIssues) {
          try {
            const issues = await listIssues({ state: 'open', limit: 10 });
            if (issues && issues.length > 0) {
              issueContext = '\n\nRelevant open issues from the knowledge base:\n';
              issues.forEach((issue) => {
                issueContext += `- #${issue.number}: ${issue.title} (${issue.state}) - ${issue.url}\n`;
              });
            }
          } catch {
            /* non-fatal */
          }
        }

        const response = await authFetch(`${serverUrl}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed + issueContext,
            transcript,
            history: historySnapshot,
            language,
          }),
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

        if (serverBackedRef.current && sid) {
          try {
            await appendChatMessage(sid, 'assistant', data.reply);
          } catch {
            /* non-fatal */
          }
        }
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
    const sid = sessionIdRef.current;
    if (serverBackedRef.current && sid) {
      clearChatSessionMessages(sid).catch(() => {});
    } else {
      chrome.storage?.local?.remove(STORAGE_KEY).catch(() => {});
    }
  }, []);

  const createNewSession = useCallback(async () => {
    try {
      clearChat();
      const newSession = await createChatSession({ title: 'New Chat' });
      sessionIdRef.current = newSession.id;
      serverBackedRef.current = true;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create new session');
    }
  }, [clearChat]);

  const deleteCurrentSession = useCallback(async () => {
    try {
      clearChat();
      sessionIdRef.current = null;
      serverBackedRef.current = false;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete session');
    }
  }, [clearChat]);

  return { messages, isLoading, error, quotaWarning, sendMessage, clearChat, createNewSession, deleteCurrentSession };
}
