import { clearRepoConfigHostFile } from "../settings/repo-config.ts";

// Clears this device's local UI settings on "Sign out and forget". It never reads or writes a token; the auth
// token lives in memory, and project files/notes are untouched. The saved repository list also lives in a host
// file, so that copy is emptied too; otherwise the next start would bring the forgotten list back.
export function forgetLocalSettings(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("llmide.")) localStorage.removeItem(key);
    sessionStorage.clear();
  } catch {
    // storage unavailable: the sign-out still proceeds
  }
  clearRepoConfigHostFile();
}
