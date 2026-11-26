// The SSH link wording shared by the shell status and the settings/welcome screens. Pure, so node tests import it.

export type SshLinkTone = "ok" | "busy" | "warn" | "error" | "off";

/**
 * The state label and tone for an SSH link, the one wording the toolbar status, the status view and the server
 * home header share. A missing or unlisted link reads as "off"; `stopped` is left to the caller (it reuses the core's text).
 */
export function sshLinkPresentation(link: string | null): { tone: SshLinkTone; text: string } {
  switch (link) {
    case "connected": return { tone: "ok", text: "SSH server connected" };
    case "connecting": return { tone: "busy", text: "Connecting to the SSH server…" };
    case "reconnecting": return { tone: "warn", text: "Reconnecting to the SSH server…" };
    case "needs_password": return { tone: "warn", text: "Enter the server password to connect" };
    case "failed": return { tone: "error", text: "SSH server unreachable" };
    default: return { tone: "off", text: "Not connected to the SSH server" };
  }
}
