import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../db/client";
import { posts } from "../db/schema";

export const postsRepo = {
  async listForUser({ userId, limit = 20, cursor }: { userId: string; limit?: number; cursor?: string }) {
    const where = cursor
      ? and(eq(posts.userId, userId), lt(posts.id, cursor))
      : eq(posts.userId, userId);
    return db.select().from(posts).where(where).orderBy(desc(posts.createdAt)).limit(limit);
  },
  async get(id: string) {
    const [row] = await db.select().from(posts).where(eq(posts.id, id));
    return row ?? null;
  },
  async create(input: { userId: string; title: string; body?: string; isPrivate?: boolean }) {
    const [row] = await db.insert(posts).values({
      userId: input.userId,
      title: input.title,
      body: input.body ?? null,
      isPrivate: input.isPrivate ?? false,
    }).returning();
    return row;
  },
  async update(id: string, patch: Partial<{ title: string; body: string; isPrivate: boolean }>) {
    const [row] = await db.update(posts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(posts.id, id))
      .returning();
    return row ?? null;
  },
  async remove(id: string) {
    await db.delete(posts).where(eq(posts.id, id));
  },
};
