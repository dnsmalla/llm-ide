// The xterm seam. Implemented in `desktop/src/terminal/dockRuntime.ts` (the only place that imports xterm),
// faked in tests.
export interface TermViewOptions {
  scrollback: number;
  onLink(url: string): void;
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
  fit(): { cols: number; rows: number };
  size(): { cols: number; rows: number };
  focus(): void;
  notice(text: string): void;
  dispose(): void;
}

export interface TerminalRuntime {
  create(el: HTMLElement, opts: TermViewOptions): TermView;
  /** Opens a link through the host's validated opener. */
  openUrl(url: string): Promise<unknown>;
}
