// Easy setup for Google: no Google Cloud project, no OAuth. Three cards (Gmail by app password, Calendar by the
// secret iCal address, Drive by the Drive for desktop folder). This file holds the words, the pure checks and the
// small state machines; the cards are in EasySetup.tsx. The OAuth path is the "Advanced" section of the pane.

export interface Guide {
  title: string;
  steps: readonly string[];
}

export const EASY_INTRO =
  "Easy setup: three ways to bring Google into the Library without creating anything in Google Cloud. Each is read-only. Use the Advanced section below only if you want Gmail, Calendar and Drive through your own Google Cloud client (more complete, but more setup).";

export const GMAIL_GUIDE: Guide = {
  title: "Gmail with an app password",
  steps: [
    "Turn on 2-Step Verification for your Google account (Google Account, Security). App passwords need it.",
    "In the same Security area, open App passwords, create one named LLM-IDE and copy the 16-character password Google shows once.",
    "Enter your Gmail address and paste the app password below, then press Save and Fetch.",
  ],
};

export const GMAIL_NOTES: readonly string[] = [
  "Some Google Workspace (work or school) administrators turn app passwords off. If you cannot see App passwords, ask your administrator or use the Advanced section.",
  "Mail is read over IMAP and saved as notes under source/emails, forward-only: only mail that arrives after you connect (use Start from now) or within the look-back window is imported.",
  "The app password is stored write-only in the core's encrypted vault and is never shown again. It is a long-lived password for your whole mailbox: delete it in your Google account if you stop using this.",
];

/** Where the user finds the page; shown as text. The button opens only Google's account home, after host validation. */
export const GMAIL_WHERE = "Google Account, Security, 2-Step Verification, App passwords";
export const GOOGLE_ACCOUNT_HOME = "https://myaccount.google.com/";

export const ICAL_GUIDE: Guide = {
  title: "Calendar with the secret iCal address",
  steps: [
    "In Google Calendar on the web, open Settings (the gear) and choose your calendar under Settings for my calendars.",
    "Open Integrate calendar and copy the Secret address in iCal format (it ends in basic.ics).",
    "Give the calendar a name, paste the address below and press Add calendar, then press Sync. You can add up to 10 calendars.",
  ],
};

export const ICAL_NOTES: readonly string[] = [
  "Read-only: the address can only be used to read the calendar, never to change it.",
  "Anyone who has the address can read the whole calendar. Treat it like a password: it is stored write-only in the core's vault, never shown again (only the first characters of the calendar id are), and you can make it useless by resetting the secret address in Google Calendar.",
  "The core downloads the calendar itself and indexes its events (only the window of days you choose) for search in the Library; this window writes no files. Changes appear when you press Sync (Google may delay a feed by some hours; unverified).",
];

export const DRIVE_GUIDE: Guide = {
  title: "Drive with Drive for desktop",
  steps: [
    "Install Google Drive for desktop from Google and sign in. Your Drive appears as a folder on this computer (on a Mac usually under Library, CloudStorage, GoogleDrive-your address).",
    "Choose that folder (or one folder inside it) below. LLM-IDE adds it to your approved folders and indexes its files, the same way it does for a code folder.",
    "Press Index whenever you want it refreshed.",
  ],
};

export const DRIVE_NOTES: readonly string[] = [
  "No Google sign-in is involved: LLM-IDE only reads files on this computer.",
  "Google Docs, Sheets and Slides appear locally as small link files, so only their link is indexed, not their text. Files that Drive for desktop has downloaded are indexed; online-only files may not be (unverified: depends on your Drive for desktop settings).",
  "The folder stays in your Drive: nothing is copied or changed. Remove it from the list to stop indexing.",
];

export const ADVANCED_SUMMARY = "Advanced: connect with your own Google Cloud client (Gmail, Calendar and Drive over OAuth)";

// ---- gmail app password ----------------------------------------------------------------------

export interface GmailEasyForm {
  address: string;
}

const ADDRESS_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,24}$/;

export function validateGmailAddress(address: string): string | null {
  const a = address.trim();
  if (a === "") return "Enter your Gmail address.";
  if (!ADDRESS_RE.test(a)) return "That does not look like an email address.";
  if (!/@(gmail|googlemail)\.com$/i.test(a)) return "This card is for Gmail (@gmail.com). For a work or school address, ask your administrator whether app passwords are allowed, or use Advanced.";
  return null;
}

/** App passwords are shown as 16 letters in four groups; spaces are cosmetic. The core stores what we send, so strip them. */
export function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function appPasswordProblem(raw: string): string | null {
  const p = normalizeAppPassword(raw);
  if (p === "") return null;
  if (!/^[A-Za-z]{16}$/.test(p)) return "A Google app password is 16 letters (Google shows it in four groups of four). Copy it again.";
  return null;
}

/** The https address the "open Google account" button may open: Google's account home only. */
export function isGoogleAccountHome(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "myaccount.google.com" && u.port === "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

// ---- drive for desktop folder ----------------------------------------------------------------

export type DriveFolderKind = "drive_for_desktop" | "other" | "refused";

/**
 * Classifies a folder the user picked. `drive_for_desktop` for the usual locations (macOS CloudStorage/GoogleDrive-*,
 * the older "Google Drive" folder, Windows G:\\ style is not guessed); `refused` for something that is plainly not a
 * folder to index (empty, relative, or a filesystem root or a home directory); `other` is allowed after the user
 * confirms it is their Drive folder.
 */
export function classifyDriveFolder(path: string): DriveFolderKind {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === "" || !(p.startsWith("/") || /^[A-Za-z]:\//.test(p)) || /(^|\/)\.\.(\/|$)/.test(p)) return "refused";
  if (/^\/(Users|home)\/[^/]+$/.test(p) || /^[A-Za-z]:\/?$/.test(p) || p === "/Users" || p === "/home") return "refused";
  if (/\/Library\/CloudStorage\/GoogleDrive-[^/]+(\/|$)/.test(p) || /\/Google ?Drive(\/|$)/i.test(p) || /\/CloudStorage\/GoogleDrive/.test(p)) return "drive_for_desktop";
  return "other";
}

export function driveFolderLabel(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const m = /\/GoogleDrive-([^/]+)(?:\/(.*))?$/.exec(p);
  if (m) return `Google Drive (${m[1]})${m[2] ? ` / ${m[2]}` : ""}`.slice(0, 120);
  return (p.slice(p.lastIndexOf("/") + 1) || p).slice(0, 120);
}

export type DriveCardState = "no_picker" | "no_folder" | "needs_confirm" | "ready" | "refused";

export function driveCardState(picked: { path: string } | null, hasPicker: boolean, confirmed: boolean): DriveCardState {
  if (!hasPicker) return "no_picker";
  if (!picked) return "no_folder";
  const k = classifyDriveFolder(picked.path);
  if (k === "refused") return "refused";
  if (k === "other" && !confirmed) return "needs_confirm";
  return "ready";
}

/** Approved folders that look like a Drive for desktop folder (the Drive card lists only these). */
export function driveFolders<T extends { path: string }>(repos: readonly T[]): T[] {
  return repos.filter((r) => classifyDriveFolder(r.path) === "drive_for_desktop");
}
