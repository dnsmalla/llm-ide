// Maps a Host API failure to the friendly text a section shows in a Banner. No React.
export type FeatureErrorKind = "unavailable" | "denied" | "busy" | "other";
export interface FeatureError { kind: FeatureErrorKind; message: string }

const codeOf = (e: unknown): string | null =>
  e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : null;

/** `what` names the feature ("Auto Tasks", "Loop") in the unavailable text. */
export function mapFeatureError(e: unknown, what: string): FeatureError {
  const code = codeOf(e);
  const raw = e instanceof Error && e.message ? e.message.slice(0, 300) : "";
  if (code === "unknown_command" || code === "capability_unavailable") {
    return { kind: "unavailable", message: `This desktop does not offer ${what}. Update the desktop and check that Read + Compose are enabled in Phone and browser.` };
  }
  if (code === "denied") return { kind: "denied", message: raw || `The desktop did not allow this browser to use ${what}.` };
  if (code === "busy" || code === "rate_limited") return { kind: "busy", message: "The desktop is busy. Try again in a moment." };
  return { kind: "other", message: raw || "Something went wrong. Try again." };
}
