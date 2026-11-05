// An in-memory stand-in for the part of megajs 1.3.10's Storage that connectors/sync-store/mega.mjs uses: storage.root (the
// Cloud Drive); node.nodeId/name/directory/size/timestamp/parent/children; node.mkdir(name); node.upload({ name, size },
// buffer).complete; node.downloadBuffer({}); node.delete(permanent); storage.on('add'|'update'|'delete'); storage.close().
// As with the real client, a delete reaches the local tree only when the server's packet arrives (here: flush()), and
// errors are plain Errors carrying megajs's "ENAME (-n): ..." message. No network.
import { EventEmitter } from 'node:events';

const ENOENT = 'ENOENT (-9): Object (typically, node or user) not found. Wrong password?';

export function createFakeMega({ email, password }) {
  const queued = [];          // [{ op, message }]: the next call of `op` fails with `message`
  const sessions = new Set(); // live fake Storage objects
  const pendingDeletes = [];  // deleted nodes still in the tree until flush()
  let ids = 0;
  const emit = (event, node) => { for (const s of sessions) s.emit(event, node); };
  const gate = async (op) => {
    const i = queued.findIndex((q) => q.op === op);
    if (i >= 0) throw new Error(queued.splice(i, 1)[0].message);
  };
  const fake = {
    logins: 0, logouts: 0, permanentDeletes: 0, uploads: [],
    failNext(op, message) { queued.push({ op, message }); },
    loseSessions() { for (const s of [...sessions]) s.lose(); },
    flush() {
      for (const n of pendingDeletes.splice(0)) {
        n.parent.children.splice(n.parent.children.indexOf(n), 1);
        emit('delete', n);
      }
    },
  };
  const makeNode = ({ name, directory, parent, data = null }) => {
    const n = {
      nodeId: `n${++ids}`, name, directory, parent, data, deleted: false,
      size: data ? data.length : 0, timestamp: Math.floor(Date.now() / 1000), children: directory ? [] : undefined,
      async mkdir(opt) {
        await gate('mkdir');
        const c = makeNode({ name: typeof opt === 'string' ? opt : opt.name, directory: true, parent: n });
        n.children.push(c);
        emit('add', c);
        return c;
      },
      upload(opt, source) {
        return { complete: (async () => {
          await gate('upload');
          if (!Buffer.isBuffer(source) || source.length !== opt.size) throw new Error('Specified data size does not match');
          const c = makeNode({ name: opt.name, directory: false, parent: n, data: Buffer.from(source) });
          n.children.push(c);
          fake.uploads.push(Buffer.from(source));
          emit('add', c);
          return c;
        })() };
      },
      async downloadBuffer() {
        await gate('download');
        if (n.deleted) throw new Error(ENOENT);
        return Buffer.from(n.data);
      },
      async delete(permanent) {
        await gate('delete');
        if (permanent !== true) throw new Error('fake-mega: sync deletes must be permanent (no rubbish bin)');
        if (n.deleted) throw new Error(ENOENT);
        n.deleted = true;
        fake.permanentDeletes++;
        pendingDeletes.push(n);
      },
    };
    return n;
  };
  fake.root = makeNode({ name: 'Cloud Drive', directory: true, parent: null });
  fake.login = async (creds, { onLost } = {}) => {
    fake.logins++;
    await gate('login');
    if (creds.email !== email || creds.password !== password) throw new Error(ENOENT);
    const s = new EventEmitter();
    s.root = fake.root;
    s.lose = () => { sessions.delete(s); onLost?.(new Error('ESID (-15): Invalid or expired user session, please relogin')); };
    s.close = async () => { sessions.delete(s); fake.logouts++; };
    sessions.add(s);
    return s;
  };
  return fake;
}
