// Snapshot kinds as the desktop produces them (extension/routes/sync/kinds.mjs buildKinds; design 4.2). Types plus the
// allow-list: a manifest naming any other kind is refused. The frames are desktop-signed; React renders every string as text.
import type { HostApiResult } from "../host-api/types.generated.ts";

export const KINDS = ["chats", "meetings", "plans", "usage"] as const;
export type KindName = (typeof KINDS)[number];
export interface ChatItem { id: string; title: string; updatedAt: number; phoneChat?: boolean; messages: Array<{ seq: number; role: "user" | "assistant"; content: string }> }
export interface MeetingItem { id: string; title: string; date: string; durationSec: number; participants: string[]; notes: Array<{ kind: string; text: string }> }
export interface PlanTask { title: string; status: string; owner: string; due: string | null; milestone: string; risk: string }
export interface PlanItem { id: string; title: string; goal: string; updatedAt: number; tasks: PlanTask[] }
export type UsageItem = HostApiResult<"usage.get">;
export interface KindFrame<T> { v: 1; kind: KindName; generatedAt: number; truncated: boolean; items: T[] }
export interface Snapshot {
  generatedAt: number; validUntil: number; manifestSeq: number;
  kinds: { chats?: KindFrame<ChatItem>; meetings?: KindFrame<MeetingItem>; plans?: KindFrame<PlanItem>; usage?: KindFrame<UsageItem> };
}
