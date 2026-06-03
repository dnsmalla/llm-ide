import { getServerUrl, REQUEST_TIMEOUT_MS , authFetch} from './config';

/**
 * Generate meeting notes — streaming variant.
 * Calls `onChunk(text)` for each text delta as it arrives from the server.
 * Returns the full concatenated text when done.
 * Falls back to non-streaming if the server doesn't support SSE.
 */
export async function generateMeetingNotesStream(
  transcript: string,
  onChunk: (chunk: string) => void,
  meetingTitle?: string,
  participants?: string[],
  externalSignal?: AbortSignal,
  language?: string,
): Promise<string> {
  const serverUrl = await getServerUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await authFetch(`${serverUrl}/generate-notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ transcript, meetingTitle, participants, language }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Server error: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // SSE streaming path — server responded with event-stream.
    if (contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (split on double newline).
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          if (!event.trim()) continue;
          const dataLine = event.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const jsonStr = dataLine.slice(6);

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            // Malformed JSON line from the SSE stream — skip it.
            continue;
          }

          if (parsed.type === 'chunk' && typeof parsed.text === 'string') {
            fullText += parsed.text;
            onChunk(parsed.text);
          } else if (parsed.type === 'done') {
            // Server sends the full text in the final event as a
            // consistency check. Use it if our accumulated text is
            // shorter (dropped chunks).
            if (typeof parsed.text === 'string' && parsed.text.length > fullText.length) {
              fullText = parsed.text;
            }
          } else if (parsed.type === 'error') {
            throw new Error(
              typeof parsed.error === 'string' ? parsed.error : 'Server streaming error',
            );
          }
        }
      }

      if (!fullText.trim()) {
        throw new Error('Empty response from server');
      }
      return fullText;
    }

    // Non-streaming fallback — server responded with JSON.
    const data = await response.json();
    if (typeof data?.notes !== 'string' || !data.notes.trim()) {
      throw new Error('Empty response from server');
    }
    onChunk(data.notes);
    return data.notes;

  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out. The AI is taking too long — try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Non-streaming variant — kept for backward compatibility.
 */
export async function generateMeetingNotes(
  transcript: string,
  meetingTitle?: string,
  participants?: string[],
  externalSignal?: AbortSignal,
  language?: string,
): Promise<string> {
  const serverUrl = await getServerUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await authFetch(`${serverUrl}/generate-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, meetingTitle, participants, language }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Server error: ${response.status}`);
    }

    const data = await response.json();
    if (typeof data?.notes !== 'string' || !data.notes.trim()) {
      throw new Error('Empty response from server');
    }
    return data.notes;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out. The AI is taking too long — try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
