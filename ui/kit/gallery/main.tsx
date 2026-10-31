// Component gallery: every kit component in its states, with a theme switcher.
// Build: `npm run gallery` (ui/kit), open gallery/dist/index.html. Not shipped.
import { createRoot } from "react-dom/client";
import { useState, type ReactNode } from "react";
import {
  THEMES, applyTheme, isThemeId, type ThemeId,
  Chip, EditorTabBar, FileTreeRow, ResizableDivider, SectionChromeBar, SettingsSectionCard,
  StatusBanner, LibrarySidebar, SelectItemEmpty, Icon, GraphIcon, BellIcon,
} from "../src/index";
import { ICON_NODES, type IconName } from "../src/icons.generated";
import "../src/styles/kit.css";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: "var(--tok-space-xl)" }}>
      <h2 style={{ fontSize: "var(--tok-type-title-size)", fontWeight: "var(--tok-type-title-weight)" }}>{title}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--tok-space-md)", alignItems: "flex-start" }}>{children}</div>
    </section>
  );
}

function Gallery() {
  const initial = new URLSearchParams(location.search).get("theme");
  const [theme, setTheme] = useState<ThemeId>(isThemeId(initial) ? initial : "dark");
  const [tab, setTab] = useState("a.ts");
  const [width, setWidth] = useState(280);
  const [pressed, setPressed] = useState(true);
  applyTheme(theme);

  return (
    <main style={{ padding: "var(--tok-space-xl)", minHeight: "100vh", background: "var(--tok-color-body)", color: "var(--tok-color-text)", fontFamily: "var(--tok-type-sans-family)", fontSize: "var(--tok-type-body-size)" }}>
      <div role="radiogroup" aria-label="Theme" style={{ display: "flex", gap: "var(--tok-space-sm)", marginBottom: "var(--tok-space-xl)" }}>
        {THEMES.map((t) => (
          <Chip key={t.id} label={t.label} active={t.id === theme} onClick={() => setTheme(t.id)} />
        ))}
      </div>
      <Section title="Status banner">
        <StatusBanner severity="error" message="Something failed." onDismiss={() => {}} />
        <StatusBanner severity="warning" message="Careful." />
        <StatusBanner severity="info" message="For your information." />
      </Section>
      <Section title="Chip">
        <Chip label="Plain" />
        <Chip label="Toggle" active={pressed} onClick={() => setPressed(!pressed)} icon={<GraphIcon />} />
        <Chip label="Compact" compact />
      </Section>
      <Section title="Editor tab bar">
        <EditorTabBar tabs={[{ id: "a.ts", label: "a.ts", dirty: true }, { id: "b.ts", label: "b.ts" }]} activeId={tab} onSelect={setTab} onClose={() => {}} />
      </Section>
      <Section title="Section chrome bar">
        <div style={{ width: 360 }}>
          <SectionChromeBar title="Files" toggles={[{ id: "t", icon: <BellIcon />, isOn: pressed, helpOn: "Hide", helpOff: "Show", onToggle: () => setPressed(!pressed) }]} />
        </div>
      </Section>
      <Section title="Settings section card">
        <div style={{ width: 360 }}>
          <SettingsSectionCard icon={<BellIcon />} title="Notifications" defaultExpanded>Card body</SettingsSectionCard>
        </div>
      </Section>
      <Section title="Resizable divider (drag or use arrow keys)">
        <div style={{ display: "flex", height: 60, width: 520, border: "1px solid var(--tok-color-border)" }}>
          <div style={{ width, background: "var(--tok-color-surface)", padding: 8 }}>{width}px</div>
          <ResizableDivider width={width} onWidthChange={setWidth} label="Resize gallery column" />
        </div>
      </Section>
      <Section title="File tree row">
        <div role="tree" style={{ width: 280 }}>
          <FileTreeRow name="src" isFolder isExpanded depth={0} selected={false} onClick={() => {}} onToggle={() => {}} />
          <FileTreeRow name="main.ts" isFolder={false} depth={1} selected gitStatus="modified" onClick={() => {}} />
        </div>
      </Section>
      <Section title="Library sidebar and empty state">
        <div style={{ width: 368 }}><LibrarySidebar /></div>
        <div style={{ width: 360 }}><SelectItemEmpty /></div>
      </Section>
      <Section title={`Icons (Lucide, ${Object.keys(ICON_NODES).length})`}>
        {(Object.keys(ICON_NODES) as IconName[]).map((n) => (
          <span key={n} title={n} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4, width: 84, fontSize: "var(--tok-type-caption-size)" }}>
            <Icon name={n} size={20} />
            {n}
          </span>
        ))}
      </Section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
