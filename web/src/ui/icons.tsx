// The kit's Lucide icons plus a few web-only glyphs the vendored set lacks (same Lucide path data, same 24 grid).
import { createElement, type ReactElement } from "react";
import { Icon as KitIcon, type IconName } from "@llmide/ui-kit";

type Node = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;
const EXTRA = {
  copy: [["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
  "arrow-up": [["path", { d: "m5 12 7-7 7 7" }], ["path", { d: "M12 19V5" }]],
  "arrow-down": [["path", { d: "M12 5v14" }], ["path", { d: "m19 12-7 7-7-7" }]],
  "chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2" }], ["path", { d: "M12 20v2" }], ["path", { d: "m4.93 4.93 1.41 1.41" }], ["path", { d: "m17.66 17.66 1.41 1.41" }], ["path", { d: "M2 12h2" }], ["path", { d: "M20 12h2" }], ["path", { d: "m6.34 17.66-1.41 1.41" }], ["path", { d: "m19.07 4.93-1.41 1.41" }]],
  moon: [["path", { d: "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" }]],
  monitor: [["rect", { width: 20, height: 14, x: 2, y: 3, rx: 2 }], ["path", { d: "M8 21h8" }], ["path", { d: "M12 17v4" }]],
  "external-link": [["path", { d: "M15 3h6v6" }], ["path", { d: "M10 14 21 3" }], ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }]],
  "circle-check": [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "m9 12 2 2 4-4" }]],
  "circle-help": [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }], ["path", { d: "M12 17h.01" }]],
  paperclip: [["path", { d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" }]],
  mic: [["path", { d: "M12 19v3" }], ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }], ["rect", { x: 9, y: 2, width: 6, height: 13, rx: 3 }]],
  trash: [["path", { d: "M10 11v6" }], ["path", { d: "M14 11v6" }], ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }], ["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }]],
} as const satisfies Record<string, Node>;

export type UiIconName = IconName | keyof typeof EXTRA;

export function UiIcon({ name, size = 18, label }: { name: UiIconName; size?: number; label?: string }): ReactElement {
  if (!(name in EXTRA)) return <KitIcon name={name as IconName} size={size} label={label} />;
  const nodes = EXTRA[name as keyof typeof EXTRA] as Node;
  return createElement("svg", {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", focusable: "false",
    ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true }),
  }, nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs })));
}
