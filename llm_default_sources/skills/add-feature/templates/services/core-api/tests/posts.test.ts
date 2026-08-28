import { describe, it, expect, beforeEach } from "vitest";
import { postsService, HttpError } from "../src/services/postsService";
import { postsRepo } from "../src/repositories/postsRepo";

describe("postsService", () => {
  beforeEach(async () => {
    // test db is seeded with fixture users by the setup script
  });

  it("rejects empty titles", async () => {
    await expect(postsService.create("u_1", { title: "" })).rejects.toBeInstanceOf(HttpError);
  });

  it("creates and lists user posts", async () => {
    const row = await postsService.create("u_1", { title: "hi" });
    const list = await postsService.list("u_1");
    expect(list.map(r => r.id)).toContain(row.id);
  });

  it("prevents cross-user updates", async () => {
    const row = await postsService.create("u_1", { title: "mine" });
    await expect(postsService.update("u_2", row.id, { title: "hacked" })).rejects.toMatchObject({ status: 403 });
  });
});
