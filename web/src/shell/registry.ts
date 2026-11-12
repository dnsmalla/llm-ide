// The section registry. A screen is added by registering it; the shell (sidebar, tab bar, header, deep links) needs no edit.
//
//   registerSection({ id: "tasks", label: "Auto Tasks", icon: "list-checks", requires: ["read"], order: 30, component: TasksScreen });
//
// A section is hidden when the host does not serve what it `requires` (Host API v1 capabilities; the per-command capability
// is in schema/host-api/v1/commands.json, e.g. tasks.list -> read, chat.send -> chat) and, with `localOnly`, when the host is
// an always-online hub (hub-copy.ts: offline sync is a local-desktop feature).
import type { ComponentType } from "react";
import type { ConnectionState } from "../host-api/connection.ts";
import type { HostApiCapability } from "../host-api/types.generated.ts";
import type { ChatState } from "../chat/store.ts";
import type { ComposeState } from "../chat/compose.ts";
import type { ProjectsState } from "../projects/controller.ts";
import type { PushState } from "../push/controller.ts";
import type { ReadState } from "../read/controller.ts";
import type { Session } from "../app-model.ts";
import type { UiIconName } from "../ui/icons.tsx";

/** Everything a section needs, already subscribed. Sections re-render when any of it changes. */
export interface ShellContext {
  /** The live session: `session.connection.send(cmd, payload)` for any Host API command; controllers for chat/read/compose/projects. */
  session: Session;
  conn: ConnectionState;
  capabilities: ReadonlySet<HostApiCapability>;
  hub: boolean;
  hostName: string;
  hostUrl: string;
  /** This page's origin (named in the unreachable-host hint); defaults to the browser's. */
  pageOrigin?: string;
  chat: ChatState; read: ReadState; compose: ComposeState; projects: ProjectsState; push: PushState;
  /** Offline sync is linked to this browser (not a hub): Settings offers the offline copy. */
  offlineLinked: boolean;
  actions: ShellActions;
  /** The Execute chat; sections other than Execute ignore it. */
  execute?: ExecuteContext;
  /** Go to a section (and an optional sub-page): updates the URL hash. */
  navigate: (section: string, sub?: string | null) => void;
}
/** The Execute chat (surface "execute"): its own thread, composer options and actions, independent of Ask. Absent in tests that do not need it. */
export interface ExecuteContext {
  chat: ChatState; compose: ComposeState;
  actions: {
    reload?(): void; // re-ask the desktop for chat options (the Retry of the unavailable page)
    send(text: string): void; stop(): void; newChat(): void; deleteChat(): void;
    answerQuestion(requestId: string, answers: Record<string, string>): void; declineQuestion(requestId: string): void; answerTool(requestId: string, decision: "allow_once" | "deny"): void;
    setModel(id: string): void; removeAttachment(index: number): void; addFiles(files: FileList | null): void;
  };
}
export interface ShellActions {
  send(text: string): void; stop(): void; clearHistory(): void; newChat?: () => void;
  answerQuestion(requestId: string, answers: Record<string, string>): void; declineQuestion(requestId: string): void; answerTool(requestId: string, decision: "allow_once" | "deny"): void;
  selectProject(id: string): void;
  setMode(mode: string): void; setModel(id: string): void; removeAttachment(index: number): void; addFiles(files: FileList | null): void;
  readOpen(id: string, title: string): void; readOlder(): void; readClose(): void; readMore(): void;
  enablePush(): void; disablePush(): void;
  forget(): void; changeAddress(url: string): Promise<string | null>;
  openOffline?: () => void; openSources(): void;
}
export interface SectionProps { ctx: ShellContext }

export interface SectionDef {
  /** URL segment: #/<id>. Lower-case, stable. */
  id: string;
  label: string;
  /** Tab-bar label when `label` is long ("Auto Tasks" -> "Tasks"). */
  shortLabel?: string;
  icon: UiIconName;
  /** Host API capabilities the host must serve (all of them). Omit for always-on. */
  requires?: readonly HostApiCapability[];
  /** Hidden when the host is a hub. */
  localOnly?: boolean;
  /** Sort key; the built-ins use 10 (Ask), 20 (Execute), 30 (Auto Tasks), 40 (Loop), 50 (History), 90 (Settings). */
  order: number;
  /** Stay mounted (hidden) after the first visit, so a draft or scroll position survives a tab switch. */
  keepAlive?: boolean;
  /** "fill": the screen owns its scrolling and fills the pane (a chat with a sticky composer). Default "scroll": a padded page. */
  layout?: "scroll" | "fill";
  component: ComponentType<SectionProps>;
}

const sections = new Map<string, SectionDef>();
export function registerSection(def: SectionDef): void { sections.set(def.id, def); }
export function unregisterSection(id: string): void { sections.delete(id); }
export function getSections(): SectionDef[] { return [...sections.values()].sort((a, b) => a.order - b.order); }

/** An empty capability set means the host has not said yet (first connect, or a blip): show everything rather than flicker the nav. */
export function sectionVisible(def: SectionDef, host: { capabilities: ReadonlySet<HostApiCapability>; hub: boolean }): boolean {
  if (def.localOnly && host.hub) return false;
  if (!def.requires?.length || host.capabilities.size === 0) return true;
  return def.requires.every((c) => host.capabilities.has(c));
}
export const visibleSections = (host: { capabilities: ReadonlySet<HostApiCapability>; hub: boolean }): SectionDef[] => getSections().filter((s) => sectionVisible(s, host));
