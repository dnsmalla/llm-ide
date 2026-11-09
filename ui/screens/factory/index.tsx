// Factory section entry (section id `conflicts`): the shell lazy-loads this module (default export, SectionProps).
// "Open the Factory at this card" requests arrive on the shell bus as goto-section with anchor `item:<key>`.
import { useEffect, useState } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { shellBus } from "../shell/bus";
import { focusKeyFromAnchor } from "./anchor.ts";
import { FactoryScreen } from "./FactoryScreen.tsx";

export default function Factory(props: SectionProps) {
  const [focus, setFocus] = useState<{ key: string | null; n: number }>({ key: null, n: 0 });
  useEffect(() => {
    const take = (ev: { section: string; anchor?: string } | null) => {
      if (ev && ev.section === "conflicts") setFocus((f) => ({ key: focusKeyFromAnchor(ev.anchor), n: f.n + 1 }));
    };
    take(shellBus.takePending("goto-section"));
    return shellBus.subscribe("goto-section", (ev) => {
      shellBus.takePending("goto-section");
      take(ev);
    });
  }, []);
  return <FactoryScreen {...props} focus={focus} />;
}
