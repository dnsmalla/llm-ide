// Next-launch crash notice (Mac `CrashReportBanner`): the host keeps at most a few small redacted records and
// hands over the newest one; Dismiss deletes them all. The record is untrusted text: every field is re-cleaned
// here and rendered as text. Pure apart from the host bridge, so it is tested with node.
import { invokeHost } from "./host";
import { safeText } from "./safe-text";

export interface CrashNotice {
  /** RFC 3339 UTC time of the crash. */
  at: string;
  message: string;
  location: string;
  appVersion: string;
  os: string;
  /** How many crash records are pending (the banner says "N times"). */
  count: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Defensive decode of `crash_report_latest`: anything malformed reads as no notice. */
export function decodeCrashNotice(raw: unknown): CrashNotice | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "string" || !ISO.test(o.at)) return null;
  if (typeof o.message !== "string" || typeof o.location !== "string") return null;
  if (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 1) return null;
  return {
    at: o.at,
    message: safeText(o.message, 1000),
    location: safeText(o.location, 300),
    appVersion: safeText(o.app_version, 40),
    os: safeText(o.os, 80),
    count: Math.min(o.count, 99),
  };
}

/** The banner's sentence, worded as the Mac's (`CrashReportBanner.message`). */
export function crashBannerMessage(count: number): string {
  return count === 1
    ? "LLM-IDE didn't close properly last time."
    : `LLM-IDE didn't close properly ${count} times since you last checked.`;
}

/** The text "Copy details" puts on the clipboard: the redacted record and nothing else. */
export function crashDetails(n: CrashNotice): string {
  return [
    "LLM-IDE crash report",
    `Time: ${n.at}`,
    `Message: ${n.message}`,
    `Location: ${n.location}`,
    `App version: ${n.appVersion}`,
    `OS: ${n.os}`,
  ].join("\n");
}

/** "Copy details": puts only `crashDetails(n)` on the clipboard and returns the status line the banner shows. */
export async function copyCrashDetails(n: CrashNotice, copy: (text: string) => Promise<void>): Promise<string> {
  try {
    await copy(crashDetails(n));
    return "Copied.";
  } catch {
    return "Could not copy. Select the details in a bug report instead.";
  }
}

/** The newest pending crash, or null (no crash, no host, or an unreadable answer). */
export async function loadCrashNotice(): Promise<CrashNotice | null> {
  try {
    return decodeCrashNotice(await invokeHost<unknown>("crash_report_latest"));
  } catch {
    return null;
  }
}

/** Deletes every pending crash record on the host. */
export async function dismissCrashNotice(): Promise<void> {
  await invokeHost<number>("crash_report_dismiss");
}
