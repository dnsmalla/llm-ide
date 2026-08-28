import { listPosts, createPost, updatePost, deletePost } from "./posts";
// … inside handleRequest:
const postMatch = path.match(/^\/v1\/posts(?:\/([0-9a-f-]{36}))?$/);
if (postMatch) {
  const id = postMatch[1];
  if (!id && req.method === "GET")  return listPosts(req, res);
  if (!id && req.method === "POST") return createPost(req, res);
  if (id  && req.method === "PATCH")  return updatePost(req, res, id);
  if (id  && req.method === "DELETE") return deletePost(req, res, id);
}
