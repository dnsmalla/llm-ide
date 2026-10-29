// One kill switch per adopted SDK capability (agent-kit K1 plan 3.11):
// `LLMIDE_V2_ADOPT_<NAME>`. A capability that only ADDS visibility is on by
// default and `=0` restores the old behaviour; one that can change which
// model runs is off by default and `=1` opts in.
//
// Read per call, never cached at import: a test (or an operator restart-free
// toggle through the environment of a fresh process) sees the value now.
// `sdkSubprocessEnv` strips LLMIDE_*, so these never reach the SDK subprocess.

const OFF = new Set(['0', 'off', 'false', 'no']);
const ON = new Set(['1', 'on', 'true', 'yes']);

export function adoptEnabled(name, { defaultOn = true } = {}) {
  const raw = process.env[`LLMIDE_V2_ADOPT_${name}`];
  if (raw === undefined || raw === '') return defaultOn;
  const v = String(raw).trim().toLowerCase();
  if (defaultOn) return !OFF.has(v);
  return ON.has(v);
}
