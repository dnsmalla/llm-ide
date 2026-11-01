// Clears this device's local UI settings on "Sign out and forget". It never reads or writes a token; the auth
// token lives in memory, and project files/notes are untouched.
export function forgetLocalSettings(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("llmide.")) localStorage.removeItem(key);
    sessionStorage.clear();
  } catch {
    // storage unavailable: the sign-out still proceeds
  }
}
