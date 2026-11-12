import { hubCopy } from "../hub-copy.ts";
import type { ShellContext } from "../shell/registry.ts";
import { Badge, Button, Card, ListRow, RowList, SegmentedControl, THEME_OPTIONS, UiIcon, useThemePref, type ThemePref, type UiIconName } from "../ui/index.ts";
import { ChangeAddress } from "./ChangeAddress.tsx";
import { PushToggle } from "./PushToggle.tsx";
import { HelpScreen } from "./HelpScreen.tsx";
import { useRoute } from "../shell/hash.ts";

const THEME_ICON: Record<ThemePref, UiIconName> = { system: "monitor", dark: "moon", light: "sun", midnight: "moon" };
const HELP = "https://llm-ide.com/guide.html";

export function SettingsScreen({ ctx }: { ctx: ShellContext }) {
  const [theme, setTheme] = useThemePref();
  const { actions: a } = ctx;
  const hubNote = ctx.hub ? hubCopy({ hostKind: "hub" }) : null;
  const online = ctx.conn.kind === "ready";
  const route = useRoute();
  if (route.sub === "help") return <HelpScreen ctx={ctx} />; // #/settings/help
  return (
    <div className="web-page web-settings">
      <Card title="Appearance" description="Follows your device unless you pick a theme.">
        <SegmentedControl label="Theme" value={theme} onChange={setTheme} block
          options={THEME_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: THEME_ICON[o.value] }))} />
      </Card>

      <PushCard ctx={ctx} />

      <Card title={ctx.hub ? "Hub" : "Desktop"} description={ctx.hostName} action={<Badge tone={online ? "success" : "warning"} dot>{online ? "Connected" : "Not connected"}</Badge>}>
        <dl className="web-kv"><dt>Address</dt><dd><code>{ctx.hostUrl}</code></dd></dl>
        <div className="web-row-actions">
          <ChangeAddress onSubmit={a.changeAddress} />
          <Button variant="danger" icon="trash" onClick={a.forget}>Forget this desktop</Button>
        </div>
        <p className="ui-hint">Forgetting removes this browser's access. You pair again with a new PIN from the desktop's Settings.</p>
      </Card>

      <Card title="Offline and sources" flush>
        {hubNote && <p className="web-card-note">{hubNote}</p>}
        <RowList>
          {!ctx.hub && (
            <li>{ctx.offlineLinked && a.openOffline
              ? <ListRow icon="hard-drive" title="Offline copy" subtitle="Read the desktop's last snapshot and queue prompts while it is off." chevron onClick={a.openOffline} />
              : <ListRow icon="hard-drive" title="Offline copy" subtitle="Not linked. On the desktop: Settings → sync → Add a phone or browser → Browser, then open the link here." trailing={<Badge>Not linked</Badge>} />}</li>
          )}
          <li><ListRow icon="folder" title="Documents and code" subtitle="Read Box documents and GitLab code directly, read-only." chevron onClick={a.openSources} /></li>
        </RowList>
      </Card>

      <Card title="Help" flush>
        <RowList>
          <li><ListRow icon="circle-help" title="Help & FAQ" subtitle="What each section does, pairing, offline sync, troubleshooting" chevron onClick={() => ctx.navigate("settings", "help")} /></li>
          <li><ListRow icon="file-text" title="Guide" subtitle="How pairing, sync and approvals work" href={HELP} external /></li>
          <li><ListRow icon="info" title="Support" href="/app/support" /></li>
          <li><ListRow icon="shield-check" title="Privacy policy" href="/app/privacy" /></li>
        </RowList>
      </Card>

      <p className="web-version"><UiIcon name="info" size={14} /> LLM-IDE web {__APP_VERSION__}</p>
    </div>
  );
}

function PushCard({ ctx }: { ctx: ShellContext }) {
  if (ctx.push.kind === "unavailable") return null;
  return (
    <Card title="Notifications" description="Get a ping on this device when the desktop needs you or finishes work.">
      <PushToggle state={ctx.push} onEnable={ctx.actions.enablePush} onDisable={ctx.actions.disablePush} />
    </Card>
  );
}
