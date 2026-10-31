// Pure terminal text rules: paste sanitising, link detection, flow-control credit batching.

/** Default scrollback per terminal (lines): bounds memory at roughly 8 terminals x 10k lines. */
export const DEFAULT_SCROLLBACK = 10_000;
export const MIN_SCROLLBACK = 1_000;
export const MAX_SCROLLBACK = 100_000;

export function clampScrollback(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : DEFAULT_SCROLLBACK;
  return Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, v));
}

/** A paste larger than this is cut (a clipboard of megabytes would freeze the shell and the webview). */
export const MAX_PASTE_CHARS = 100_000;

/**
 * Removes ESC and other control characters from pasted text (keeps tab and line breaks). Without this, pasted
 * `ESC[201~` ends a bracketed paste early and the rest runs as typed commands.
 */
export function sanitizePaste(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.slice(0, MAX_PASTE_CHARS).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "");
}

/** A multi-line paste into a shell that did not turn on bracketed paste would execute line by line: ask first. */
export function needsPasteConfirm(text: string, bracketed: boolean): boolean {
  return !bracketed && text.replace(/\n+$/, "").includes("\n");
}

const URL_RE = /https?:\/\/[^\s<>"'`\\^{}|]+/g;
const count = (s: string, ch: string) => s.split(ch).length - 1;

/** http(s) URLs in one terminal line: `start` inclusive, `end` exclusive (string indices). */
export function findUrls(line: string): Array<{ start: number; end: number; url: string }> {
  const out: Array<{ start: number; end: number; url: string }> = [];
  if (line.length > 4000) return out;
  for (const m of line.matchAll(URL_RE)) {
    let url = m[0];
    // Sentence punctuation is not part of the URL; a closing paren is only when it balances an opening one.
    while (url.length > 0) {
      const last = url[url.length - 1]!;
      if (".,;:!?'\">]}".includes(last) || (last === ")" && count(url, ")") > count(url, "("))) url = url.slice(0, -1);
      else break;
    }
    if (url.length <= "https://".length || url.length > 2000) continue;
    const start = m.index ?? 0;
    out.push({ start, end: start + url.length, url });
  }
  return out;
}

/** A link a program emitted (OSC 8 carries arbitrary text/schemes): only plain http(s) URLs without credentials open. */
export function isOpenableLink(uri: string): boolean {
  if (uri.length > 2000 || /[\u0000-\u001f\u007f\s]/.test(uri)) return false;
  try {
    const u = new URL(uri);
    return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Batches flow-control credit: xterm reports each parsed output batch; the host is told in chunks, far below
 * the host's high-water mark (1 MiB), so a flood pauses instead of overrunning the terminal.
 */
export class AckBatcher {
  private pending = 0;
  constructor(private readonly send: (bytes: number) => void, private readonly chunk = 128 * 1024) {}
  processed(n: number): void {
    this.pending += n;
    if (this.pending >= this.chunk) this.flush();
  }
  flush(): void {
    if (this.pending > 0) {
      const n = this.pending;
      this.pending = 0;
      this.send(n);
    }
  }
}
