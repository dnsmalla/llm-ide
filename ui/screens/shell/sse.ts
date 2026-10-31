// Server-sent events decoder (WHATWG EventSource framing) for fetch streams. Pure: no DOM, no IO.

export interface SseEvent {
  /** `message` when the frame has no `event:` field. */
  event: string;
  data: string;
  id: string | null;
  /** Reconnect hint in ms, when the frame carried `retry:`. */
  retry: number | null;
}

export class SseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseError";
  }
}

/** Default cap on one buffered event (including a partial line): bounds memory on a hostile or buggy peer. */
export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

export class SseDecoder {
  private buf = "";
  private started = false;
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private retry: number | null = null;
  private size = 0;

  constructor(private readonly maxEventChars: number = MAX_SSE_EVENT_BYTES) {}

  /** Feed decoded text; returns the events completed by it. Throws `SseError` past the size cap. */
  push(chunk: string): SseEvent[] {
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    let text = this.buf + chunk;
    this.buf = "";
    // A "\r" at the very end may be the first half of "\r\n": hold it back until we know.
    if (text.endsWith("\r")) {
      text = text.slice(0, -1);
      this.buf = "\r";
    }
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const line = text.slice(start, i);
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    const rest = text.slice(start);
    this.buf = rest + this.buf;
    if (this.size + this.buf.length > this.maxEventChars) throw new SseError("event exceeds the size limit");
    return out;
  }

  /** End of stream: a trailing partial event without a blank line is dropped, per the SSE spec. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf === "\r") {
      this.buf = "";
      const ev = this.line("");
      if (ev) out.push(ev);
    }
    this.reset();
    return out;
  }

  private reset(): void {
    this.buf = "";
    this.data = [];
    this.event = "";
    this.size = 0;
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        this.size = 0;
        return null;
      }
      const ev: SseEvent = { event: this.event || "message", data: this.data.join("\n"), id: this.id, retry: this.retry };
      this.data = [];
      this.event = "";
      this.retry = null;
      this.size = 0;
      return ev;
    }
    if (line.charCodeAt(0) === 58) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    this.size += line.length + 1;
    if (this.size > this.maxEventChars) throw new SseError("event exceeds the size limit");
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break;
    }
    return null;
  }
}
