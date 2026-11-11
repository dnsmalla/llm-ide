import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../shell/tests/helpers.mjs";

const { CoreMirrorChatStore } = await load("../chat/merged-store.ts");
const nativeSession = (id, updatedAt) => ({ id, title: id, surface: "explorer", mode: null, projectId: null, createdAt: 1, updatedAt });
const coreSession = (id, updatedAt) => ({ id, title: id, surface: "any", mode: "agent", projectId: null, createdAt: 1, updatedAt });

function stores() {
  const calls = [];
  const native = {
    listSessions: async () => [nativeSession("desk", 10)],
    loadMessages: async () => { calls.push(["native-load"]); return { messages: [], hasMore: false }; },
    createSession: async () => nativeSession("new", 1),
    renameSession: async () => { calls.push(["native-rename"]); },
    deleteSession: async () => { calls.push(["native-delete"]); },
    appendMessage: async () => { calls.push(["native-append"]); },
    dropInterruptedMessage: async () => false,
  };
  const transport = {
    async json(method, path) {
      calls.push([method, path]);
      if (path.startsWith("/kb/chat/sessions?")) return { sessions: [coreSession("phone", 20)] };
      if (path.startsWith("/kb/chat/sessions/phone") && method === "GET") return { session: { messages: [{ seq: 1, role: "user", content: "hi", meta: null, createdAt: 1 }], hasMore: false } };
      return {};
    },
  };
  return { native, transport, calls };
}

test("core-only phone chats appear in the desktop list and load from the core", async () => {
  const { native, transport, calls } = stores();
  const store = new CoreMirrorChatStore(native, transport);
  const list = await store.listSessions({ limit: 50, offset: 0 });
  assert.deepEqual(list.map((s) => s.id), ["phone", "desk"]);
  await store.loadMessages("phone", { limit: 50 });
  assert.equal(calls.some(([m, p]) => m === "GET" && String(p).startsWith("/kb/chat/sessions/phone")), true);
  assert.equal(calls.some(([m]) => m === "native-load"), false);
});
