// The Graph section's System page: graph-kit's Agentic OS view, mounted as a React screen (the Mac hosts the same
// page in a WKWebView). Every server call goes through the shell's authenticated core client; project files and
// the graph go through the host commands, so the page never holds a token or a raw path.
import { useEffect, useRef, type ReactNode } from "react";
import { mountOsView, type OsFileContent, type OsViewHandle } from "@dnsmalla/graph-kit-web";
import { invokeHost, shellBus, subscribeTheme, getTheme } from "@llmide/screens/shell";
import { core } from "../shell/runtime";
import { createSystemHost, sectionForTarget, type SystemReply } from "./system-host";

export interface SystemPageProps {
  /** The Graph section is visible; hidden sections unmount the page so its feed stops. */
  active: boolean;
  projectRoot: string | null;
  /** The page asked for the code graph: switch the Graph section to its Code graph page. */
  onOpenCodeGraph: () => void;
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export default function SystemPage({ active, projectRoot, onOpenCodeGraph }: SystemPageProps): ReactNode {
  const hostEl = useRef<HTMLDivElement>(null);
  const view = useRef<OsViewHandle | null>(null);
  const rootRef = useRef(projectRoot);
  rootRef.current = projectRoot;
  const openCodeRef = useRef(onOpenCodeGraph);
  openCodeRef.current = onOpenCodeGraph;

  useEffect(() => {
    const el = hostEl.current;
    if (!el || !active) return undefined;
    const host = createSystemHost({
      async request(method, path, body): Promise<SystemReply> {
        const r = await core.requestRaw(path, { method, body });
        return { status: r.status, body: r.body };
      },
      watch(onChange, onStatus) {
        const ctl = new AbortController();
        let stopped = false;
        void (async () => {
          onStatus("connecting");
          while (!stopped) {
            try {
              let first = true;
              for await (const ev of core.stream("/kb/os/stream", { signal: ctl.signal })) {
                if (stopped) break;
                onStatus("live");
                if (!first || ev.event !== "hello") onChange();
                first = false;
              }
              if (!stopped) {
                onStatus("reconnecting");
                await new Promise((r) => setTimeout(r, 2000));
              }
            } catch {
              if (stopped) break;
              onStatus("reconnecting");
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
          if (!stopped) onStatus("stopped");
        })();
        return () => {
          stopped = true;
          ctl.abort();
        };
      },
      openSection(target) {
        if (target === "codeGraph") {
          openCodeRef.current();
          return true;
        }
        const section = sectionForTarget(target);
        if (!section) return false;
        shellBus.publish({ type: "goto-section", section });
        return true;
      },
      openFile(path, line) {
        shellBus.publish(line === undefined ? { type: "open-file", path } : { type: "open-file", path, line });
        return true;
      },
      async projectGraph() {
        try {
          const mem = await invokeHost<unknown>("project_memory");
          const o = mem && typeof mem === "object" ? (mem as Record<string, unknown>) : {};
          const g = o.graph && typeof o.graph === "object" ? (o.graph as Record<string, unknown>) : null;
          const path = g && typeof g.path === "string" ? g.path : null;
          if (!path) return null;
          const text = await invokeHost<unknown>("read_graph_file", { path });
          if (typeof text !== "string") return null;
          return JSON.parse(text);
        } catch {
          return null;
        }
      },
      async loadFile(path: string): Promise<OsFileContent | null> {
        try {
          const raw = await invokeHost<unknown>("fs_read_file", { req: { path, max_bytes: 2_000_000 } });
          const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          if (r.status !== "ok" || typeof r.text !== "string") {
            return typeof r.size === "number" ? { path, binary: true, bytes: r.size } : null;
          }
          return { path, text: r.text, bytes: typeof r.size === "number" ? r.size : r.text.length, truncated: r.truncated === true, language: null };
        } catch {
          return null;
        }
      },
    });
    const h = mountOsView(el, host, { theme: getTheme(), projectName: projectRoot ? baseName(projectRoot) : null });
    view.current = h;
    const off = subscribeTheme(() => h.configure({ theme: getTheme() }));
    return () => {
      off();
      h.dispose();
      view.current = null;
    };
    // Remounted when the section becomes visible; project/theme changes go through configure / the refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    view.current?.configure({ projectName: projectRoot ? baseName(projectRoot) : null });
  }, [projectRoot]);

  return <div className="gr-system" ref={hostEl} data-page="system" data-active={active} />;
}
