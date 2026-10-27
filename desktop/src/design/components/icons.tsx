// Minimal stroked glyphs (currentColor) standing in for the Mac's SF Symbols.
import type { ReactNode } from "react";

function Svg({ size = 14, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const GraphIcon = () => (
  <Svg>
    <circle cx="4" cy="4" r="1.8" />
    <circle cx="12" cy="5" r="1.8" />
    <circle cx="8" cy="12" r="1.8" />
    <path d="M5.5 5l5 0M4.8 5.8l2.5 4.8M11 6.6L8.9 10.6" />
  </Svg>
);
export const EditorIcon = () => (
  <Svg>
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M6.5 8l-1.5 1.5L6.5 11M9 8l1.5 1.5L9 11" />
  </Svg>
);
export const TerminalIcon = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" />
  </Svg>
);
export const ChatIcon = () => (
  <Svg>
    <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h-.5A1.5 1.5 0 0 1 2 9.5z" />
  </Svg>
);
export const BenchIcon = () => (
  <Svg>
    <path d="M3 13V8M8 13V4M13 13V6" />
  </Svg>
);
export const ChevronIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 2l3 3-3 3" />
  </svg>
);
export const XIcon = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
    <path d="M1.5 1.5l6 6M7.5 1.5l-6 6" />
  </svg>
);
export const SidebarIcon = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6 3v10" />
  </Svg>
);
export const AlertIcon = () => (
  <Svg>
    <path d="M8 2.5l6 10.5H2z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Svg>
);
export const InfoIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.5v3.5M8 5v.01" />
  </Svg>
);

// Library sidebar and toolbar glyphs (SF Symbol stand-ins).
export const HomeIcon = () => (
  <Svg size={16}>
    <path d="M2.5 7.5L8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5z" />
  </Svg>
);
export const SearchIcon = () => (
  <Svg size={13}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Svg>
);
export const RefreshIcon = () => (
  <Svg size={13}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M13 2.5v3h-3" />
  </Svg>
);
export const FolderIcon = () => (
  <Svg size={13}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Svg>
);
export const BellIcon = () => (
  <Svg size={13}>
    <path d="M4 10.5V7a4 4 0 0 1 8 0v3.5L13 12H3z" />
    <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
  </Svg>
);
export const PlusIcon = () => (
  <Svg size={10}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const WaveIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2 8h1.5M5 5v6M7.5 3v10M10 5.5v5M12.5 7v2M14 8h0" />
  </Svg>
);
export const CodeIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4M9 3l-2 10" />
  </Svg>
);
export const TableIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 6.5h12M2 10h12M6 3v10" />
  </Svg>
);
export const DocIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="2.5" width="10" height="11" rx="1" />
    <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
  </Svg>
);
export const PuzzleIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 5h3a1.5 1.5 0 1 1 3 0h3v3a1.5 1.5 0 1 0 0 3v2H3V5z" />
  </Svg>
);
export const ChartIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 13.5h10.5M4.5 11V8M7.5 11V5M10.5 11V7M13 11V3.5" />
  </Svg>
);
export const DocLargeIcon = () => (
  <svg width="46" height="46" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" aria-hidden="true">
    <path d="M4 1.5h5.5L12.5 4.5V14.5H4z" />
    <path d="M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5M6 13h2.5" />
  </svg>
);
export const MicWaveIcon = () => (
  <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" aria-hidden="true">
    <path d="M2 8h1M4.5 5v6M7 3v10M9.5 5.5v5M12 6.5v3M14 8h0" />
  </svg>
);
export const DoubleChevronIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4l4 4-4 4M8 4l4 4-4 4" />
  </svg>
);
export const ChatBubbleIcon = () => (
  <Svg size={13}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h7A1.5 1.5 0 0 1 12 4.5v4A1.5 1.5 0 0 1 10.5 10H6l-2.5 2V10H3.5A1.5 1.5 0 0 1 2 8.5z" />
    <path d="M12.5 6.5h1A1.5 1.5 0 0 1 15 8v3.5L13 10" />
  </Svg>
);
