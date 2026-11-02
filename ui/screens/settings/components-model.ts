// Pure parts of the two groups that talk to host commands instead of core routes:
//   - Optional components: the on-demand Mermaid runtime (status, install, remove);
//   - Server & Backend: the core's log tail (read, clear).
// Decoders are defensive because the answers cross the IPC boundary; the renderer shows text only.
import type { ComponentStatus, CoreLogText, RtkStatus } from "./host.ts";

export const MERMAID_TEXT = {
  title: "Mermaid diagram renderer",
  hint:
    "Used by Doc Gen and Visual for diagrams. It is downloaded only when you ask, from the host named below, " +
    "checked against a pinned SHA-256, and stored in this app's data folder. It runs only inside a sandboxed frame.",
  install: "Install renderer",
  remove: "Remove renderer",
  installed: "Installed",
  absent: "Not installed",
  declined: "Nothing changed.",
} as const;

export const RTK_TEXT = {
  hint:
    "rtk shrinks shell command output before Claude Code reads it, which cuts token use in your own Claude Code " +
    "sessions. It does not change chats inside LLM-IDE.",
  absent: "Not installed",
  install: "Install rtk",
  checking: "Checking for rtk...",
  brewMissing: "Homebrew isn't installed. Install it from brew.sh, then come back here.",
  enable:
    "To turn it on, run `rtk init -g` in Terminal and restart Claude Code. Note: rtk then lets the commands it " +
    "rewrites run without asking you, including `git push`.",
  installing: "Installing with Homebrew — this can take a minute...",
} as const;

export function decodeRtkStatus(v: unknown): RtkStatus | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const version = o.version === null ? null : str(o.version, 120);
  if (typeof o.installed !== "boolean" || typeof o.canInstall !== "boolean") return null;
  if (o.version !== null && version === null) return null;
  return { installed: o.installed, version, canInstall: o.canInstall };
}


export const LOG_TEXT = {
  title: "Backend log",
  empty: "No log entries yet. The core writes warnings and errors here; a quiet start writes nothing.",
  hint: "The last part of the core's log on this computer. Paths and request ids only; never a token, key or request body.",
  clear: "Clear log",
  clearConfirm: "Clear this log?",
  cleared: "Log cleared.",
  autoScroll: "Auto-scroll",
} as const;

/** How often the open Backend log group re-reads the core's log tail (the host caps the file it reads). */
export const LOG_POLL_MS = 2000;

/** The most the page accepts from the host, even though the host caps the file it reads. */
export const MAX_LOG_CHARS = 64 * 1024;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

/** `{ installed, version, sizeBytes, host }` or null. */
export function decodeComponentStatus(v: unknown): ComponentStatus | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const version = str(o.version, 40);
  const host = str(o.host, 120);
  const size = o.sizeBytes;
  if (typeof o.installed !== "boolean" || version === null || host === null) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0 || size > 500_000_000) return null;
  return { installed: o.installed, version, sizeBytes: Math.round(size), host };
}

/** `{ path, text, exists }` or null. The text is cut to its tail and NULs are dropped. */
export function decodeCoreLog(v: unknown): CoreLogText | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const path = str(o.path, 4096);
  const exists = o.exists;
  if (path === null || typeof o.text !== "string" || typeof exists !== "boolean") return null;
  let text = o.text.replace(/\u0000/g, "");
  if (text.length > MAX_LOG_CHARS) text = text.slice(text.length - MAX_LOG_CHARS);
  return { path, text, exists };
}

/** 0 B, 81 KB, 1.2 MB — approximate is fine for a component size. */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the Optional components card says about the renderer right now. */
export function componentStateLabel(s: ComponentStatus | null): string {
  return !s || !s.installed ? MERMAID_TEXT.absent : MERMAID_TEXT.installed;
}

/** `path` shown as the last two segments, so a long data-dir path stays readable. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/** A plain error sentence for the component/log actions (the host code is technical only). */
export function componentError(e: unknown): string {
  if (typeof e === "string" && e.trim()) return e.slice(0, 200);
  const code = (e as { code?: unknown } | null)?.code;
  switch (code) {
    case "busy":
      return "Another install is already running. Try again when it finishes.";
    case "rate_limited":
      return "Too many attempts. Wait a minute and try again.";
    case "integrity":
      return "The download did not match the pinned checksum and was discarded. Try again later.";
    case "too_large":
      return "The download was larger than expected and was discarded.";
    case "not_installed":
      return "The renderer is not installed.";
    case "io":
      return "The app could not write to its data folder. Check disk space and permissions.";
    default:
      return e instanceof Error && e.message ? e.message : "The action failed.";
  }
}
