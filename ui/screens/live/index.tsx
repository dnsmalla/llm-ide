import "./live.css";
import { useMemo } from "react";
import { core as shellCore, shellBus, type SectionProps } from "@llmide/screens/shell";
import { createCaptureHost } from "./host.ts";
import { LiveScreen, type LiveDeps } from "./LiveScreen.tsx";
import { setLiveRecording } from "../shell/live-status.ts";
export default function Live({ active }: SectionProps) {
  const deps = useMemo<LiveDeps>(() => ({ capture: createCaptureHost(), language: () => (globalThis.navigator?.language ?? "en").split("-")[0]!.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 35) || "en", openLibrary: () => shellBus.publish({ type: "goto-section", section: "library" }), onRecordingChange: setLiveRecording,
    onToggleRequest: (run) => {
      if (shellBus.takePending("live-capture")) run();
      return shellBus.subscribe("live-capture", () => { shellBus.takePending("live-capture"); run(); });
    },
    indexNote: async (note) => {
      if (!note.index) return "skipped";
      try { const r = await shellCore.requestRaw("/kb/index/notes", { method: "POST", body: { notes: [note.index] } }); return r.status >= 200 && r.status < 300 ? "indexed" : "failed"; } catch { return "failed"; }
    } }), []);
  return <LiveScreen active={active} deps={deps} />;
}
