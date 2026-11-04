// Loop on the desktop: the native runner (`native/`). The Mobile Control bridge remote-control view this file
// used to hold was removed once the native screen was verified in a real window (2026-11-04).
import type { ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { NativeLoopScreen } from "./native/NativeLoopScreen.tsx";

export default function LoopScreen(props: SectionProps): ReactNode {
  return <NativeLoopScreen {...props} />;
}
