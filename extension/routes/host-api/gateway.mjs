// Host API v1 on the desktop core: per-connection sessions, auth, `rev`, and the 12 commands — the structural
// twin of the Mac's HostApiV1Gateway.swift. Chat runs in process (startHostTurn) on one server-side "Phone chat"
// per user. The engine, decisions and chat-session modules load lazily, so this file stays off the boot path.
// Never log frame content, tokens or PINs: type and size only.
import { parseRequest, response, event, errorFrame, clamp } from './frame.mjs';
import { HostApiSession, helloRefusal, internalId } from './session.mjs';
import { createTranslator } from './translator.mjs';
import { PairingThrottle } from './throttle.mjs';
import { consumePin } from './pin.mjs';
import { HOST_API_COMMANDS, HOST_API_LIMITS } from './commands.generated.mjs';
import { issueDeviceToken, authenticateDeviceToken, revokeDevice, getQuickChatId, setQuickChatId, LEGACY_SCOPES } from '../../kb/host-api-devices.mjs';

export const MAX_SESSIONS = 4;
export const AUTH_DEADLINE_MS = 10_000;
// Refusals that clear by themselves; SESSION_TOKEN_LIMIT and SLASH_COMMAND_FAILED do not.
const RETRYABLE = new Set(['TURN_IN_PROGRESS', 'SDK_UPDATING', 'PLUGIN_UPDATING', 'ROUTE_UNAVAILABLE']);
const KNOWN = new Set([...RETRYABLE, 'SESSION_TOKEN_LIMIT', 'SLASH_COMMAND_FAILED']);

export function hostApiCapabilities(env = process.env) {
  return ['host', 'chat', 'approvals', ...(env.LLMIDE_HOST_API_TOOL_APPROVALS === '1' ? ['tool_approvals'] : [])];
}

const agentV2 = () => import('../agent-v2.mjs');
const chatSessions = () => import('../../kb/chat-sessions.mjs');

function defaultDeps() {
  return {
    capabilities: () => hostApiCapabilities(),
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
    quickChat: {
      get: getQuickChatId,
      set: setQuickChatId,
      create: async (userId) => (await chatSessions()).createChatSession(userId, { title: 'Phone chat', surface: 'any', mode: 'agent' }).id,
    },
    devices: { issueDeviceToken, authenticateDeviceToken, revokeDevice },
    pins: { consumePin },
    now: () => Date.now(),
    log: () => {},
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
  const throttle = new PairingThrottle();
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

  function opened(session, peer) {
    if (sessions.size >= MAX_SESSIONS) {
      fail(session, null, 'busy', 'This computer already has the maximum number of Host API connections.', { retryable: true });
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
    if (entry) clearTimeout(entry.timer);
    sessions.delete(session);
    for (const o of owned.values()) {
      if (o.session !== session || o.zombie) continue;
      o.zombie = true;
      requestCancel(o);
    }
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
    entry.queue = entry.queue.then(() => handle(session, text)).catch((e) => {
      deps.log(`Host API v1 frame handler failed (${e?.code ?? 'error'})`);
      let replyTo = null;
      try { replyTo = JSON.parse(text)?.id ?? null; } catch { /* no id to reply to */ }
      if (sessions.has(session)) fail(session, typeof replyTo === 'string' ? replyTo : null, 'internal', 'This computer could not handle that request.');
    });
    return entry.queue;
  }

  function throttled(s, id, peer) {
    const d = throttle.decision(peer, deps.now());
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

  async function lines(userId, limit) {
    return messagesOf(await deps.history(userId, limit), limit);
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
      .then(() => deps.turn({ userId: o.userId, chatSessionId, message: p.text, files: p.attachments ?? [], onEvent }))
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
      const capability = HOST_API_COMMANDS[r.command]?.capability;
      if (capability && served.includes(capability) && !entry.grants?.has(capability)) {
        deps.log(`Host API v1 connection ${entry.num} refused ${capability} (not granted)`);
        return fail(s, r.id, 'denied', `This device was not granted ${capability} — pair again to grant it.`);
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
        if (throttled(s, id, entry.peer)) return;
        // Checked before the PIN so a correct PIN is never spent on a connection that cannot pair.
        if (entry.state.phase.kind !== 'awaitingAuth') return fail(s, id, 'denied', 'This connection is not waiting to pair.');
        const pinUser = deps.pins.consumePin(p.pin, deps.now());
        if (pinUser == null) {
          throttle.failure(entry.peer, deps.now());
          return fail(s, id, 'auth_failed', 'Wrong PIN.');
        }
        throttle.success(entry.peer);
        // The device is granted exactly what is served now; a capability turned on later needs a re-pair.
        const scopes = [...new Set(['host', ...served])];
        const { deviceId, token } = deps.devices.issueDeviceToken(pinUser, entry.state.phase.clientName, deps.now(), scopes);
        entry.state.authenticated(pinUser, deviceId);
        clearTimeout(entry.timer);
        return respond(s, id, command, { token, capabilities: grant(entry, scopes) });
      }
      case 'host.auth.token': {
        if (throttled(s, id, entry.peer)) return;
        const auth = deps.devices.authenticateDeviceToken(p.token, deps.now());
        if (!auth) {
          throttle.failure(entry.peer, deps.now());
          return fail(s, id, 'auth_failed', 'This device is no longer paired with this computer — pair again with a new PIN.');
        }
        throttle.success(entry.peer);
        entry.state.authenticated(auth.userId, auth.deviceId);
        clearTimeout(entry.timer);
        return respond(s, id, command, { capabilities: grant(entry, auth.scopes ?? LEGACY_SCOPES) });
      }
      case 'host.auth.revoke': {
        const auth = deps.devices.authenticateDeviceToken(p.token, deps.now());
        const { deviceId } = entry.state;
        if (!auth || auth.userId !== userId || auth.deviceId !== deviceId) return fail(s, id, 'denied', 'Only this connection\'s own token can be revoked here.');
        deps.devices.revokeDevice(userId, deviceId);
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
      case 'chat.snapshot': {
        const limit = p.limit ?? HOST_API_LIMITS.defaultListItems;
        return respond(s, id, command, { messages: await lines(userId, limit) });
      }
      case 'chat.send': {
        if (owned.has(internalId(entry.num, id))) return fail(s, id, 'busy', 'That request id is still running.');
        if ([...owned.values()].some((o) => o.session === s)) return fail(s, id, 'busy', 'A chat turn is already running on this connection.');
        const chatSessionId = await quickChatFor(userId);
        if (sessions.get(s) !== entry) return;
        return startTurn(s, entry, id, p, chatSessionId);
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
      default:
        return fail(s, id, 'unknown_command', 'This host does not serve that command.');
    }
  }

  return {
    opened, receive, closed, closeAll, capabilitiesChanged, disconnectDevice,
  };
}
