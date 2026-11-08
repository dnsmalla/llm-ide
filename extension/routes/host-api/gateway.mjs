// Host API v1 on the desktop core: per-connection sessions, auth, `rev`, and the 17 commands (chat, approvals, the `read` slice and `compose`).
// Chat runs in process (startHostTurn) on one server-side "Phone chat" per user. The engine, decisions and chat-session modules load lazily, so this file stays off the boot path.
// Never log frame content, tokens or PINs: type and size only.
import { parseRequest, response, event, errorFrame, clamp } from './frame.mjs';
import { HostApiSession, helloRefusal, internalId } from './session.mjs';
import { createTranslator } from './translator.mjs';
import { PairingThrottle, peerKey } from './throttle.mjs';
import { createRateLimiter } from './rate.mjs';
import { consumePin } from './pin.mjs';
import { sessionsOf, historyOf, usageOf, READ_LIMITS } from './reads.mjs';
import { attachmentsToFiles, isBinaryAttachment, optionsOf, offersModel } from './compose.mjs';
import { pushTargetOf } from './push-target.mjs';
import { HOST_API_COMMANDS, HOST_API_LIMITS } from './commands.generated.mjs';
import { issueDeviceToken, authenticateDeviceToken, revokeDevice, getQuickChatId, setQuickChatId, LEGACY_SCOPES, MAX_LIFETIME_MS } from '../../kb/host-api-devices.mjs';
import { getDb } from '../../kb/db.mjs';
import { getMember, classRefusal } from '../../kb/members.mjs';
import { usedUsdMonthForProject } from '../../kb/project-usage.mjs';
import { projectsListResult, projectFrameAuthority } from './projects.mjs';

// ADR 0021 hub: the cap belongs to ONE member (their phones and browsers), not to the whole install. The
// global ceiling is hub-sized so a team's members do not shut each other out; it still bounds the core.
export const MAX_SESSIONS_PER_USER = 4;
export const MAX_SESSIONS = 64;
export const AUTH_DEADLINE_MS = 10_000; // a session not authenticated by then is closed
const TOP_LEVEL_ID = /^\s*\{(?:\s*"(?:apiVersion|type|command|ts)"\s*:\s*(?:"[^"\\]*"|[0-9.eE+-]+)\s*,)*\s*"id"\s*:\s*"([^"\\]{1,128})"/;
export const MAX_UNAUTHENTICATED_PER_PEER = 2; // so one peer cannot hold every MAX_SESSIONS slot before auth
// Refusals that clear by themselves; SESSION_TOKEN_LIMIT, SLASH_COMMAND_FAILED, ROLE_DENIED and USD_CAP do not.
// ROLE_DENIED is the team clamp's refusal (ADR 0021): its message is the gateway's own text, so it is
// relayed like the other known codes instead of the generic "turn failed" line.
const RETRYABLE = new Set(['TURN_IN_PROGRESS', 'BUSY', 'SDK_UPDATING', 'PLUGIN_UPDATING', 'ROUTE_UNAVAILABLE']);
const KNOWN = new Set([...RETRYABLE, 'SESSION_TOKEN_LIMIT', 'SLASH_COMMAND_FAILED', 'ROLE_DENIED', 'USD_CAP']);
// ADR 0021 + plan H1.2: a max_mode none member, or a caller with no authority row (fail closed), is
// served host + read + push. A viewer may also Ask: chat + approvals (runV2Turn forces the turn to
// `ask`). compose and tool_approvals stay off for both.
const MINIMAL_SCOPES = ['host', 'read', 'push'];
const VIEWER_SCOPES = ['host', 'read', 'push', 'chat', 'approvals'];
function minimalFor(member, caps) {
  if (!member || member.maxMode === 'none') return caps.filter((c) => MINIMAL_SCOPES.includes(c));
  if (member.teamRole === 'viewer') return caps.filter((c) => VIEWER_SCOPES.includes(c));
  return caps;
}

// Plan H1.2: each command's action class, checked on EVERY frame against the member's current row,
// so a demotion applies on the next frame, not at the next re-auth. null = pairing / heartbeat.
export const COMMAND_CLASS = Object.freeze({
  'host.hello': null,
  'host.auth.pair': null,
  'host.auth.token': null,
  'host.auth.revoke': null,
  'host.ping': null,
  'host.snapshot': 'self.read',
  'chat.snapshot': 'self.read',
  'chat.sessions': 'self.read',
  'chat.history': 'self.read',
  'usage.get': 'self.read',
  'chat.options': 'self.read',
  'push.config': 'self.read',
  'chat.cancel': 'self.write',
  'chat.history.clear': 'self.write',
  'chat.new': 'self.write',
  'push.register': 'self.write',
  'push.unregister': 'self.write',
  'chat.send': 'model.ask',
  'approvals.answer': 'model.ask',
  'toolApprovals.answer': 'model.exec',
  // ADR 0022: every project-scoped command may carry projectId; checked on every frame.
  'projects.list': 'self.read',
});

export function hostApiCapabilities(env = process.env) {
  return ['host', 'chat', 'approvals',
    ...(env.LLMIDE_HOST_API_TOOL_APPROVALS === '1' ? ['tool_approvals'] : []),
    ...(env.LLMIDE_HOST_API_READ === '1' ? ['read'] : []), // default off: a device gets read only if paired while served
    ...(env.LLMIDE_HOST_API_COMPOSE === '1' ? ['compose'] : []), // default off, as read
    ...(env.LLMIDE_HOST_API_PUSH === '1' ? ['push'] : [])]; // default off: push notifications sent by this desktop
}

const agentV2 = () => import('../agent-v2.mjs');
const chatSessions = () => import('../../kb/chat-sessions.mjs');
const pushModule = () => import('./push.mjs'); // Task 6; lazy, off the boot path

function defaultDeps() {
  return {
    capabilities: () => hostApiCapabilities(),
    // The paired user's authority row (ADR 0021), read fresh at pairing and at every token re-auth.
    member: (userId) => getMember(getDb(), userId),
    chatClearEnabled: () => process.env.LLMIDE_HOST_API_CHAT_CLEAR === '1',
    turn: async (args) => (await agentV2()).startHostTurn(args),
    cancel: async (userId, chatSessionId) => (await agentV2()).cancelChatTurn(userId, chatSessionId),
    clear: async (userId, chatSessionId) => (await agentV2()).clearChatSessionState(userId, chatSessionId),
    decide: async (args) => (await import('../../llm_agent/sdk/decisions.mjs')).answerDecision(args),
    history: async (userId, limit) => {
      const id = getQuickChatId(userId);
      if (!id) return [];
      return (await chatSessions()).getChatSession(userId, id, { messageLimit: limit })?.messages ?? [];
    },
    append: async (userId, chatSessionId, line) => (await chatSessions()).appendChatMessage(userId, chatSessionId, line),
    // In-process, user-scoped stores (never HTTP). The session's userId is the only user a read ever names.
    read: {
      sessions: async (userId, { limit, offset }) => (await chatSessions()).listChatSessions(userId, { limit, offset }),
      history: async (userId, sessionId, { limit, beforeSeq }) => (await chatSessions()).getChatSession(userId, sessionId, { messageLimit: limit, beforeSeq }),
      usage: async (userId) => {
        const [{ usageSummary }, { getDb }] = await Promise.all([import('../../kb/usage.mjs'), import('../../kb/db.mjs')]);
        return usageSummary(getDb(), userId);
      },
    },
    // The account's Claude models, in process and cached by the SDK module (never HTTP). Lazy: off the boot path.
    models: async (userId) => (await import('../../llm_agent/sdk/models.mjs')).listSdkModels(userId),
    push: {
      config: async (userId, deviceId) => (await pushModule()).pushConfig(userId, deviceId),
      register: async (userId, deviceId, target) => (await pushModule()).registerTarget(userId, deviceId, target),
      unregister: async (userId, deviceId) => (await pushModule()).unregisterTarget(userId, deviceId),
    },
    quickChat: {
      get: getQuickChatId,
      set: setQuickChatId,
      create: async (userId) => (await chatSessions()).createChatSession(userId, { title: 'Phone chat', surface: 'any', mode: 'agent' }).id,
    },
    devices: { issueDeviceToken, authenticateDeviceToken, revokeDevice },
    pins: { consumePin },
    now: () => Date.now(),
    log: () => {},
    audit: () => {}, // (event, { peer, userId, deviceId, clientName, detail, dedupeKey }); server.mjs passes routes/host-api/audit.mjs
    certificateFingerprint: () => null, // the TLS listener's pin; a plaintext dev host omits it
  };
}

export function messagesOf(lines, limit) {
  const recent = lines.filter((m) => m?.role === 'user' || m?.role === 'assistant')
    .slice(-Math.min(Math.max(limit, 1), HOST_API_LIMITS.maxListItems))
    .map((m) => ({ role: m.role, content: clamp(typeof m.content === 'string' ? m.content : '', 100_000) }));
  // Newest first within maxListBytes (UTF-8 JSON), so the frame stays under maxFrameBytes. The newest message
  // always goes in: clamped to 100k characters it is at most ~600 KB even fully escaped, under the budget.
  let bytes = 0;
  let start = recent.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(recent[start - 1])) + 1;
    if (start < recent.length && bytes + size > HOST_API_LIMITS.maxListBytes) break;
    bytes += size;
    start -= 1;
  }
  return recent.slice(start);
}

export function createGateway(overrides) {
  const deps = { ...defaultDeps(), ...overrides };
  const sessions = new Map(); // handle -> { state, peer, num, queue, timer, rev, grants, lastSent }
  // internal id -> { session, external, cancelRequested, started, zombie, userId, chatSessionId, translator, sdkSessionId, open }.
  // A closed session's in-flight commands stay as zombies (nothing sent) until their turn settles, so a cancel
  // requested before the turn held the engine lock can be re-issued when its init arrives.
  const owned = new Map();
  const creatingQuickChat = new Map(); // userId -> Promise<chatSessionId>
  // Separate buckets: a wrong PIN must not delay a token reconnect from the same peer, nor the reverse.
  const pairThrottle = new PairingThrottle();
  const tokenThrottle = new PairingThrottle();
  const rate = createRateLimiter();
  let nextNum = 0;

  // A session's capabilities are served ∩ granted (the token's scopes), in served order; `host` is always granted.
  const effective = (entry) => deps.capabilities().filter((c) => entry.grants?.has(c));
  function grant(entry, scopes) {
    entry.grants = new Set(['host', ...scopes]);
    const caps = effective(entry);
    entry.lastSent = JSON.stringify(caps);
    return caps;
  }

  // rev is per connection (spec): events bump the session's own counter; responses and errors carry its value.
  const revOf = (s) => sessions.get(s)?.rev ?? 0;
  const fail = (s, replyTo, code, message, extra = {}) => deps.send(s, errorFrame({ replyTo, code, message, rev: revOf(s), ...extra }));
  function respond(s, replyTo, command, result) {
    let text;
    try { text = response(replyTo, command, result, revOf(s)); } catch {
      deps.log(`Host API v1 ${command} result failed validation — sent internal`);
      return fail(s, replyTo, 'internal', 'This computer could not build this reply.');
    }
    deps.send(s, text);
  }
  function sendEvent(s, command, payload, replyTo) {
    const entry = sessions.get(s);
    if (!entry) return;
    entry.rev += 1;
    let text;
    try { text = event(command, payload, entry.rev, replyTo); } catch {
      return deps.log(`Host API v1 ${command} event failed validation — dropped`);
    }
    deps.send(s, text);
  }

  // Audit fields without undefined keys, so a row carries only what is known.
  const audit = (event, fields) => {
    try { deps.audit(event, Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null))); } catch { /* never fail a frame */ }
  };

  function opened(session, peer) {
    const key = peerKey(peer);
    const pending = [...sessions.values()].filter((e) => !e.state.deviceId && peerKey(e.peer) === key).length;
    const why = sessions.size >= MAX_SESSIONS ? 'This hub already has the maximum number of Host API connections.'
      : pending >= MAX_UNAUTHENTICATED_PER_PEER ? 'This device already has connections waiting to sign in — finish or close one first.' : null;
    if (why) {
      fail(session, null, 'busy', why, { retryable: true });
      deps.close(session);
      return;
    }
    nextNum += 1;
    const entry = { state: new HostApiSession(), peer: String(peer ?? ''), num: nextNum, queue: Promise.resolve(), timer: null, rev: 0, grants: null, lastSent: null };
    entry.timer = setTimeout(() => {
      if (sessions.get(session) !== entry || entry.state.deviceId) return;
      deps.log(`Host API v1 connection ${entry.num} did not authenticate in time — closing`);
      deps.close(session);
      closed(session);
    }, AUTH_DEADLINE_MS);
    entry.timer.unref?.();
    sessions.set(session, entry);
  }

  function closed(session) {
    const entry = sessions.get(session);
    if (entry) { clearTimeout(entry.timer); rate.drop(entry.num); }
    sessions.delete(session);
    for (const o of owned.values()) {
      if (o.session !== session || o.zombie) continue;
      o.zombie = true;
      requestCancel(o);
    }
  }

  // Per-member cap (ADR 0021 hub): count only this member's authenticated connections.
  const userSessionCount = (userId) => [...sessions.values()].filter((e) => e.state.userId === userId).length;

  /** Over the member's own cap: the per-install refusal text is unchanged; the connection is closed. */
  function refuseUserCap(s, entry, replyTo, userId, event) {
    audit(event, { peer: entry.peer, userId, detail: 'session_limit' });
    fail(s, replyTo, 'busy', 'This computer already has the maximum number of Host API connections.', { retryable: true });
    deps.close(s);
    closed(s);
  }

  // cancelChatTurn is chat-wide: call it only for a command that holds the engine lock (its init arrived), so a
  // not-yet-started command never aborts another session's running turn on the same chat.
  function requestCancel(o) {
    o.cancelRequested = true;
    if (o.started) cancelTurn(o);
  }

  function cancelTurn(o) {
    const failed = (e) => deps.log(`Host API v1 cancel failed (${e?.code ?? 'error'})`);
    try { Promise.resolve(deps.cancel(o.userId, o.chatSessionId)).catch(failed); } catch (e) { failed(e); }
  }

  function disconnectDevice(userId, deviceId) {
    for (const [s, e] of [...sessions]) {
      if (e.state.deviceId !== deviceId || e.state.userId !== userId) continue;
      fail(s, null, 'auth_failed', 'This device was removed on this computer.');
      deps.close(s);
      closed(s);
    }
  }

  function closeAll() {
    for (const s of [...sessions.keys()]) {
      deps.close(s);
      closed(s);
    }
  }

  function capabilitiesChanged() {
    for (const [s, e] of sessions) {
      if (!e.state.deviceId) continue;
      const caps = effective(e);
      const key = JSON.stringify(caps);
      if (key === e.lastSent) continue;
      e.lastSent = key;
      sendEvent(s, 'host.capabilities', { capabilities: caps });
    }
  }

  // One session's frames are handled strictly in order; a slow command never reorders them.
  function receive(session, text) {
    const entry = sessions.get(session);
    if (!entry) return Promise.resolve();
    // The frame bucket runs before any parsing, so a flood costs one regex per frame.
    const wait = rate.frame(entry.num, deps.now());
    if (wait != null) {
      rateRefused(session, entry, cheapId(text), wait);
      return Promise.resolve();
    }
    entry.queue = entry.queue.then(() => handle(session, text)).catch((e) => {
      deps.log(`Host API v1 frame handler failed (${e?.code ?? 'error'})`);
      let replyTo = null;
      try { replyTo = JSON.parse(text)?.id ?? null; } catch { /* no id to reply to */ }
      if (sessions.has(session)) fail(session, typeof replyTo === 'string' ? replyTo : null, 'internal', 'This computer could not handle that request.');
    });
    return entry.queue;
  }

  // The top-level request id from the frame's head, never a full parse: only scalar envelope members may precede
  // "id", so a payload's nested "id" never matches (null then).
  function cheapId(text) {
    const m = TOP_LEVEL_ID.exec(String(text).slice(0, 512));
    return m ? m[1] : null;
  }

  function rateRefused(s, entry, replyTo, wait) {
    fail(s, replyTo, 'rate_limited', 'Too many requests — slow down and try again.', { retryable: true, retryAfterMs: wait });
    if (!rate.refused(entry.num)) return;
    deps.log(`Host API v1 connection ${entry.num} closed after repeated rate refusals`);
    audit('rate_closed', { peer: entry.peer, userId: entry.state.userId, deviceId: entry.state.deviceId, dedupeKey: entry.peer });
    deps.close(s);
    closed(s);
  }

  function readRefused(s, entry, id) {
    const wait = rate.read(entry.state.deviceId, deps.now());
    if (wait == null) return false;
    rateRefused(s, entry, id, wait);
    return true;
  }

  function throttled(s, id, peer, throttle, event) {
    const d = throttle.decision(peer, deps.now());
    if (d.kind !== 'allow') audit(event, { peer, detail: d.kind, dedupeKey: peer });
    switch (d.kind) {
      case 'wait': fail(s, id, 'auth_failed', 'Too many attempts — wait a moment and try again.', { retryable: true, retryAfterMs: d.ms }); return true;
      case 'lockedOut': fail(s, id, 'auth_failed', 'Too many wrong PINs — locked out for 15 minutes.', { retryable: true, retryAfterMs: d.ms }); return true;
      case 'serverThrottled': fail(s, id, 'auth_failed', 'This computer is refusing new pairings for a few minutes.', { retryable: true, retryAfterMs: d.ms }); return true;
      default: return false;
    }
  }

  function quickChatFor(userId) {
    const existing = deps.quickChat.get(userId);
    if (existing) return existing;
    // Two sessions of one user sending at once must not create two phone chats.
    let p = creatingQuickChat.get(userId);
    if (!p) {
      p = Promise.resolve(deps.quickChat.create(userId)).then((id) => { deps.quickChat.set(userId, id); return id; })
        .finally(() => creatingQuickChat.delete(userId));
      creatingQuickChat.set(userId, p);
    }
    return p;
  }

  // A chat.send that picks a mode or model needs `compose` (served ∩ granted), like a command of that capability.
  // Returns true when it refused (the frame is answered).
  function composeRefused(s, entry, id) {
    if (entry.grants?.has('compose') && deps.capabilities().includes('compose')) return false;
    if (!deps.capabilities().includes('compose')) { fail(s, id, 'capability_unavailable', 'This computer does not serve compose right now.'); return true; }
    const { userId: u, deviceId: d } = entry.state;
    audit('scope_denied', { peer: entry.peer, userId: u, deviceId: d, detail: 'compose', dedupeKey: `${d}:compose` });
    fail(s, id, 'denied', 'This device was not granted compose — pair again to grant it.');
    return true;
  }

  async function lines(userId, limit) {
    return messagesOf(await deps.history(userId, limit), limit);
  }

  // The SDK may be logged out or slow to answer: compose then offers the desktop default only, never an error.
  async function modelsFor(userId) {
    try { return await deps.models(userId); } catch (e) { deps.log(`Host API v1 model list unavailable (${e?.code ?? 'error'})`); return []; }
  }

  function startTurn(s, entry, id, p, chatSessionId) {
    const iid = internalId(entry.num, id);
    const o = { session: s, external: id, cancelRequested: false, started: false, zombie: false, userId: entry.state.userId, chatSessionId,
      translator: createTranslator({ external: id }), sdkSessionId: null, open: new Set(), reply: '', saved: Promise.resolve() };
    owned.set(iid, o);
    // The phone chat's lines go to chat_messages (what the snapshots read), in order, even for a closed session.
    const save = (role, content) => {
      o.saved = o.saved.then(() => deps.append(o.userId, chatSessionId, { role, content }))
        .catch((e) => deps.log(`Host API v1 ${role} line not saved (${e?.code ?? 'error'})`));
    };
    respond(s, id, 'chat.send', { accepted: true, requestId: id });
    const push = (ev) => {
      if (owned.get(iid) !== o || o.zombie) return;
      const t = o.translator.push(ev, { cancelledByClient: o.cancelRequested });
      if (t.terminal) owned.delete(iid);
      for (const e of t.events) sendEvent(s, e.command, e.payload, id);
    };
    // Runs inside the engine's event callback: a throw here must never fail the turn.
    const onEvent = (ev) => {
      try {
        if (owned.get(iid) !== o) return;
        // The engine registers decisions under the latest session_id its stream reported (engine.mjs), as here.
        if (typeof ev?.sessionId === 'string' && ev.sessionId) o.sdkSessionId = ev.sessionId;
        if (ev?.type === 'init' && !o.started) {
          o.started = true; // init arrives once the turn holds the lock and its abort is registered
          save('user', p.text); // only after init: a refused turn never stores its line
          if (o.cancelRequested) cancelTurn(o);
        }
        if (ev?.type === 'delta' && typeof ev.text === 'string') o.reply += ev.text;
        if (ev?.type === 'result' && o.started && o.reply) { save('assistant', o.reply); o.reply = ''; }
        if (o.zombie) return;
        if (ev?.type === 'approval_request' && typeof ev.requestId === 'string') o.open.add(ev.requestId);
        if (ev?.type === 'approval_resolved') o.open.delete(ev.requestId);
        // Raw engine error text may carry internals; only the gateway's known refusal codes keep theirs.
        push(ev?.type === 'error' && !KNOWN.has(ev.code) ? { ...ev, message: 'The turn failed on this computer.' } : ev);
      } catch (e) { deps.log(`Host API v1 engine event ${ev?.type ?? '?'} dropped (${e?.code ?? 'error'})`); }
    };
    Promise.resolve()
      .then(() => deps.turn({ userId: o.userId, chatSessionId, message: p.text, files: attachmentsToFiles(p.attachments), mode: p.mode ?? 'auto', model: p.model ?? null, projectId: p.projectId ?? null, onEvent }))
      // An aborted turn resolves without a terminal event: end it here (a cancelled done when the client asked).
      .then(() => push({ type: 'error', message: 'The turn ended without a reply.', retryable: true }))
      .catch((err) => {
        const code = err?.code;
        deps.log(`Host API v1 turn refused (${KNOWN.has(code) ? code : 'error'})`);
        let message = KNOWN.has(code) && typeof err.message === 'string' && err.message ? err.message : 'This computer could not run the turn.';
        const det = err?.details;
        if (code === 'SESSION_TOKEN_LIMIT' && Number.isFinite(det?.used) && Number.isFinite(det?.limit)) message += ` (${det.used} of ${det.limit} tokens used)`;
        push({ type: 'error', message, retryable: RETRYABLE.has(code) });
      })
      .catch((e) => deps.log(`Host API v1 turn end failed (${e?.code ?? 'error'})`))
      .finally(() => { if (owned.get(iid) === o) owned.delete(iid); });
  }

  async function answer(s, entry, id, p, action, extra) {
    const o = owned.get(internalId(entry.num, p.commandId));
    if (!o || !o.open.has(p.requestId)) return fail(s, id, 'not_found', 'That chat request is not open on this connection.');
    const out = await deps.decide({ requestId: p.requestId, sdkSessionId: o.sdkSessionId, userId: o.userId, action, ...extra });
    if (!out?.ok) {
      return out?.reason === 'tenancy'
        ? fail(s, id, 'denied', 'That approval belongs to another session.')
        : fail(s, id, 'not_found', 'That approval is no longer waiting for an answer.');
    }
    o.open.delete(p.requestId);
    respond(s, id, p.command, { accepted: true });
  }

  async function handle(s, text) {
    const entry = sessions.get(s);
    if (!entry) return;
    const r = parseRequest(text);
    if (!r.ok) {
      deps.log(`Host API v1 refused a frame (${r.code}, ${Buffer.byteLength(text, 'utf8')} bytes)`);
      return fail(s, r.replyTo, r.code, r.message);
    }
    const served = deps.capabilities();
    if (entry.state.deviceId) {
      // R-023 #7: the lifetime is checked on EVERY frame, not only at auth: an open WSS session must not outlive
      // its device's 90 days (the lost-phone case).
      if (typeof entry.state.pairedAt === 'number' && deps.now() - entry.state.pairedAt > MAX_LIFETIME_MS) {
        const { userId: u, deviceId: d } = entry.state;
        audit('token_failed', { peer: entry.peer, userId: u, deviceId: d, detail: 'expired', dedupeKey: `${d}:expired` });
        fail(s, r.id, 'auth_failed', 'This device is past its 90 days — pair again with a new PIN.');
        return disconnectDevice(u, d);
      }
      const capability = HOST_API_COMMANDS[r.command]?.capability;
      if (capability && served.includes(capability) && !entry.grants?.has(capability)) {
        deps.log(`Host API v1 connection ${entry.num} refused ${capability} (not granted)`);
        const { userId: u, deviceId: d } = entry.state;
        audit('scope_denied', { peer: entry.peer, userId: u, deviceId: d, detail: capability, dedupeKey: `${d}:${capability}` });
        return fail(s, r.id, 'denied', `This device was not granted ${capability} — pair again to grant it.`);
      }
      const cls = COMMAND_CLASS[r.command];
      if (cls === undefined) {
        const { userId: u, deviceId: d } = entry.state;
        audit('role_denied', { peer: entry.peer, userId: u, deviceId: d, detail: 'unclassified', dedupeKey: `${d}:unclassified` });
        return fail(s, r.id, 'denied', 'This command is not available.');
      }
      if (cls !== null) {
        const { userId: u, deviceId: d } = entry.state;
        const refusal = classRefusal(deps.member(u), cls);
        if (refusal) {
          deps.log(`Host API v1 connection ${entry.num} refused ${r.command} (${refusal})`);
          audit('role_denied', { peer: entry.peer, userId: u, deviceId: d, detail: refusal, dedupeKey: `${d}:${refusal}` });
          return fail(s, r.id, 'denied', 'Your team role no longer allows this.');
        }
        // ADR 0022: a frame that names a project is re-checked against the fresh project row on EVERY
        // frame. An unassigned caller is a viewer (Ask only); a project demotion applies immediately.
        const project = projectFrameAuthority(getDb(), u, r.command, r.payload, {
          usedUsd: (projectId) => usedUsdMonthForProject(getDb(), u, projectId),
        });
        if (!project.ok) {
          deps.log(`Host API v1 connection ${entry.num} refused ${r.command} (project ${project.reason})`);
          audit('project_denied', {
            peer: entry.peer, userId: u, deviceId: d, detail: project.reason,
            dedupeKey: `${d}:project:${project.reason}`,
          });
          return fail(
            s, r.id,
            project.reason === 'not_found' ? 'not_found' : 'denied',
            project.reason === 'not_found'
              ? 'That project is not registered on this computer.'
              : project.reason === 'usd_cap'
                ? 'Monthly USD cap reached.'
                : 'Your project role no longer allows this.',
          );
        }
      }
    }
    const gate = entry.state.gate(r.command, new Set(entry.state.deviceId ? effective(entry) : served));
    if (!gate.allow) return fail(s, r.id, gate.code, gate.message);
    const { id, payload: p, command } = r;
    const userId = entry.state.userId;

    switch (command) {
      case 'host.hello': {
        const why = helloRefusal(p.apiVersions);
        if (why) return fail(s, id, 'capability_unavailable', why);
        entry.state.greeted(p.clientName);
        const fingerprint = deps.certificateFingerprint();
        return respond(s, id, command, {
          hostName: clamp(deps.hostName() || 'Computer', 120), hostKind: 'desktop', apiVersion: 1, apiVersions: [1],
          capabilities: deps.capabilities(), protocolVersion: 1, requiresAuth: true,
          ...(fingerprint ? { certificateFingerprint: fingerprint } : {}),
        });
      }
      case 'host.auth.pair': {
        if (throttled(s, id, entry.peer, pairThrottle, 'pair_throttled')) return;
        // Checked before the PIN so a correct PIN is never spent on a connection that cannot pair.
        if (entry.state.phase.kind !== 'awaitingAuth') return fail(s, id, 'denied', 'This connection is not waiting to pair.');
        const pinUser = deps.pins.consumePin(p.pin, deps.now());
        if (pinUser == null) {
          pairThrottle.failure(entry.peer, deps.now());
          audit('pair_failed', { peer: entry.peer });
          return fail(s, id, 'auth_failed', 'Wrong PIN.');
        }
        pairThrottle.success(entry.peer);
        // The cap is per member: their own phones and browsers, not every member of the hub.
        if (userSessionCount(pinUser) >= MAX_SESSIONS_PER_USER) return refuseUserCap(s, entry, id, pinUser, 'pair_failed');
        // ADR 0021: a viewer / `max_mode` none member is served the minimum only. The filter is applied
        // here, at pairing, so the token's scopes never carry chat / approvals / tool_approvals / compose.
        const served2 = minimalFor(deps.member(pinUser), served);
        // The device is granted exactly what is served now; a capability turned on later needs a re-pair.
        const scopes = [...new Set(['host', ...served2])];
        const { deviceId, token } = deps.devices.issueDeviceToken(pinUser, entry.state.phase.clientName, deps.now(), scopes);
        entry.state.authenticated(pinUser, deviceId);
        entry.state.pairedAt = deps.now();
        clearTimeout(entry.timer);
        audit('pair_ok', { peer: entry.peer, userId: pinUser, deviceId, clientName: entry.state.phase.clientName });
        return respond(s, id, command, { token, capabilities: grant(entry, scopes) });
      }
      case 'host.auth.token': {
        if (throttled(s, id, entry.peer, tokenThrottle, 'token_throttled')) return;
        const auth = deps.devices.authenticateDeviceToken(p.token, deps.now());
        if (!auth) {
          tokenThrottle.failure(entry.peer, deps.now());
          audit('token_failed', { peer: entry.peer });
          return fail(s, id, 'auth_failed', 'This device is no longer paired with this computer — pair again with a new PIN.');
        }
        tokenThrottle.success(entry.peer);
        if (userSessionCount(auth.userId) >= MAX_SESSIONS_PER_USER) return refuseUserCap(s, entry, id, auth.userId, 'token_failed');
        entry.state.authenticated(auth.userId, auth.deviceId);
        entry.state.pairedAt = auth.pairedAt;
        clearTimeout(entry.timer);
        // Re-auth recomputes from the stored scopes ∩ the member filter, so a demoted member loses chat
        // on the next connect (ADR 0021).
        return respond(s, id, command, {
          capabilities: grant(entry, minimalFor(deps.member(auth.userId), auth.scopes ?? LEGACY_SCOPES)),
        });
      }
      case 'host.auth.revoke': {
        const auth = deps.devices.authenticateDeviceToken(p.token, deps.now());
        const { deviceId } = entry.state;
        if (!auth || auth.userId !== userId || auth.deviceId !== deviceId) return fail(s, id, 'denied', 'Only this connection\'s own token can be revoked here.');
        deps.devices.revokeDevice(userId, deviceId);
        audit('revoke_self', { peer: entry.peer, userId, deviceId });
        respond(s, id, command, { revoked: true });
        // Every live session of this device ends, the asking one included (its response is already sent).
        return disconnectDevice(userId, deviceId);
      }
      case 'host.ping':
        return respond(s, id, command, {});
      case 'host.snapshot': {
        if (!p.topics.every((t) => t === 'chat')) {
          return fail(s, id, 'capability_unavailable', 'This computer serves only the chat snapshot.', { hint: 'Served topics: chat' });
        }
        const messages = await lines(userId, HOST_API_LIMITS.defaultListItems);
        return respond(s, id, command, { snapshots: { chat: { messages } } });
      }
      case 'projects.list': {
        return respond(s, id, command, projectsListResult(getDb(), userId));
      }
      case 'chat.snapshot': {
        const limit = p.limit ?? HOST_API_LIMITS.defaultListItems;
        return respond(s, id, command, { messages: await lines(userId, limit) });
      }
      case 'chat.send': {
        // Text only (fixtures/security/compose.json imagesAllowed:false): the engine would read `[binary:` framing as an image.
        if ((p.attachments ?? []).some(isBinaryAttachment)) return fail(s, id, 'invalid_payload', 'Attachments must be plain text; images are not accepted.');
        const picks = p.mode !== undefined || p.model !== undefined;
        if (picks && composeRefused(s, entry, id)) return;
        const wait = rate.turn(entry.state.deviceId, deps.now());
        if (wait != null) return rateRefused(s, entry, id, wait);
        if (owned.has(internalId(entry.num, id))) return fail(s, id, 'busy', 'That request id is still running.');
        if ([...owned.values()].some((o) => o.session === s)) return fail(s, id, 'busy', 'A chat turn is already running on this connection.');
        if (p.model !== undefined && !offersModel(await modelsFor(userId), p.model)) {
          return fail(s, id, 'denied', 'That model is not offered on this computer — pick another.');
        }
        if (picks) {
          const deviceId = entry.state.deviceId;
          audit('compose_send', { peer: entry.peer, userId, deviceId, detail: `mode=${p.mode ?? 'auto'} model=${p.model ?? 'default'} files=${p.attachments?.length ?? 0}`,
            dedupeKey: `${deviceId}:${p.mode ?? 'auto'}:${p.model ?? ''}` });
        }
        const chatSessionId = await quickChatFor(userId);
        if (sessions.get(s) !== entry) return;
        return startTurn(s, entry, id, p, chatSessionId);
      }
      case 'chat.options': {
        if (readRefused(s, entry, id)) return;
        audit('chat_options', { peer: entry.peer, userId, deviceId: entry.state.deviceId, dedupeKey: entry.state.deviceId });
        return respond(s, id, command, optionsOf(await modelsFor(userId)));
      }
      case 'chat.cancel': {
        const mine = [...owned.values()].filter((o) => o.session === s && !o.zombie);
        for (const o of mine) requestCancel(o);
        return respond(s, id, command, { cancelled: mine.length > 0 });
      }
      case 'chat.history.clear': {
        if (!deps.chatClearEnabled()) return fail(s, id, 'denied', 'Clearing the phone chat is turned off on this computer.');
        // A turn accepted here may not hold the engine's lock yet (mode classification runs first).
        if ([...owned.values()].some((o) => o.userId === userId)) return fail(s, id, 'busy', 'A chat turn is running — try again when it ends.', { retryable: true });
        const chatSessionId = deps.quickChat.get(userId);
        if (!chatSessionId) return respond(s, id, command, { cleared: true });
        const out = await deps.clear(userId, chatSessionId);
        if (!out?.cleared) return fail(s, id, 'busy', 'A chat turn is running — try again when it ends.', { retryable: true });
        return respond(s, id, command, { cleared: true });
      }
      case 'approvals.answer':
        return answer(s, entry, id, { ...p, command }, 'answer', { answers: p.answers });
      case 'toolApprovals.answer':
        // Never always-allow from a client: allow once or deny.
        return answer(s, entry, id, { ...p, command }, p.decision === 'allow_once' ? 'allow' : 'deny', {});
      case 'chat.sessions': {
        if (readRefused(s, entry, id)) return;
        const limit = p.limit ?? READ_LIMITS.sessionsDefault;
        const offset = p.offset ?? 0;
        const rows = await deps.read.sessions(userId, { limit: limit + 1, offset });
        return respond(s, id, command, sessionsOf(rows, limit, offset, deps.quickChat.get(userId)));
      }
      case 'chat.history': {
        if (readRefused(s, entry, id)) return;
        const limit = p.limit ?? READ_LIMITS.historyDefault;
        const session = await deps.read.history(userId, p.sessionId, { limit, beforeSeq: p.beforeSeq });
        // Another user's id reads as unknown: the store query is WHERE user_id = ? AND id = ?.
        if (!session) return fail(s, id, 'not_found', 'That chat is not on this computer.');
        return respond(s, id, command, historyOf(session, limit));
      }
      case 'usage.get': {
        if (readRefused(s, entry, id)) return;
        return respond(s, id, command, usageOf(await deps.read.usage(userId)));
      }
      case 'chat.new': {
        const wait = rate.turn(entry.state.deviceId, deps.now()); // a write: the turn bucket, not the read one
        if (wait != null) return rateRefused(s, entry, id, wait);
        if ([...owned.values()].some((o) => o.userId === userId)) return fail(s, id, 'busy', 'A chat turn is running — try again when it ends.', { retryable: true });
        await creatingQuickChat.get(userId); // a first phone chat being created right now is replaced, not raced
        const sessionId = await deps.quickChat.create(userId);
        deps.quickChat.set(userId, sessionId);
        audit('chat_new', { peer: entry.peer, userId, deviceId: entry.state.deviceId });
        return respond(s, id, command, { sessionId });
      }
      case 'push.config': {
        if (readRefused(s, entry, id)) return;
        return respond(s, id, command, await deps.push.config(userId, entry.state.deviceId));
      }
      case 'push.register': {
        const deviceId = entry.state.deviceId;
        const t = pushTargetOf(p);
        if (!t.ok) {
          audit('push_refused', { peer: entry.peer, userId, deviceId, detail: String(p.kind), dedupeKey: `${deviceId}:push` });
          return fail(s, id, 'invalid_payload', t.message);
        }
        const wait = rate.turn(deviceId, deps.now());
        if (wait != null) return rateRefused(s, entry, id, wait);
        await deps.push.register(userId, deviceId, t.target);
        const detail = t.target.kind === 'apns' ? `apns ${t.target.environment}` : `webpush ${new URL(t.target.endpoint).hostname}`;
        audit('push_register', { peer: entry.peer, userId, deviceId, detail, dedupeKey: `${deviceId}:${detail}` });
        return respond(s, id, command, { registered: true });
      }
      case 'push.unregister': {
        const deviceId = entry.state.deviceId;
        const wait = rate.turn(deviceId, deps.now());
        if (wait != null) return rateRefused(s, entry, id, wait);
        const removed = Boolean(await deps.push.unregister(userId, deviceId));
        audit('push_unregister', { peer: entry.peer, userId, deviceId });
        return respond(s, id, command, { removed });
      }
      default:
        return fail(s, id, 'unknown_command', 'This host does not serve that command.');
    }
  }

  return {
    opened, receive, closed, closeAll, capabilitiesChanged, disconnectDevice,
  };
}
