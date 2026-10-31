// One open icon set for every web surface: Lucide (ISC), vendored into
// icons.generated.ts. SF Symbols stay Mac-only (they cannot ship in a web view).
// Icons are decorative by default (aria-hidden); pass `label` for a meaningful one.
import { createElement, type ReactElement } from "react";
import { ICON_NODES, type IconName } from "./icons.generated";

export type { IconName };

export interface IconProps {
  size?: number;
  /** Accessible name. Omit for a decorative icon (the common case: a labelled button wraps it). */
  label?: string;
}

/** Any glyph of the vendored set by Lucide name. */
export function Icon({ name, size = 14, label }: IconProps & { name: IconName }): ReactElement {
  const children = ICON_NODES[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }));
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      focusable: "false",
      ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true }),
    },
    children,
  );
}

const make = (name: IconName, defaultSize: number) =>
  function NamedIcon({ size = defaultSize, label }: IconProps = {}) {
    return <Icon name={name} size={size} label={label} />;
  };

export const GraphIcon = make("network", 14);
export const EditorIcon = make("file-code", 14);
export const TerminalIcon = make("terminal", 14);
export const ChatIcon = make("message-square", 14);
export const BenchIcon = make("gauge", 14);
export const ChevronIcon = make("chevron-right", 10);
export const ChevronDownIcon = make("chevron-down", 10);
export const XIcon = make("x", 9);
export const SidebarIcon = make("panel-left", 14);
export const AlertIcon = make("triangle-alert", 14);
export const InfoIcon = make("info", 14);
export const CheckIcon = make("check", 12);

// Library sidebar and toolbar glyphs.
export const HomeIcon = make("house", 16);
export const SearchIcon = make("search", 13);
export const RefreshIcon = make("refresh-cw", 13);
export const FolderIcon = make("folder", 13);
export const BellIcon = make("bell", 13);
export const PlusIcon = make("plus", 10);
export const WaveIcon = make("audio-waveform", 10);
export const CodeIcon = make("code", 10);
export const TableIcon = make("table", 10);
export const DocIcon = make("file-text", 10);
export const PuzzleIcon = make("puzzle", 10);
export const ChartIcon = make("chart-column", 10);
export const DocLargeIcon = make("file-text", 46);
export const MicWaveIcon = make("audio-lines", 22);
export const DoubleChevronIcon = make("chevrons-right", 14);
export const ChatBubbleIcon = make("message-circle", 13);
