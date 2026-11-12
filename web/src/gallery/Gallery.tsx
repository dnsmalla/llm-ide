// Dev-only screen gallery: `#/__gallery/<screen>?theme=light|dark|midnight&w=<px>`. `w` renders the screen in an iframe of that
// width so the real media queries apply. Loaded only through a dynamic import behind import.meta.env.DEV (main.tsx).
import { useLayoutEffect, useState, type ReactNode } from "react";
import { THEMES } from "@llmide/ui-kit";
import { ScanView } from "../pairing/Scanner.tsx";
import { PairingScreen } from "../screens/PairingScreen.tsx";
import { HelpScreen } from "../screens/HelpScreen.tsx";
import { SourcesScreen } from "../screens/SourcesScreen.tsx";
import { SyncTier } from "../screens/SyncTier.tsx";
import { TASKS_LOOP_SCREENS } from "./tasks-loop-fixtures.tsx";
import { useRoute } from "../shell/hash.ts";
import { Shell } from "../shell/Shell.tsx";
import { Badge, Banner, Button, Card, EmptyState, IconButton, ListRow, RowList, SectionHeader, SegmentedControl, Sheet, Skeleton, Spinner, StatusPill, TextArea, TextField, ToastHost, toast, previewTheme } from "../ui/index.ts";
import { CHAT_EMPTY, CHAT_HISTORY, CHAT_STREAMING, CHAT_TOOL, CHAT_WAITING, SOURCES_BROWSE, SOURCES_HOME, SYNC_LOCKED, SYNC_READY, CAPS_NO_APPROVALS, executeSlice, shellContext } from "./fixtures.ts";

const noop = () => undefined;
const proxy = new Proxy({}, { get: () => noop }) as never;

function Components() {
  const [seg, setSeg] = useState("a");
  const [open, setOpen] = useState(false);
  return (
    <div className="web-page">
      <Card title="Buttons" description="primary, secondary, ghost, danger; sm, md, lg; loading">
        <div className="web-row-actions"><Button variant="primary">Primary</Button><Button>Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Danger</Button><Button variant="primary" loading>Loading</Button><Button disabled>Disabled</Button></div>
        <div className="web-row-actions"><Button size="sm" icon="plus">Small</Button><Button size="lg" variant="primary">Large</Button><IconButton icon="search" label="Search" /><IconButton icon="bell" label="Notify" variant="filled" /></div>
      </Card>
      <Card title="Status"><div className="web-row-actions"><StatusPill status="live" /><StatusPill status="reconnecting" /><StatusPill status="waiting" /><StatusPill status="offline" /><Badge tone="success">ok</Badge><Badge tone="warning">warn</Badge><Badge tone="danger">danger</Badge><Badge tone="accent">accent</Badge></div></Card>
      <Banner tone="info" title="Info">Something worth knowing.</Banner>
      <Banner tone="warn" action={<Button size="sm">Fix it</Button>}>Heads up, with an action.</Banner>
      <Banner tone="error">Something went wrong.</Banner>
      <Card title="Fields"><TextField label="Address" hint="A hint" placeholder="wss://…" /><TextField label="PIN" error="The pairing PIN is six digits." defaultValue="12" /><TextArea label="Prompt" autoGrow defaultValue="Auto-grows" /></Card>
      <Card title="Controls"><SegmentedControl label="Demo" value={seg} onChange={setSeg} options={[{ value: "a", label: "One" }, { value: "b", label: "Two" }, { value: "c", label: "Three" }]} />
        <div className="web-row-actions"><Button onClick={() => setOpen(true)}>Open sheet</Button><Button onClick={() => toast.show("Saved", "success")}>Toast</Button><Spinner /><Skeleton width={120} /></div></Card>
      <Card title="List" flush><RowList><li><ListRow icon="folder" title="Documents" subtitle="Subtitle" chevron onClick={noop} /></li><li><ListRow icon="hard-drive" title="Offline copy" trailing={<Badge>Off</Badge>} /></li></RowList></Card>
      <Card><SectionHeader title="Empty state" /><EmptyState icon="list-checks" title="Nothing yet" action={<Button variant="primary">Do something</Button>}>A short explanation of what will appear here.</EmptyState></Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="Sheet" footer={<Button variant="primary" onClick={() => setOpen(false)}>Done</Button>}><p>Focus is trapped; Esc closes.</p><TextField label="Name" /></Sheet>
    </div>
  );
}

type Render = () => ReactNode;
const shell = (section: string, chat = CHAT_EMPTY, o = {}): Render => () => <Shell ctx={shellContext(chat, o)} forceSection={section} />;
const SCREENS: Record<string, Render> = {
  "pairing": () => <PairingScreen initialUrl="wss://192.168.1.20:3016/host-api/v1" busy={false} error={null} revokedNotice={null} onSubmit={noop} />,
  "pairing-error": () => <PairingScreen initialUrl="wss://192.168.1.20:3016/host-api/v1" busy={false} error="Wrong or expired PIN. Show a new one in the desktop app's Settings." revokedNotice="The desktop removed or expired this browser's access. Pair again with a new PIN from the desktop app's Settings." onSubmit={noop} />,
  "pairing-scan": () => <Sheet open onClose={noop} title="Scan the pairing QR"><ScanView mode="scanning" notice={null} problem={null} canDecodePhoto onPhoto={noop} onPaste={noop} /></Sheet>,
  "pairing-scan-unsupported": () => <Sheet open onClose={noop} title="Scan the pairing QR"><ScanView mode="unavailable" notice="This browser cannot read QR codes from the camera." problem={null} canDecodePhoto={false} onPhoto={noop} onPaste={noop} /></Sheet>,
  "chat-empty": shell("ask"),
  "chat-history": shell("ask", CHAT_HISTORY),
  "chat-streaming": shell("ask", CHAT_STREAMING),
  "chat-approval": shell("ask", CHAT_TOOL),
  "chat-waiting": shell("ask", CHAT_WAITING, { conn: { kind: "reconnecting", attempt: 1, inMs: 2000, unopened: 0 } }),
  "chat-unreachable": shell("ask", CHAT_EMPTY, { conn: { kind: "reconnecting", attempt: 6, inMs: 8000, unopened: 4 } }),
  "history": shell("history"),
  "settings": shell("settings"),
  "execute-empty": shell("execute", CHAT_EMPTY, { execute: executeSlice(CHAT_EMPTY) }),
  "execute-approval": shell("execute", CHAT_EMPTY, { execute: executeSlice(CHAT_TOOL) }),
  "execute-unavailable": shell("execute", CHAT_EMPTY, { capabilities: CAPS_NO_APPROVALS, execute: executeSlice(CHAT_EMPTY) }),
  "help": () => <HelpScreen ctx={shellContext(CHAT_EMPTY)} />,
  ...TASKS_LOOP_SCREENS,
  "sync": () => <SyncTier state={SYNC_READY} sync={proxy} hostPaired onSources={noop} onHost={noop} />,
  "sync-locked": () => <SyncTier state={SYNC_LOCKED} sync={proxy} hostPaired onHost={noop} />,
  "sources": () => <SourcesScreen state={SOURCES_HOME} sources={proxy} onBack={noop} />,
  "sources-browse": () => <SourcesScreen state={SOURCES_BROWSE} sources={proxy} onBack={noop} />,
  "components": () => <Components />,
};

export function GalleryApp() {
  const r = useRoute();
  const screen = r.sub;
  const theme = r.params.get("theme");
  const w = Number(r.params.get("w")) || 0;
  const framed = r.params.get("frame") === "1";
  useLayoutEffect(() => { const t = THEMES.find((x) => x.id === theme); if (t) previewTheme(t.id); }, [theme]);
  if (!screen || !SCREENS[screen]) {
    return (
      <main className="web-page"><h1>Screen gallery (dev only)</h1>
        <ul>{Object.keys(SCREENS).map((k) => <li key={k}>{k}: {THEMES.map((t) => <a key={t.id} href={`#/__gallery/${k}?theme=${t.id}`}>{t.id} </a>)}<a href={`#/__gallery/${k}?theme=dark&w=360`}>360px</a></li>)}</ul></main>
    );
  }
  if (w && !framed) {
    const src = `${location.pathname}#/__gallery/${screen}?theme=${theme ?? "dark"}&frame=1`;
    return <div style={{ display: "grid", justifyItems: "center", padding: 12, minHeight: "100vh", background: "#888" }}><iframe title={screen} src={src} style={{ width: w, height: "calc(100vh - 24px)", border: 0, background: "#fff" }} /></div>;
  }
  return <>{SCREENS[screen]!()}<ToastHost /></>;
}
