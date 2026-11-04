// Stateful engine-event -> Host API v1 event translator (the Node twin of HostApiV2Translator.swift).
// Deltas are accumulated and sent as chunked chat.delta at the result, matching the Mac's wire behaviour.
import { clamp } from './frame.mjs';

const DELTA_CHUNK = 100_000;
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

export function createTranslator({ external }) {
  let reply = '';
  return {
    push(e, { cancelledByClient } = {}) {
      switch (e?.type) {
        case 'delta':
          reply += str(e.text);
          return none;
        case 'result': {
          const done = { requestId: external, ...(typeof e.stopReason === 'string' && e.stopReason ? { stopReason: clamp(e.stopReason, 200) } : {}) };
          return { events: [...chunks(reply).map((text) => ev('chat.delta', { text })), ev('chat.done', done)], terminal: true };
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
    },
  };
}

export const translate = (e, { external, cancelledByClient } = {}) => createTranslator({ external }).push(e, { cancelledByClient });
