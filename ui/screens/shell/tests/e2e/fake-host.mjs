// An in-memory stand-in for the Rust chat commands (desktop/src-tauri/src/chat_cmds.rs, chat_store.rs) that
// enforces the same rules the UI relies on: bound session required, compare-and-swap on a revision, append with
// the expected count, scope/title validation, paging by index. The real commands are covered by the Rust tests.
export function createFakeChatHost({ token = null } = {}) {
  const knobs = { declineDelete: false, declineTruncate: false, pendingCorrupt: false, unreadable: 0, unsupported: 0 };
  const calls = [];
  const files = new Map(); // id -> { doc, rev }
  const tokens = new Set();
  let bound = null;
  let rev = 0;
  const fail = (code, message = code) => Object.assign(new Error(message), { code, message });
  const need = () => { if (!bound) throw fail("not_bound"); };
  const SCOPES = ["explorer", "conflicts", "visual", "docGen", "quick"];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "chat_bind_session":
        if (typeof args?.token !== "string" || args.token.length < 10) throw fail("invalid");
        bound = args.token;
        return { userId: "u1", sharedWithMac: false, sweepStarted: false };
      case "chat_unbind_session": bound = null; return undefined;
      case "chat_list": {
        need();
        const a = args?.args ?? {};
        const all = [...files.values()].map((f) => f.doc).sort((x, y) => y.lastUsedAt - x.lastUsedAt);
        const items = all.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 50)).map((d) => ({
          id: d.id, title: d.title, scope: d.scope, projectId: d.projectId ?? null, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, messageCount: d.messages.length,
        }));
        return { items, total: all.length, hasMore: (a.offset ?? 0) + items.length < all.length, quarantined: 0, unsupported: knobs.unsupported, unreadable: knobs.unreadable };
      }
      case "chat_load": {
        need();
        const f = files.get(args.args.id);
        if (!f) throw fail("not_found");
        const end = args.args.before ?? f.doc.messages.length;
        const start = Math.max(0, end - (args.args.limit ?? 100));
        return { session: { ...f.doc, messages: f.doc.messages.slice(start, end) }, total: f.doc.messages.length, start, revision: String(f.rev) };
      }
      case "chat_save": {
        need();
        const { session, mode, expectedCount, expectedRevision, allowTruncate } = args.args;
        if (knobs.pendingCorrupt) throw fail("pending_corrupt", "raw host text");
        if (!SCOPES.includes(session.scope)) throw fail("invalid", "scope");
        if (typeof session.title !== "string") throw fail("invalid", "title");
        const old = files.get(session.id);
        if (old && expectedRevision === undefined) throw fail("conflict");
        if (!old && expectedRevision !== undefined) throw fail("conflict");
        if (old && String(old.rev) !== expectedRevision) throw fail("conflict");
        let doc;
        if (mode === "append") {
          if (!old) throw fail("conflict");
          if (old.doc.messages.length !== expectedCount) throw fail("conflict");
          doc = { ...old.doc };
          for (const k of ["title", "scope"]) if (k in session) doc[k] = session[k];
          doc.messages = [...old.doc.messages, ...session.messages];
        } else {
          if (old && old.doc.messages.length > 4 && session.messages.length * 2 < old.doc.messages.length) {
            if (!allowTruncate || !tokens.delete(`${session.id}:${allowTruncate}`)) throw fail("truncation_needs_confirm");
          }
          doc = { ...session };
        }
        doc.lastUsedAt = (doc.lastUsedAt ?? 0) + 1;
        files.set(session.id, { doc, rev: ++rev });
        return { revision: String(rev), messageCount: doc.messages.length, lastUsedAt: doc.lastUsedAt };
      }
      case "chat_confirm_truncate": {
        need();
        if (knobs.declineTruncate) throw fail("declined");
        const tok = `tok${++rev}`;
        tokens.add(`${args.args.id}:${tok}`);
        return tok;
      }
      case "chat_delete": { need(); if (knobs.pendingCorrupt) throw fail("pending_corrupt"); if (knobs.declineDelete) throw fail("declined"); const existed = files.delete(args.args.id); return { existed, tombstone: "done" }; }
      default: throw fail("unknown_command", command);
    }
  };
  return { invoke, calls, files, knobs, isBound: () => bound !== null, bumpExternally(id) { const f = files.get(id); if (f) f.rev = ++rev; } };
}
