import { lazy, useEffect, useState } from "react";
import { Shell } from "@llmide/screens/shell/Shell";
import { launchSection, type SectionId } from "@llmide/screens/shell/sections";
import { invokeHost } from "@llmide/screens/shell/host";
import { isThemeId, type ThemeId } from "@llmide/ui-kit";

// The Phase 0 spike views, behind the shell's "Spike" route. Lazy: monaco, sigma and xterm load only when opened.
const SpikeHost = lazy(() => import("./spike/SpikeHost"));

interface Launch {
  section: SectionId | null;
  theme: ThemeId | null;
}

/**
 * Launch overrides from the host (screenshot and autobench tooling). The host commands are Rust
 * (the webview never reads env); outside Tauri they are absent and the defaults apply.
 */
async function readLaunch(): Promise<Launch> {
  const ask = (cmd: string) => invokeHost<string | null>(cmd).catch(() => null);
  const [autobench, section, theme] = await Promise.all([ask("autobench_mode"), ask("section_override"), ask("theme_override")]);
  const spiky = autobench !== null || (section !== null && launchSection(null, section) === "spike");
  return {
    section: spiky || section ? launchSection(autobench, section) : null,
    theme: isThemeId(theme) ? theme : null,
  };
}

export function App() {
  const [launch, setLaunch] = useState<Launch | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readLaunch().then((l) => {
      if (!cancelled) setLaunch(l);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A few milliseconds for the host overrides; never an empty window.
  if (!launch) return <div className="sh-splash" role="status">Starting LLM-IDE…</div>;
  return <Shell initialSection={launch.section} themeOverride={launch.theme} spike={SpikeHost} />;
}
