import "./live.css";
import { useMemo } from "react";
import { shellBus, type SectionProps } from "@llmide/screens/shell";
import { createCaptureHost } from "./host.ts";
import { LiveScreen, type LiveDeps } from "./LiveScreen.tsx";
export default function Live({ active }: SectionProps) {
  const deps = useMemo<LiveDeps>(() => ({ capture: createCaptureHost(), language: () => "en", openLibrary: () => shellBus.publish({ type: "goto-section", section: "library" }) }), []);
  return <LiveScreen active={active} deps={deps} />;
}
