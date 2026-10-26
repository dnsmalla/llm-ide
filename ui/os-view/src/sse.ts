// A small Server-Sent Events parser. EventSource cannot send an Authorization
// header, so the stream is read with fetch and parsed here.

export type SseMessage = { event: string; data: string };

export type SseParser = { push(chunk: string): void };

/**
 * Feeds text chunks (split anywhere, even mid-line) and calls onMessage once
 * per dispatched event. Comment lines (":heartbeat") and fields other than
 * event/data are ignored. A blank line dispatches, but only when the event
 * carries data, as the SSE spec requires.
 */
export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let pending = '';
  let eventName = '';
  let dataLines: string[] = [];
  let hasData = false;

  const dispatch = (): void => {
    if (hasData) onMessage({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
    hasData = false;
  };

  const handleLine = (line: string): void => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
      hasData = true;
    }
  };

  return {
    push(chunk: string): void {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        let line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        handleLine(line);
        newline = pending.indexOf('\n');
      }
    },
  };
}
