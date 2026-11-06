// GitLab code at the source (design 9, Q12): projects the user is a member of, the repository tree, one raw file, blob
// search. gitlab.com only (decision D1); it answers CORS with `*` for these GETs (checked 2026-11-06). Paced at 60/min:
// the Free plan's authenticated burst is 100/min.
import { checkQuery, createPacer, guardedGet, parseJson, SourceError, type Auth, type HttpDeps } from "./http.ts";
import { CAPS, loadPreview, previewKind } from "./preview.ts";
import { dedupe, type Entry, type Page, type ProjectRef, type SourceClient } from "./model.ts";

export const GITLAB_API = "https://gitlab.com/api/v4";
const enc = encodeURIComponent;
const str = (v: unknown, max = 1024): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

export function parseProject(o: any): Entry | null {
  const id = o?.id, path = str(o?.path_with_namespace), name = str(o?.name, 255), web = str(o?.web_url);
  if (!Number.isInteger(id) || id <= 0 || !path || !name || !web || !web.startsWith("https://gitlab.com/")) return null;
  const ref = str(o?.default_branch, 255) ?? "";
  return { id: `p${id}`, name, kind: "project", path, size: null, detail: ref ? null : "Empty project", project: { id, ref, webUrl: web } };
}
export function nextPage(h: Headers): string | null { const n = h.get("x-next-page"); return n && /^\d{1,6}$/.test(n) ? n : null; }

export function createGitLabClient(auth: Auth, d: HttpDeps = {}): SourceClient {
  const pacer = createPacer(60, d);
  const get = (url: string, cap: number = CAPS.json) => guardedGet(url, auth, pacer, cap, d);
  async function array(url: string): Promise<{ items: any[]; next: string | null }> {
    const g = await get(url); const j = parseJson(g);
    if (!Array.isArray(j)) throw new SourceError("bad_response");
    return { items: j, next: nextPage(g.headers) };
  }
  async function projects(q: string | null, page: string): Promise<Page> {
    const { items, next } = await array(`${GITLAB_API}/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=50&page=${page}${q ? `&search=${enc(q)}` : ""}`);
    return { entries: dedupe(items.map(parseProject).filter((e): e is Entry => e !== null)), next };
  }
  const fileEntry = (p: ProjectRef, path: string, name: string, kind: "dir" | "file", detail: string | null = null): Entry =>
    ({ id: `${p.id}:${path}`, name, kind, path, size: null, detail, project: p });
  const webUrl = (e: Entry): string | null => {
    const p = e.project; if (!p) return null;
    if (e.kind === "project") return p.webUrl;
    return `${p.webUrl}/-/${e.kind === "dir" ? "tree" : "blob"}/${enc(p.ref)}/${e.path.split("/").map(enc).join("/")}`;
  };
  return {
    provider: "gitlab",
    async list(dir, cursor) {
      const page = cursor && /^\d{1,6}$/.test(cursor) ? cursor : "1";
      if (!dir) return projects(null, page);
      const p = dir.project; if (!p) throw new SourceError("bad_response");
      if (!p.ref) return { entries: [], next: null };
      const { items, next } = await array(`${GITLAB_API}/projects/${p.id}/repository/tree?ref=${enc(p.ref)}&per_page=100&page=${page}${dir.kind === "dir" ? `&path=${enc(dir.path)}` : ""}`);
      // "commit" rows are submodules: another repository, not shown.
      const entries = items.flatMap((o) => { const name = str(o?.name, 255), path = str(o?.path); return name && path && (o.type === "tree" || o.type === "blob") ? [fileEntry(p, path, name, o.type === "tree" ? "dir" : "file")] : []; });
      return { entries, next };
    },
    async open(file) {
      const p = file.project; if (!p) throw new SourceError("bad_response");
      return loadPreview(file, previewKind(file.name, "gitlab"), webUrl(file), (cap) => get(`${GITLAB_API}/projects/${p.id}/repository/files/${enc(file.path)}/raw?ref=${enc(p.ref)}`, cap));
    },
    async search(q, within) {
      const t = checkQuery(q); const p = within?.project;
      if (!p) return projects(t, "1");
      if (!p.ref) return { entries: [], next: null };
      const { items } = await array(`${GITLAB_API}/projects/${p.id}/search?scope=blobs&search=${enc(t)}&ref=${enc(p.ref)}&per_page=20`);
      const entries = items.flatMap((o) => {
        const path = str(o?.path) ?? str(o?.filename); if (!path) return [];
        return [fileEntry(p, path, path.slice(path.lastIndexOf("/") + 1), "file", typeof o?.data === "string" ? o.data.slice(0, 300) : null)];
      });
      return { entries: dedupe(entries), next: null };
    },
    webUrl,
  };
}
