import { useState, useCallback, useRef } from 'react';
import { getServerUrl, REQUEST_TIMEOUT_MS, authFetch } from '../../lib/config';
import { conflictQuestions } from '../../lib/kb';
import { MsgType } from '../../lib/messages';

export type QuestionType = 'conflict' | 'confirm' | 'explain';

export function useQuestions() {
  const [questions, setQuestions] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const generate = useCallback(
    async (transcript: string, participants: string[], types: QuestionType[], language?: string) => {
      if (!transcript.trim()) {
        setError('No transcript available. Record a meeting first.');
        return;
      }
      if (types.length === 0) {
        setError('Pick at least one question type.');
        return;
      }
      if (busyRef.current) return;

      busyRef.current = true;
      setIsGenerating(true);
      setError(null);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const serverUrl = await getServerUrl();
        const response = await authFetch(`${serverUrl}/generate-questions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript, participants, types, language }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          if (response.status === 404) {
            throw new Error('This feature requires a newer server version. Please restart the server and try again.');
          }
          throw new Error(err.error || 'Failed to generate questions. Please try again.');
        }

        const data = await response.json();
        if (typeof data?.questions !== 'string' || !data.questions.trim()) {
          throw new Error('Empty response from server');
        }
        setQuestions(data.questions);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setError('Request timed out. Try again.');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to generate questions');
        }
      } finally {
        clearTimeout(timeout);
        busyRef.current = false;
        setIsGenerating(false);
      }
    },
    [],
  );

  const generateFromHistory = useCallback(async (transcript: string, language?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsGenerating(true);
    setError(null);
    try {
      const result = await conflictQuestions({ transcript, language });
      setQuestions((prev) => {
        if (prev && prev.trim()) return `${prev}\n\n## From history\n${result}`;
        return result;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to generate conflict questions');
    } finally {
      busyRef.current = false;
      setIsGenerating(false);
    }
  }, []);

  const clearQuestions = useCallback(() => {
    setQuestions('');
    setError(null);
  }, []);

  const postToChat = useCallback(async (text: string) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error('No active tab found. Is a Google Meet tab open?');
      }

      // Use the MsgType enum for type safety.
      // Wrap in a timeout: if the content script doesn't call
      // sendResponse (e.g. platform detection failed, or the
      // content script isn't loaded), the channel hangs until
      // Chrome's internal timeout (~5 min). Race against our own
      // 10s deadline so the user gets fast feedback.
      const responsePromise = chrome.tabs.sendMessage(tab.id, {
        type: MsgType.POST_CHAT,
        text,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'Chat injection timed out. The Meet tab may not have the extension loaded — try refreshing the page.',
              ),
            ),
          10_000,
        ),
      );
      const response = await Promise.race([responsePromise, timeoutPromise]);

      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to post to chat. Is the chat panel open?');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chat injection failed';
      // Chrome's "Receiving end does not exist" means the content
      // script isn't loaded on this tab.
      if (msg.includes('Receiving end does not exist')) {
        setError('Content script not loaded on this tab. Refresh the Meet page and try again.');
      } else {
        setError(msg);
      }
    }
  }, []);

  return { questions, isGenerating, error, generate, generateFromHistory, clearQuestions, postToChat };
}
