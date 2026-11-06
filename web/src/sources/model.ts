// The shared shapes of direct reads: one entry list and one opened-file record for both providers.
import type { Provider } from "./oauth.ts";
import type { PreviewKind } from "./preview.ts";

export interface ProjectRef { id: number; ref: string; webUrl: string }
export interface Entry {
  id: string; name: string; kind: "project" | "dir" | "file"; path: string;
  size: number | null; detail: string | null; project: ProjectRef | null;
}
export interface Page { entries: Entry[]; next: string | null }
export type Reason = "binary" | "type" | "too_large" | "no_text";
export interface Opened {
  entry: Entry; kind: PreviewKind; language: string; text: string | null; bytes: Uint8Array | null;
  truncated: boolean; webUrl: string | null; reason: Reason | null;
}
export interface SourceClient {
  readonly provider: Provider;
  list(dir: Entry | null, cursor: string | null): Promise<Page>;
  open(file: Entry): Promise<Opened>;
  search(q: string, within: Entry | null): Promise<Page>;
  webUrl(e: Entry): string | null;
}
/** Search can return one path several times (one hit per match); keep the first. */
export const dedupe = (es: Entry[]): Entry[] => { const seen = new Set<string>(); return es.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))); };
