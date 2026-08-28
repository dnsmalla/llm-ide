const base = () => (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export const postsApi = {
  async list(cursor?: string) {
    const url = `${base()}/v1/posts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`list failed: ${r.status}`);
    return r.json();
  },
  async create(input: { title: string; body?: string; isPrivate?: boolean }) {
    const r = await fetch(`${base()}/v1/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(`create failed: ${r.status}`);
    return r.json();
  },
  async update(id: string, patch: { title?: string; body?: string; isPrivate?: boolean }) {
    const r = await fetch(`${base()}/v1/posts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`update failed: ${r.status}`);
    return r.json();
  },
  async remove(id: string) {
    const r = await fetch(`${base()}/v1/posts/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok && r.status !== 204) throw new Error(`delete failed: ${r.status}`);
  },
};
