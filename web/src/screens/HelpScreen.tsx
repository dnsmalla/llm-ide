// Settings > Help (#/settings/help): the web twin of the iPhone app's Help & FAQ.
import { Button, Card, SectionHeader, UiIcon } from "../ui/index.ts";
import type { ShellContext } from "../shell/registry.ts";

const FEATURES: ReadonlyArray<readonly [string, string]> = [
  ["Ask", "Questions about your project, answered on your desktop. Read-only: it never edits a file or runs a command from here."],
  ["Execute", "A second chat for code changes. The desktop edits the project and asks before each edit or command; you approve or deny each step."],
  ["Auto Tasks", "The tasks your desktop plans. See their status and start one from this browser."],
  ["Loop", "Start a loop on an issue, follow its progress, and cancel it, even when you are away from the desk."],
  ["History", "The desktop's chats and usage, read-only."],
];

export function HelpScreen({ ctx }: { ctx: ShellContext }) {
  return (
    <div className="web-page web-help">
      <div><Button variant="ghost" icon="chevron-left" onClick={() => ctx.navigate("settings")}>Settings</Button></div>
      <SectionHeader title="Help &amp; FAQ" description="Get help with LLM-IDE" />
      <Card title="What each section does">
        <ul>{FEATURES.map(([name, text]) => <li key={name}><strong>{name}.</strong> {text}</li>)}</ul>
      </Card>
      <Card title="Pair with your desktop">
        <ol>
          <li>On the desktop: Settings &rarr; Host API pairing &rarr; Show pairing PIN (or its QR code).</li>
          <li>Here, enter the desktop&apos;s address and the PIN, or scan the QR.</li>
          <li>When the status shows Live, use Ask. Execute appears when the desktop lets paired devices answer tool approvals; turn that on, then pair again.</li>
        </ol>
      </Card>
      <Card title="Offline sync">
        <p>With sync linked, this browser reads the desktop&apos;s last encrypted snapshot (chats, meetings, plans, usage) while the desktop is off, and queues prompts that run, read-only, when it is back. On the desktop: Settings &rarr; sync &rarr; Add a phone or browser &rarr; Browser, then open the link here. The storage password is asked once per session and never kept.</p>
      </Card>
      <Card title="Can&apos;t connect?">
        <ul>
          <li><strong>Origin not allowed.</strong> Add this page&apos;s address ({globalThis.location?.origin ?? "this page"}) to the desktop&apos;s allowed web origins, then retry.</li>
          <li><strong>Certificate.</strong> Open the desktop&apos;s address in this browser once and trust its certificate, then come back. A changed certificate means pairing again.</li>
          <li><strong>Desktop asleep or closed.</strong> LLM-IDE must be running on the same network (or Tailscale). Use the offline copy if sync is linked.</li>
          <li><strong>&ldquo;Removed on the host&rdquo;.</strong> This browser was unpaired on the desktop. Pair again with a new PIN.</li>
        </ul>
      </Card>
      <p className="ui-hint"><UiIcon name="info" size={14} /> Still stuck? The full guide and support are linked in Settings &rarr; Help.</p>
    </div>
  );
}
