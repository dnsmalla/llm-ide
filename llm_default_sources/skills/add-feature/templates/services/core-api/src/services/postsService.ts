import { postsRepo } from "../repositories/postsRepo";

export const postsService = {
  async list(userId: string, cursor?: string) {
    return postsRepo.listForUser({ userId, cursor, limit: 20 });
  },
  async create(userId: string, input: { title: string; body?: string; isPrivate?: boolean }) {
    if (!input.title || input.title.length > 200) throw new HttpError(400, "title required (≤200 chars)");
    return postsRepo.create({ userId, ...input });
  },
  async update(userId: string, id: string, patch: { title?: string; body?: string; isPrivate?: boolean }) {
    const existing = await postsRepo.get(id);
    if (!existing) throw new HttpError(404, "not found");
    if (existing.userId !== userId) throw new HttpError(403, "forbidden");
    return postsRepo.update(id, patch);
  },
  async remove(userId: string, id: string) {
    const existing = await postsRepo.get(id);
    if (!existing) throw new HttpError(404, "not found");
    if (existing.userId !== userId) throw new HttpError(403, "forbidden");
    await postsRepo.remove(id);
  },
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
