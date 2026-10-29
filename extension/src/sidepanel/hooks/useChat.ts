import { useState, useCallback, useEffect, useRef } from 'react';
import { getServerUrl, REQUEST_TIMEOUT_MS, authFetch } from '../../lib/config';
import { listIssues, OFFLINE_MESSAGE } from '../../lib/kb';
import { buildTurnMessage, dropV2Session, runV2Turn, V2TurnError, type V2Turn } from '../../lib/agent-v2-client';
import {
  settleLegacyChat,
  discardLegacyChat,
  legacyChatJson,
  type LegacyChatMessage,
  type LegacyChatArea,
} from '../../lib/legacy-chat';
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

// How many earlier messages seed a fresh engine session (SESSION_UNRESUMABLE retry).
const MAX_HISTORY = 10;

function toChatMessage(m: UnifiedChatMessage): ChatViewMessage {
  return { role: m.role as 'user' | 'assistant', content: m.content, timestamp: m.timestamp };
}

export function useChat() {
  const [messages, setMessages] = useState<ChatViewMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // true when the Mac-managed server cannot be reached: nothing is stored.
  const [offline, setOffline] = useState(false);
  // The old local chat buffer, when it is the only copy (offered for Export).
  const [legacyChat, setLegacyChat] = useState<LegacyChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // The meeting transcript the engine has already been given in this chat.
  const sentTranscriptRef = useRef('');
  const messagesRef = useRef<ChatViewMessage[]>([]);
  const serverBackedRef = useRef(false);
  messagesRef.current = messages;

  // Rehydrate from the server. There is no local fallback: when the server
  // cannot be reached the chat is offline and holds only what is in memory.
  const hydrate = useCallback(async (isCancelled: () => boolean) => {
    try {
      const sid = await ensureTranscriptSessionId();
      if (isCancelled()) return;
      if (!sid) {
        setOffline(true);
        // Server not reached: never remove the old buffer; surface it if it holds messages.
        void settleLegacyChat(chrome.storage?.local as unknown as LegacyChatArea, false).then(setLegacyChat);
        return;
      }
      sessionIdRef.current = sid;
      serverBackedRef.current = true;
      const serverMsgs = await loadTranscriptMessages(sid);
      if (isCancelled()) return;
      setOffline(false);
      // The server answered: an empty old buffer may go; a non-empty one is offered for export.
      void settleLegacyChat(chrome.storage?.local as unknown as LegacyChatArea, true).then(setLegacyChat);
      setMessages(serverMsgs.filter((m) => m.role === 'user' || m.role === 'assistant').map(toChatMessage));
    } catch {
      if (!isCancelled()) setOffline(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void hydrate(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  // Cancel a running turn when the panel unmounts.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

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

      const userMsg: ChatViewMessage = { role: 'user', content: trimmed, timestamp: Date.now() };
      // The chat's earlier turns, for the fresh-session retry only.
      const earlier: V2Turn[] = messagesRef.current
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content }));
      setMessages((prev) => [...prev, userMsg]);

      setIsLoading(true);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let streamed = '';
      let accepted = false;
      let sid = sessionIdRef.current;
      const persist = async (role: 'user' | 'assistant', content: string) => {
        if (!serverBackedRef.current || !sid || !content.trim()) return;
        try {
          await appendChatMessage(sid, role, content);
        } catch {
          /* non-fatal: the live answer is already on screen */
        }
      };

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

        // The engine keys its conversation on the chat session id. When no
        // server session could be made there is nothing to continue: ask the
        // server for one now (it is the same rolling session the Mac archives).
        if (!sid) {
          sid = await ensureTranscriptSessionId();
          if (!sid) throw new TypeError('server unreachable');
          sessionIdRef.current = sid;
          serverBackedRef.current = true;
        }

        const turn = buildTurnMessage({
          message: trimmed,
          transcript,
          sentTranscript: sentTranscriptRef.current,
          extra: issueContext,
        });

        const result = await runV2Turn({
          fetchFn: (url, init) => authFetch(url, init),
          serverUrl,
          request: { message: turn.text, chatSessionId: sid, language, history: earlier },
          signal: controller.signal,
          onAccepted: () => {
            accepted = true;
            // Only a turn the server accepted is stored: a refused one (another
            // panel is answering) leaves no stray user row behind.
            void persist('user', trimmed);
            setMessages((prev) => [...prev, { role: 'assistant', content: '', timestamp: Date.now() }]);
          },
          onDelta: (piece) => {
            streamed += piece;
            setMessages((prev) => {
              const next = prev.slice();
              const last = next[next.length - 1];
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: streamed };
              return next;
            });
          },
        });
        sentTranscriptRef.current = turn.sentTranscript;
        if (!result.text.trim()) throw new Error('Empty response from server');
        await persist('assistant', result.text);
      } catch (err: unknown) {
        const partial = err instanceof V2TurnError && err.partialText ? err.partialText : streamed;
        if (accepted) {
          // The user message is stored: keep the partial answer with it, so the
          // archive matches what the engine's own transcript holds.
          if (partial.trim()) await persist('assistant', partial);
          else
            setMessages((prev) =>
              prev[prev.length - 1]?.role === 'assistant' && !prev[prev.length - 1].content ? prev.slice(0, -1) : prev,
            );
        }
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof TypeError) {
          // fetch rejected before any answer: the server is not reachable.
          setOffline(true);
          setError(OFFLINE_MESSAGE);
          return;
        }
        if (err instanceof V2TurnError && err.code === 'ENDPOINT_REMOVED') {
          setError(err.message);
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
    sentTranscriptRef.current = '';
    setMessages([]);
    setError(null);
    setIsLoading(false);
    const sid = sessionIdRef.current;
    if (serverBackedRef.current && sid) {
      clearChatSessionMessages(sid).catch(() => {});
      // The engine keeps its own copy of the conversation: forget it too, or a
      // cleared chat would still "remember" what was cleared.
      void getServerUrl().then((url) => dropV2Session((u, i) => authFetch(u, i), url, sid));
    }
  }, []);

  /** Save the old local buffer to a file, then remove it. */
  const exportLegacyChat = useCallback(async () => {
    const url = URL.createObjectURL(new Blob([legacyChatJson(legacyChat)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'llm-ide-old-chat.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    await discardLegacyChat(chrome.storage.local as unknown as LegacyChatArea).catch(() => {});
    setLegacyChat([]);
  }, [legacyChat]);

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

  return {
    messages,
    isLoading,
    error,
    offline,
    legacyChat,
    exportLegacyChat,
    sendMessage,
    clearChat,
    createNewSession,
    deleteCurrentSession,
  };
}
