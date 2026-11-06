// Box documents at the source (design 9, Q11): folder listing, one file's content or Box's extracted text, search.
// Scope root_readonly only. Paced at 240/min, well under Box's 1000/min per user. Shapes follow
// extension/connectors/box.mjs (parseFolderItems, fetchExtractedText, page length as the end signal).
import { checkQuery, createPacer, guardedGet, parseJson, SourceError, type Auth, type HttpDeps } from "./http.ts";
import { CAPS, loadPreview, previewKind } from "./preview.ts";
import { dedupe, type Entry, type SourceClient } from "./model.ts";

export const BOX_API = "https://api.box.com/2.0";
const FIELDS = "id,type,name,size,modified_at,extension";
const ID = /^\d{1,20}$/;
const PAGE = 100;

export function parseBoxEntry(o: any, parentPath: string): Entry | null {
  const id = typeof o?.id === "string" ? o.id : "", name = typeof o?.name === "string" ? o.name : "";
  if ((o?.type !== "file" && o?.type !== "folder") || !ID.test(id) || !name || name.length > 255) return null;
  return { id, name, kind: o.type === "folder" ? "dir" : "file", path: parentPath ? `${parentPath}/${name}` : name,
    size: Number.isSafeInteger(o?.size) && o.size >= 0 ? o.size : null, detail: null, project: null };
}

export function createBoxClient(auth: Auth, d: HttpDeps = {}): SourceClient {
  const pacer = createPacer(240, d);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const get = (url: string, cap: number = CAPS.json, headers: Record<string, string> = {}) => guardedGet(url, auth, pacer, cap, d, headers);
  async function obj(url: string, headers: Record<string, string> = {}): Promise<any> {
    const j = parseJson(await get(url, CAPS.json, headers));
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new SourceError("bad_response");
    return j;
  }
  const checkId = (id: string) => { if (!ID.test(id)) throw new SourceError("bad_response"); return id; };
  async function extractedTextUrl(id: string): Promise<string | null> {
    const info = await obj(`${BOX_API}/files/${id}?fields=representations`, { "X-Rep-Hints": "[extracted_text]" });
    const reps: any[] = Array.isArray(info?.representations?.entries) ? info.representations.entries : [];
    const rep = reps.find((r) => r?.representation === "extracted_text");
    if (!rep) return null;
    let state = rep.status?.state; let template = rep.content?.url_template; const infoUrl = rep.info?.url;
    for (let i = 0; (state === "pending" || state === "none") && typeof infoUrl === "string" && i < 3; i++) {
      await sleep(1500);
      const p = await obj(infoUrl);
      state = p?.status?.state; template = p?.content?.url_template ?? template;
    }
    return state === "success" && typeof template === "string" ? template.replace("{+asset_path}", "") : null;
  }
  const webUrl = (e: Entry) => `https://app.box.com/${e.kind === "dir" ? "folder" : "file"}/${e.id}`;
  const parents = (o: any): string => (Array.isArray(o?.path_collection?.entries) ? o.path_collection.entries : [])
    .map((p: any) => (typeof p?.name === "string" ? p.name : "")).filter((n: string) => n && n !== "All Files").join("/");
  return {
    provider: "box",
    async list(dir, cursor) {
      const offset = cursor && /^\d{1,7}$/.test(cursor) ? Number(cursor) : 0;
      const id = checkId(dir?.id ?? "0");
      const j = await obj(`${BOX_API}/folders/${id}/items?fields=${FIELDS}&limit=${PAGE}&offset=${offset}`);
      const raw: any[] = Array.isArray(j.entries) ? j.entries : [];
      // Page length is the end signal (box.mjs B4): total_count can be missing.
      return { entries: raw.map((o) => parseBoxEntry(o, dir?.path ?? "")).filter((e): e is Entry => e !== null), next: raw.length === PAGE ? String(offset + PAGE) : null };
    },
    async open(file) {
      const id = checkId(file.id); const kind = previewKind(file.name, "box");
      if (kind.kind === "extracted") {
        const url = await extractedTextUrl(id);
        if (!url) return { entry: file, kind: "unsupported", language: kind.language, text: null, bytes: null, truncated: false, webUrl: webUrl(file), reason: "no_text" };
        return loadPreview(file, kind, webUrl(file), (cap) => get(url, cap));
      }
      return loadPreview(file, kind, webUrl(file), (cap) => get(`${BOX_API}/files/${id}/content`, cap));
    },
    async search(q, within) {
      const t = checkQuery(q);
      const scope = within?.kind === "dir" ? `&ancestor_folder_ids=${checkId(within.id)}` : "";
      const j = await obj(`${BOX_API}/search?query=${encodeURIComponent(t)}&type=file&limit=20&fields=${FIELDS},path_collection${scope}`);
      const raw: any[] = Array.isArray(j.entries) ? j.entries : [];
      return { entries: dedupe(raw.map((o) => parseBoxEntry(o, parents(o))).filter((e): e is Entry => e !== null)), next: null };
    },
    webUrl,
  };
}
