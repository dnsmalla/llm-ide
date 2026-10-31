// xterm.js side of the Explorer terminal dock. `@xterm/*` and Tauri are not resolvable from `ui/screens`, so the
// screen loads this module lazily through a `TerminalRuntime` seam and tests use a fake.
//
// Safety rules implemented here:
//  - scrollback is capped (memory bound per terminal),
//  - flow control: bytes are credited back to the host (`pty_ack`) only once xterm has PARSED them,
//  - pasted text is sanitised (no ESC / control characters: a pasted `ESC[201~` could end a bracketed paste
//    early), and a multi-line paste into a shell that did NOT enable bracketed paste needs confirmation,
//  - links in output open through the host's validated `open_external_url` (never `window.open` / raw),
//  - on Windows/Linux Ctrl+C stays SIGINT; copy / paste are Ctrl+Shift+C / Ctrl+Shift+V.
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { spawnShell, type PtyHandle } from "./ptyClient";
import { terminalFont, xtermTheme } from "./xtermTheme";

export interface ViewOptions {
  scrollback: number;
  /** A link was activated; the caller opens it through the host. */
  onLink(url: string): void;
  /** Multi-line paste into a non-bracketed shell: resolve true to paste. */
  confirmPaste(text: string): Promise<boolean>;
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  sanitizePaste(text: string): string;
  needsPasteConfirm(text: string, bracketed: boolean): boolean;
  findUrls(line: string): Array<{ start: number; end: number; url: string }>;
  isMac: boolean;
}

export interface TermView {
  write(bytes: Uint8Array, parsed: () => void): void;
  /** Fits to the container and returns the new size. */
  fit(): { cols: number; rows: number };
  size(): { cols: number; rows: number };
  focus(): void;
  notice(text: string): void;
  dispose(): void;
}

export function createTermView(el: HTMLElement, o: ViewOptions): TermView {
  const t = new Terminal({ ...terminalFont(), theme: xtermTheme(), cursorBlink: true, scrollback: o.scrollback, allowProposedApi: true, macOptionIsMeta: false });
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.open(el);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    t.loadAddon(webgl);
  } catch {
    // no WebGL2: xterm keeps its DOM renderer
  }
  const subs: IDisposable[] = [];
  subs.push(t.onData((d) => o.onData(d)));
  subs.push(t.onResize(({ cols, rows }) => o.onResize(cols, rows)));
  subs.push(
    t.registerLinkProvider({
      provideLinks(y, cb) {
        const line = t.buffer.active.getLine(y - 1);
        if (!line) return cb(undefined);
        const text = line.translateToString(true);
        const found = o.findUrls(text);
        cb(found.length === 0 ? undefined : found.map((f) => ({ range: { start: { x: f.start + 1, y }, end: { x: f.end, y } }, text: f.url, activate: (_e, url) => o.onLink(url) })));
      },
    }),
  );
  const doPaste = (raw: string) => {
    const text = o.sanitizePaste(raw);
    if (text === "") return;
    if (o.needsPasteConfirm(text, t.modes.bracketedPasteMode)) {
      void o.confirmPaste(text).then((ok) => ok && t.paste(text));
    } else {
      t.paste(text);
    }
  };
  const onPaste = (ev: ClipboardEvent) => {
    const raw = ev.clipboardData?.getData("text/plain") ?? "";
    ev.preventDefault();
    ev.stopPropagation();
    doPaste(raw);
  };
  el.addEventListener("paste", onPaste, true);
  t.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Dock toggle must reach the app, not the shell.
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "`") return false;
    if (!o.isMac && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      const sel = t.getSelection();
      if (sel) void navigator.clipboard?.writeText(sel).catch(() => undefined);
      return false;
    }
    if (!o.isMac && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
      void navigator.clipboard?.readText().then(doPaste).catch(() => undefined);
      return false;
    }
    return true;
  });
  const themeObserver = new MutationObserver(() => {
    t.options.theme = xtermTheme();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return {
    write: (bytes, parsed) => t.write(bytes, parsed),
    fit() {
      try {
        fit.fit();
      } catch {
        // not laid out yet (hidden): keep the previous size
      }
      return { cols: t.cols, rows: t.rows };
    },
    size: () => ({ cols: t.cols, rows: t.rows }),
    focus: () => t.focus(),
    notice: (text) => t.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`),
    dispose() {
      themeObserver.disconnect();
      el.removeEventListener("paste", onPaste, true);
      for (const s of subs) s.dispose();
      t.dispose();
    },
  };
}

export type { PtyHandle };

/** The host side used by `TerminalManager`. */
export const hostTerminal = {
  status: () => invoke<{ enabled: boolean; consent: "unasked" | "granted" | "denied"; shell: string }>("pty_status"),
  retryConsent: () => invoke<{ enabled: boolean; consent: "unasked" | "granted" | "denied"; shell: string }>("pty_retry_consent"),
  spawn: spawnShell,
  openUrl: (url: string) => invoke<boolean>("open_external_url", { url }),
};
