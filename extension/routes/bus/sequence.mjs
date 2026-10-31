// Pure check of one command's event sequence (docs/spec/command-bus.md 1.2/1.3): seq from 1 and gap-free, one command,
// exactly one terminal event and it is the last. `from` is the first seq a re-attached reader holds (after + 1). Used by the executor's tests and scripts/conformance-bus.mjs.
export function checkSequence(events, { complete = true, from = 1 } = {}) {
  if (!Array.isArray(events) || events.length === 0) return complete ? 'empty' : null;
  const cmd = events[0].cmd;
  let terminals = 0;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e.cmd !== cmd) return `mixed_commands at ${i}`;
    if (e.seq !== from + i) return `gap at index ${i} (seq ${e.seq})`;
    if (e.terminal) {
      terminals += 1;
      if (i !== events.length - 1) return `event after terminal at ${i}`;
    }
  }
  if (terminals > 1) return 'two_terminals';
  if (complete && terminals === 0) return 'no_terminal';
  return null;
}
