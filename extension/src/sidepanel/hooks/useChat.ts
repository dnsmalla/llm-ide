import { useState, useCallback, useEffect, useRef } from 'react';
import { getServerUrl, REQUEST_TIMEOUT_MS, authFetch } from '../../lib/config';
import { listIssues, OFFLINE_MESSAGE } from '../../lib/kb';
import { errorText } from '../../lib/server-error';
import {
  ensureTranscriptSessionId,
  loadTranscriptMessages,
  appendChatMessage,
  clearChatSessionMessages,
  createChatSession,
  type UnifiedChatMessage,
} from '../../lib/unified-chat';

export interface ChatViewMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// How many prior messages we send to the LLM as context per /chat request.
const MAX_HISTORY = 10;
// Cleared once: the old local chat buffer (Q18: the extension stores nothing).
const LEGACY_LOCAL_KEYS = ['chatMessages', 'unifiedChatSessionId'];

function toChatMessage(m: UnifiedChatMessage): ChatViewMessage {
  return { role: m.role as 'user' | 'assistant', content: m.content, timestamp: m.timestamp };
}

export function useChat() {
  const [messages, setMessages] = useState<ChatViewMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // true when the Mac-managed server cannot be reached: nothing is stored.
  const [offline, setOffline] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const serverBackedRef = useRef(false);

  // Rehydrate from the server. There is no local fallback: when the server
  // cannot be reached the chat is offline and holds only what is in memory.
  const hydrate = useCallback(async (isCancelled: () => boolean) => {
    try {
      const sid = await ensureTranscriptSessionId();
      if (isCancelled()) return;
      if (!sid) {
        setOffline(true);
        return;
      }
      sessionIdRef.current = sid;
      serverBackedRef.current = true;
      const serverMsgs = await loadTranscriptMessages(sid);
      if (isCancelled()) return;
      setOffline(false);
      setMessages(serverMsgs.filter((m) => m.role === 'user' || m.role === 'assistant').map(toChatMessage));
    } catch {
      if (!isCancelled()) setOffline(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    chrome.storage?.local?.remove(LEGACY_LOCAL_KEYS).catch(() => {});
    void hydrate(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  // While offline, look for the Mac app again.
  useEffect(() => {
    if (!offline) return;
    let cancelled = false;
    const t = setInterval(() => void hydrate(() => cancelled), 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [offline, hydrate]);

  const sendMessage = useCallback(
    async (userMessage: string, transcript: string, language?: string) => {
      const trimmed = userMessage.trim();
      if (!trimmed || isLoading) return;
      setError(null);

      const issueKeywords = ['issue', 'issues', 'bug', 'ticket', 'github', '#'];
      const asksAboutIssues = issueKeywords.some((k) => trimmed.toLowerCase().includes(k));

      const userMsg: ChatViewMessage = {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };

      let historySnapshot: ChatViewMessage[] = [];
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
          const err = await response.json().catch(() => ({}));
          throw new Error(errorText(err, response.status));
        }

        const data = await response.json();
        if (typeof data?.reply !== 'string' || !data.reply.trim()) {
          throw new Error('Empty response from server');
        }
        const assistantMsg: ChatViewMessage = {
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
        if (err instanceof TypeError) {
          // fetch rejected: the server is not reachable.
          setOffline(true);
          setError(OFFLINE_MESSAGE);
          return;
        }
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
    setIsLoading(false);
    const sid = sessionIdRef.current;
    if (serverBackedRef.current && sid) {
      clearChatSessionMessages(sid).catch(() => {});
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

  return { messages, isLoading, error, offline, sendMessage, clearChat, createNewSession, deleteCurrentSession };
}
