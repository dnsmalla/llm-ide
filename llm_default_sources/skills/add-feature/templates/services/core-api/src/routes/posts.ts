import type { IncomingMessage, ServerResponse } from "http";
import { postsService, HttpError } from "../services/postsService";

type AuthedReq = IncomingMessage & { body?: any; user?: { id: string } };

function sendJson(res: ServerResponse, status: number, payload: object) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function handleErr(res: ServerResponse, err: unknown) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.message, code: err.status === 404 ? "not_found" : err.status === 403 ? "forbidden" : "bad_request" });
  }
  console.error("posts route error", err);
  return sendJson(res, 500, { error: "Internal error", code: "internal" });
}

export const listPosts = async (req: AuthedReq, res: ServerResponse) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const data = await postsService.list(req.user.id, cursor);
    sendJson(res, 200, { success: true, data, nextCursor: data.length === 20 ? data[data.length - 1].id : null });
  } catch (err) { handleErr(res, err); }
};

export const createPost = async (req: AuthedReq, res: ServerResponse) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    const { title, body, isPrivate } = req.body ?? {};
    const row = await postsService.create(req.user.id, { title, body, isPrivate });
    sendJson(res, 201, { success: true, data: row });
  } catch (err) { handleErr(res, err); }
};

export const updatePost = async (req: AuthedReq, res: ServerResponse, id: string) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    const row = await postsService.update(req.user.id, id, req.body ?? {});
    sendJson(res, 200, { success: true, data: row });
  } catch (err) { handleErr(res, err); }
};

export const deletePost = async (req: AuthedReq, res: ServerResponse, id: string) => {
  if (!req.user) return sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
  try {
    await postsService.remove(req.user.id, id);
    res.statusCode = 204; res.end();
  } catch (err) { handleErr(res, err); }
};
