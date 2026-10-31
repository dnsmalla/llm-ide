// Words and constants of the Google connection pane, kept in one file so the claims (what is read, what is
// stored, what Google rules are unverified) are reviewed together and match docs/spec/google-connectors.md
// (the setup guide text lives here, there is no separate page).

const A = "https://www.googleapis.com/auth/";

/** The scopes the core requests, per product (its registry is `extension/connectors/google/google-scopes.mjs`).
 *  All read-only. Shown to the user so the Google consent screen can be checked against this list. */
export const SCOPE_GROUPS: readonly { product: string; scopes: readonly string[]; tier: string }[] = [
  { product: "Sign-in identity (always)", scopes: ["openid", "email"], tier: "basic: your address only" },
  { product: "Gmail", scopes: [`${A}gmail.readonly`], tier: "restricted" },
  { product: "Google Calendar", scopes: [`${A}calendar.events.readonly`, `${A}calendar.calendarlist.readonly`], tier: "sensitive" },
  { product: "Google Drive (names, types, dates)", scopes: [`${A}drive.metadata.readonly`], tier: "restricted" },
  { product: "Google Drive (file contents, only if you tick it)", scopes: [`${A}drive.readonly`], tier: "restricted" },
];

export const TIER_NOTE = "The tier labels (basic, sensitive, restricted) come from third-party summaries of Google's rules and are unverified; check them on your own consent screen.";

export const GOOGLE_INTRO =
  "Reads your Gmail, Calendar and Drive into the Library, read-only. This Google account is used for these connectors only: it is not how you sign in to LLM-IDE and it is not a model provider. The Google sign-in happens in your system browser; the core keeps the long-lived credential in its encrypted vault and this window never sees a token.";

export const BRING_YOUR_OWN =
  "You bring your own Google Cloud OAuth client (type Desktop app). There is no shared client, so nobody else's data or quota is involved, and Google's review of the app is not needed for your own account (unverified).";

export interface GuideStep {
  title: string;
  body: string;
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  { title: "Create a Google Cloud project", body: "Open console.cloud.google.com, create a project (any name), and select it." },
  { title: "Turn on the APIs you want", body: "In APIs and Services, Library, enable the Gmail API, the Google Calendar API and the Google Drive API (only the ones you will use)." },
  { title: "Set up the consent screen", body: "In APIs and Services, OAuth consent screen: choose External, keep the publishing status on Testing, and add your own Google address under Test users." },
  { title: "Add the scopes", body: "On the consent screen's Scopes step, add the read-only scopes listed below for the products you want. Nothing here can change or delete anything in your account." },
  { title: "Create the OAuth client", body: "In Credentials, Create credentials, OAuth client ID, Application type: Desktop app. Copy the client ID and the client secret. A Desktop client needs no redirect address registered: the core uses a temporary loopback address on this computer for the few seconds the sign-in takes." },
  { title: "Paste them below and connect", body: "Paste the client ID and secret into the fields below (the secret is sent once to the core's vault and never shown again), tick the products, and press Connect. Your browser opens Google; check that the access it lists matches the scopes below." },
];

export const TESTING_EXPIRY_NOTE =
  "While the project is in Testing mode, Google may expire the saved sign-in after about 7 days; the connection then shows Reconnect needed and you connect again (unverified: from third-party summaries, check your own console). Moving the project to In production removes that expiry but shows an unverified-app warning and caps users at 100 (also unverified).";

export const WHERE_NOTES_GO =
  "Gmail threads are saved as note files in your notes folder under source/gmail, one file per thread. They carry untrusted: true in their header because anyone can send you text. The notes folder is chosen in Settings (Workspace); until one is chosen nothing can be saved. Calendar and Drive are indexed for search and do not create note files.";

export const NOTE_UPDATE_RULE =
  "Fetching never overwrites a note. A thread that gained replies is saved as a new note next to the old one; a thread deleted in Gmail gets one line appended to its note.";

export const DRIVE_CONTENT_EXPLAIN =
  "Off: Drive is indexed by names, types, dates and folder only (scope drive.metadata.readonly). On: the core may also read the text of Docs, Sheets, Slides and plain text files, but only in the folders you tick (scope drive.readonly, which can read every file in your Drive). Turning it on later means connecting again to grant the wider scope.";

export const DISCONNECT_EXPLAIN =
  "Disconnect asks Google to revoke the saved sign-in, deletes the stored client, sign-in and sync positions from the core, and removes the Calendar and Drive search entries for this account. Gmail notes already in your notes folder stay. If Google could not be reached the local data is still deleted, but the app stays listed until you also remove it at myaccount.google.com/permissions.";

export const PERMISSIONS_URL = "https://myaccount.google.com/permissions";

export const SECURITY_POINTS: readonly string[] = [
  "Read-only scopes only; there is no way to send, delete or edit mail, events or files.",
  "The client secret is sent once to the core and is not kept in this window; no token ever reaches this window.",
  "Mail text, subjects, labels, calendar names and file names are shown as plain text; remote images and links in mail are never loaded.",
  "The core only talks to Google's own hosts and never fetches a link found inside a message or document.",
];
