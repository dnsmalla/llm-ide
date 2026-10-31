// Message protocol between the parent (the app) and the sandboxed mermaid frame. The frame has an opaque origin, so
// the parent identifies it by `event.source`, never by origin; every message is parsed strictly here and anything
// else is ignored. The diagram text travels ONLY inside a `render` message, never inside HTML.
import { MAX_SVG_BYTES } from "./svg-sanitize.ts";

export const RENDER_TIMEOUT_MS = 10_000;
export const MAX_ERROR_CHARS = 300;
export type MermaidTheme = "dark" | "default";

export type ParentMessage = { type: "render"; id: number; source: string; theme: MermaidTheme };
export type FrameMessage =
  | { type: "ready" }
  | { type: "result"; id: number; svg: string }
  | { type: "error"; id: number; message: string }
  | { type: "fatal"; message: string };

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A strict parse of whatever arrived on `message`. `null` = ignore it. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case "ready":
      return { type: "ready" };
    case "result":
      if (!isId(d.id) || typeof d.svg !== "string" || d.svg.length > MAX_SVG_BYTES) return null;
      return { type: "result", id: d.id, svg: d.svg };
    case "error":
      if (!isId(d.id) || typeof d.message !== "string") return null;
      return { type: "error", id: d.id, message: cleanMessage(d.message) };
    case "fatal":
      if (typeof d.message !== "string") return null;
      return { type: "fatal", message: cleanMessage(d.message) };
    default:
      return null;
  }
}

/** Frame-supplied text is shown as plain text only; strip control characters and cap it. */
export function cleanMessage(m: string): string {
  // eslint-disable-next-line no-control-regex
  return m.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_ERROR_CHARS) || "The diagram could not be rendered.";
}

export function renderMessage(id: number, source: string, theme: MermaidTheme): ParentMessage {
  return { type: "render", id, source, theme };
}
