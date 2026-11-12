// Stateful engine-event -> Host API v1 event translator (the Node twin of HostApiV2Translator.swift).
// Deltas stream coalesced: flushed at >= FLUSH_BYTES pending or FLUSH_MS after the first pending byte, and always
// before chat.done / chat.error / approval events so the order is preserved. The full reply is kept for resume.
import { clamp } from './frame.mjs';

const DELTA_CHUNK = 100_000;
export const FLUSH_BYTES = 4096;
export const FLUSH_MS = 250;
const none = { events: [], terminal: false };
const ev = (command, payload) => ({ command, payload });
const validId = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 64;
const str = (s) => (typeof s === 'string' ? s : '');

function chunks(text) {
  const out = [];
  let cur = '';
  for (const cp of text) {
    if (cur.length + cp.length > DELTA_CHUNK) { out.push(cur); cur = ''; }
    cur += cp;
  }
  if (cur) out.push(cur);
  return out;
}

function questionsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw) {
    const options = (Array.isArray(q?.options) ? q.options : [])
      .filter((o) => str(o?.label) !== '').slice(0, 20)
      .map((o) => ({ label: clamp(o.label, 200), ...(typeof o.description === 'string' ? { description: clamp(o.description, 500) } : {}) }));
    if (str(q?.question) === '' || !options.length) continue;
    out.push({
      question: clamp(q.question, 2000),
      ...(typeof q.header === 'string' ? { header: clamp(q.header, 12) } : {}),
      multiSelect: q.multiSelect === true,
      options,
    });
    if (out.length === 10) break;
  }
  return out;
}

export function createTranslator({ external, onFlush = null, flushBytes = FLUSH_BYTES, flushMs = FLUSH_MS }) {
  let reply = '';
  let pending = '';
  let timer = null;
  let ended = false;
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const takePending = () => {
    stopTimer();
    const out = chunks(pending).map((text) => ev('chat.delta', { text }));
    pending = '';
    return out;
  };
  const withFlush = (r) => (r === none || (!r.terminal && !r.events.length) ? r : { ...r, events: [...takePending(), ...r.events] });
  const step = (e, cancelledByClient) => {
      switch (e?.type) {
        case 'delta':
          { const text = str(e.text);
            reply += text;
            pending += text;
            if (pending.length >= flushBytes) return { events: takePending(), terminal: false };
            if (pending && !timer && onFlush) {
              timer = setTimeout(() => { timer = null; const events = takePending(); if (events.length && !ended) onFlush(events); }, flushMs);
              timer.unref?.();
            }
            return none; }
        case 'result': {
          const done = { requestId: external, ...(typeof e.stopReason === 'string' && e.stopReason ? { stopReason: clamp(e.stopReason, 200) } : {}) };
          return { events: [ev('chat.done', done)], terminal: true };
        }
        case 'error':
          if (cancelledByClient) return { events: [ev('chat.done', { requestId: external, stopReason: 'cancelled' })], terminal: true };
          return { events: [ev('chat.error', { message: clamp(str(e.message) || 'The turn failed.', 2000), retryable: !!e.retryable })], terminal: true };
        case 'approval_request': {
          if (!validId(e.requestId) || !validId(external)) return none;
          if (e.kind === 'AskUserQuestion') {
            const questions = questionsOf(e.questions);
            // Nothing renderable: stay parked for the desktop user rather than emit an invalid event.
            return questions.length ? { events: [ev('approval.request', { requestId: e.requestId, commandId: external, questions })], terminal: false } : none;
          }
          if (e.kind === 'ToolApproval') {
            const raw = str(e.argsSummary);
            const summary = clamp(raw, 2000);
            return { events: [ev('toolApproval.request', { requestId: e.requestId, commandId: external, toolName: clamp(str(e.toolName) || 'tool', 200), summary, truncated: summary !== raw })], terminal: false };
          }
          return none;
        }
        case 'approval_resolved':
          return validId(e.requestId) && validId(external)
            ? { events: [ev('approval.cleared', { requestId: e.requestId, commandId: external, reason: clamp(str(e.outcome), 500) })], terminal: false }
            : none;
        default:
          return none;
      }
  };
  return {
    push(e, { cancelledByClient } = {}) {
      if (ended) return { events: [], terminal: true };
      const r = withFlush(step(e, cancelledByClient));
      if (r.terminal) { ended = true; stopTimer(); pending = ''; }
      return r;
    },
    /** The whole reply so far (never cleared by a flush). */
    text: () => reply,
    /** Drop unsent deltas (a resume response already carries the full text). */
    discardPending() { pending = ''; stopTimer(); },
    dispose() { ended = true; stopTimer(); },
  };
}

// One-shot helper: with no timer, deltas below the byte threshold are only flushed by the next flushing event.
export const translate = (e, { external, cancelledByClient } = {}) => createTranslator({ external }).push(e, { cancelledByClient });
