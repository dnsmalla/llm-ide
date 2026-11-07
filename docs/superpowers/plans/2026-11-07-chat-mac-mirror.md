# Chat Mirrors the Mac Code Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop chat lists every provider the chat can run and shows the chosen provider and model. It also gets back the context meter and lays out the window and its controls like the retired Mac Code Assistant.

**Architecture:** UI only, in `ui/screens/chat/`. No core route, no host command, no migration. Task 1 fixes the model listing in `loadModelGroups` (`route.ts`). It also reads `GET /kb/providers/custom`, a route that has served since API 99. Tasks 2-10 port one Mac element each. Each task adds a pure function with a test where there is logic, and wires it into the existing component. Static-render tests use `renderToStaticMarkup`, and source assertions cover wiring that static render cannot reach.

**Tech Stack:** React 18 + TypeScript (desktop webview), Node test runner with the esbuild bundle in `ui/screens/chat/tests/helpers.mjs`, design tokens from `ui/kit` (`--tok-*`). **No new dependency.**

**Spec:** `docs/superpowers/plans/parity-inventory/chat-mac-vs-desktop-2026-11-07.md` (element table and the root cause of the provider bug). It builds on `docs/superpowers/plans/parity-inventory/chat-triage.md` and the MASTER-PLAN S2 row "Chat desktop gap list". The standing user decision is that the desktop mirrors the Mac's look and functions.

## Global Constraints

- **UI only.** No change under `extension/`, `desktop/src-tauri/`, `schema/`. `SERVER_API_VERSION` stays **121**. 122 is reserved for Self-Heal plan B. A later item that needs a core route uses **123** and follows the API bump checklist (`extension/server.mjs` `SERVER_API_VERSION` + `ALL_ENDPOINTS`, `ui/screens/shell/core-api-floor.ts`, regenerated `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md`).
- **Token-affecting behaviour stays off by default.** Nothing in this plan sends a turn the user did not send. Suggestions fill the draft and never send. The ghost prediction only fills the draft.
- **No new dependency.** Respect `ui/kit` and the design tokens: colours only through `var(--tok-color-*)`, sizes through `var(--tok-space-*)` / `var(--tok-type-*)`. The source-rules test (`tests/components.test.mjs`, "no … inline colours") must keep passing.
- Text from the core (model ids, provider names, `detail`) is rendered as text, never as HTML.
- Tests: `cd desktop && node --test ../ui/screens/chat/tests/<file>`; types: `cd desktop && npx tsc --noEmit -p .` (no output = pass).
- Conventional Commits on `main`, one concern per commit, **not pushed**. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Implementer subagents must not spawn subagents.
- Parallel work: `docs/superpowers/plans/2026-11-07-ended-chat-continuation.md` may touch `ui/screens/chat/**`. Rebase before each task. Every edit below names its exact anchor text, so a moved line is found by its text, not its number.

Baseline at `2993d1a3`: `cd desktop && node --test ../ui/screens/chat/tests/*.test.mjs` → `# tests 346`, `# pass 346`, `# fail 0`. After all tasks: `# tests 374`, `# fail 0`.
I ran every step of this plan against a copy of `ui/` (tests and `tsc` green). It was not run in a real window.

---

### Task 1: List every provider the chat can run (20 min)

**The bug.** The picker shows only Claude, and the catalog connections that have a key:
- Claude-compatible endpoints (`GET /kb/providers/custom`) are never asked for, and `/kb/providers/catalog` leaves them out on purpose (`extension/routes/provider-catalog.mjs:52`).
- Keyless local connections are filtered out (`route.ts:263`).
- An empty Claude list drops the core's `detail` (`route.ts:249-253`).

**Files:**
- Modify: `ui/screens/chat/route.ts:241-280` (`SdkModelEntry` … end of `loadModelGroups`)
- Test: `ui/screens/chat/tests/provider-groups.test.mjs` (create)

**Interfaces:**
- Consumes: `CoreTransport.json` (`transport.ts`), `ModelGroup` (`route.ts:49`).
- Produces: `loadModelGroups(core, signal?) → { groups: ModelGroup[]; toolsEnabled: boolean }`. The signature is unchanged. Claude is always `groups[0]` (`effortLevelsFor` and `addTargetGroup` rely on the first non-catalog group being Claude). Claude-compatible groups are `catalog: false` with `provider: "custom:ac-…"`.

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/provider-groups.test.mjs`:

```js
// The model picker lists every provider the chat can run, as the Mac's grouped menu did
// (CodeAssistantModelState+Providers.composerProviderSections, LlmIdeAPIClient+ProviderCatalog.refreshCatalogConnectionIndex).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("provider-groups"); });

const CLAUDE = { "POST /kb/providers/models": { models: ["claude-opus-5"], entries: [{ id: "claude-opus-5", displayName: "Opus 5" }] } };

test("a Claude-compatible endpoint connected in Settings is listed after Claude, with its live models", async () => {
  const core = fakeCore({ json: { ...CLAUDE,
    "GET /kb/providers/custom": { providers: [
      { id: "ac-glm", provider: "custom:ac-glm", name: "GLM", enabled: true, hasKey: true, source: "connection" },
      { id: "ac-off", provider: "custom:ac-off", name: "Off", enabled: false, hasKey: true, source: "connection" },
      { id: "ac-nokey", provider: "custom:ac-nokey", name: "No key", enabled: true, hasKey: false, source: "connection" },
      { id: "uuid-1", provider: "custom:uuid-1", name: "Mac synced", enabled: true, hasKey: true, source: "synced" }] },
    "POST /kb/providers/catalog/models": (body) => body.id === "ac-glm" ? { models: [{ id: "glm-5", toolsSupported: true }] } : { models: [] },
    "GET /kb/providers/catalog": { settings: { toolsEnabled: false }, providers: [] },
  } });
  const { groups } = await c.loadModelGroups(core);
  assert.deepEqual(groups.map((g) => g.id), ["anthropic", "ac-glm"], "Claude stays first; disabled, keyless and synced rows are not listed");
  assert.deepEqual(groups[1], { id: "ac-glm", label: "GLM", catalog: false, provider: "custom:ac-glm", models: [{ provider: "custom:ac-glm", model: "glm-5", label: "glm-5" }] });
  assert.equal(c.providerCannotChat("custom:ac-glm", groups), false, "a chat on it is no longer reported as blocked");
});

test("a keyless local catalog connection (keyRequired false) is listed; a keyed one without its key is not", async () => {
  const core = fakeCore({ json: { ...CLAUDE,
    "GET /kb/providers/catalog": { settings: { toolsEnabled: true }, providers: [
      { id: "ollama", name: "Ollama", keyRequired: false, connections: [{ id: "cat-ollama", provider: "custom:cat-ollama", name: "", enabled: true, hasKey: false }] },
      { id: "openai", name: "OpenAI", keyRequired: true, connections: [{ id: "cat-openai", provider: "custom:cat-openai", name: "OpenAI", enabled: true, hasKey: false }] }] },
    "POST /kb/providers/catalog/models": { models: [{ id: "llama3", toolsSupported: false }] },
  } });
  const { groups } = await c.loadModelGroups(core);
  assert.deepEqual(groups.map((g) => [g.id, g.label]), [["anthropic", "Claude"], ["cat-ollama", "Ollama"]]);
  assert.deepEqual(groups[1].models, [{ provider: "custom:cat-ollama", model: "llama3", label: "llama3", toolsSupported: false }]);
});

test("an empty Claude list says why (the core's detail) instead of showing a bare Default", async () => {
  const core = fakeCore({ json: { "POST /kb/providers/models": { models: [], detail: "no API key configured" } } });
  const { groups } = await c.loadModelGroups(core);
  assert.equal(groups[0].note, "The model list is unavailable: no API key configured");
  const quiet = await c.loadModelGroups(fakeCore({ json: { "POST /kb/providers/models": { models: [] } } }));
  assert.equal(quiet.groups[0].note, "The model list is unavailable.");
});

test("an abort while listing rethrows instead of returning a partial list", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(c.loadModelGroups(fakeCore({ json: CLAUDE }), ac.signal), /aborted/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/provider-groups.test.mjs`
Expected: `# pass 1`, `# fail 3`. Tests 1-3 fail, and the abort test passes, because it guards behaviour that already exists.

- [ ] **Step 3: Implement** — in `ui/screens/chat/route.ts`, replace everything from `interface SdkModelEntry {` up to the closing `}` of `loadModelGroups` (just before `/**\n * Whether the progress header shows`) with:

```ts
interface SdkModelEntry { id: string; displayName?: string; name?: string; effortLevels?: string[] }
interface CatalogProvider { id: string; name: string; keyRequired?: boolean; connections: Array<{ id: string; provider: string; name: string; enabled: boolean; hasKey: boolean }> }
/** GET /kb/providers/custom rows: Claude-compatible endpoints (`connection` = connected in Settings, `synced` = the retired Mac's list). */
interface ClaudeCompatible { id: string; provider: string; name: string; enabled: boolean; hasKey: boolean; source: "connection" | "synced" }

/** One connection's models as a group (POST /kb/providers/catalog/models); a failed listing is a note, an abort rethrows. */
async function connectionGroup(core: CoreTransport, c: { id: string; provider: string; name: string }, catalog: boolean, signal?: AbortSignal): Promise<ModelGroup> {
  const base = { id: c.id, label: c.name, catalog, provider: c.provider };
  try {
    const m = await core.json<{ models?: Array<{ id: string; toolsSupported?: boolean }> }>("POST", "/kb/providers/catalog/models", { id: c.id }, signal);
    return { ...base, models: (m.models ?? []).map((x) => ({ provider: c.provider, model: x.id, label: x.id, ...(catalog ? { toolsSupported: x.toolsSupported === true } : {}) })) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ...base, models: [], note: "Could not list models." };
  }
}

/**
 * Every provider the chat can run, in the Mac's menu order (CodeAssistantModelState.composerProviderSections): Claude (the
 * SDK's live list, always first), the Claude-compatible endpoints connected in Settings, then one group per enabled
 * catalog connection that has a key or needs none (a local server).
 */
export async function loadModelGroups(core: CoreTransport, signal?: AbortSignal): Promise<{ groups: ModelGroup[]; toolsEnabled: boolean }> {
  const groups: ModelGroup[] = [];
  try {
    const r = await core.json<{ models?: string[]; entries?: SdkModelEntry[]; detail?: string }>("POST", "/kb/providers/models", { provider: "anthropic" }, signal);
    const entries: SdkModelEntry[] = r.entries ?? (r.models ?? []).map((id) => ({ id }));
    groups.push({
      id: "anthropic", label: "Claude", catalog: false, provider: "anthropic",
      models: entries.map((e) => ({ provider: "anthropic", model: e.id, label: e.displayName ?? e.name ?? e.id, effortLevels: Array.isArray(e.effortLevels) ? e.effortLevels.filter((l): l is string => typeof l === "string" && l.length > 0) : [] })),
      // The core answers 200 with no models and a reason when the SDK and the key listing both fail: say why.
      ...(entries.length === 0 ? { note: r.detail ? `The model list is unavailable: ${r.detail}` : "The model list is unavailable." } : {}),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    groups.push({ id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [], note: "The model list is unavailable." });
  }
  try {
    const cc = await core.json<{ providers?: ClaudeCompatible[] }>("GET", "/kb/providers/custom", undefined, signal);
    // shortcut: `synced` rows (the retired Mac's list) carry no model list on this route; listed once the core serves one.
    for (const c of (cc.providers ?? []).filter((x) => x.source === "connection" && x.enabled && x.hasKey)) groups.push(await connectionGroup(core, c, false, signal));
  } catch (e) {
    if (signal?.aborted) throw e; // older core without the route: no Claude-compatible groups
  }
  let toolsEnabled = false;
  try {
    const cat = await core.json<{ providers?: CatalogProvider[]; settings?: { toolsEnabled?: boolean } }>("GET", "/kb/providers/catalog", undefined, signal);
    toolsEnabled = cat.settings?.toolsEnabled === true;
    for (const p of cat.providers ?? []) {
      for (const c of p.connections.filter((x) => x.enabled && (x.hasKey || p.keyRequired === false))) {
        groups.push(await connectionGroup(core, { ...c, name: c.name || p.name }, true, signal));
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e; // catalog unavailable: Claude only
  }
  return { groups, toolsEnabled };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/provider-groups.test.mjs ../ui/screens/chat/tests/store-route.test.mjs ../ui/screens/chat/tests/effort.test.mjs ../ui/screens/chat/tests/model-additions.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0` and no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/route.ts ui/screens/chat/tests/provider-groups.test.mjs
git commit -m "$(cat <<'EOF'
fix(chat): list Claude-compatible and local providers in the model picker

The picker read only /kb/providers/catalog, which leaves out Claude-compatible
endpoints, and dropped keyless local connections. A chat on such a provider
showed as unlisted and blocked. An empty Claude list now shows the core's reason.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The closed picker names the provider and the model (15 min)

The Mac's composer chip named the model the next turn sends (`ChatComposer.swift:670-681`). The desktop's closed select shows only the model's name, so a GLM model and a catalog model with the same id look the same. The menu's "More providers: Settings → Providers" row is also missing (`ComposerCatalog.swift:64`).

**Files:**
- Modify: `ui/screens/chat/route.ts` (insert before `/** The select's empty option:`, line 179)
- Modify: `ui/screens/chat/Pickers.tsx:7-9` (import), `:54-62` (options), `:66` (hint)
- Modify: `ui/screens/chat/tests/review-fixes.test.mjs:175`, `:177` (the chosen option now names its provider)
- Test: `ui/screens/chat/tests/model-chip.test.mjs` (create)

**Interfaces:**
- Produces: `modelOptionText(g: Pick<ModelGroup,"label"|"catalog">, m: Pick<ModelChoice,"label"|"toolsSupported">, chosen: boolean): string`; `MORE_PROVIDERS_HINT: string`.

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/model-chip.test.mjs`:

```js
// The closed model picker names the provider and the model (the Mac's composer chip), and says where more
// providers come from while only Claude is set up (ComposerCatalog.moreProvidersHint).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("model-chip"); });

const noop = () => {};
const CLAUDE = { id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [{ provider: "anthropic", model: "claude-a", label: "Claude A" }] };
const GROQ = { id: "cat-groq", label: "Groq", catalog: true, provider: "custom:cat-groq", models: [{ provider: "custom:cat-groq", model: "llama", label: "llama", toolsSupported: true }, { provider: "custom:cat-groq", model: "tiny", label: "tiny", toolsSupported: false }] };
const selected = (out) => /<option value="([^"]*)" selected="">([^<]*)</.exec(out)?.slice(1, 3) ?? null;
const picker = (props) => html(h(c.ModelPicker, { groups: [CLAUDE, GROQ], provider: "custom:cat-groq", model: "llama", onChange: noop, ...props }));

test("the chosen option carries its provider; the other options keep the bare name and the tools badge", () => {
  const out = picker({});
  assert.deepEqual(selected(out), ["custom:cat-groq|llama", "Groq · llama  (tools)"]);
  assert.match(out, /<option value="custom:cat-groq\|tiny">tiny  \(no tools\)<\/option>/);
  assert.match(out, /<option value="anthropic\|claude-a">Claude A<\/option>/);
});

test("modelOptionText is one string (one text node), chosen or not", () => {
  assert.equal(c.modelOptionText(CLAUDE, CLAUDE.models[0], true), "Claude · Claude A");
  assert.equal(c.modelOptionText(CLAUDE, CLAUDE.models[0], false), "Claude A");
  assert.equal(c.modelOptionText(GROQ, { label: "x" }, true), "Groq · x", "no badge without a known tools flag");
});

test("only Claude set up: the picker says where more providers come from; with another provider it does not", () => {
  assert.match(html(h(c.ModelPicker, { groups: [CLAUDE], provider: null, model: null, onChange: noop })), /More providers: Settings → Providers/);
  assert.doesNotMatch(picker({}), /More providers/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/model-chip.test.mjs`
Expected: `# fail 3`: the chosen option reads `llama  (tools)`, `c.modelOptionText is not a function`, and there is no hint.

- [ ] **Step 3: Implement**

In `ui/screens/chat/route.ts`, insert directly before `/** The select's empty option: "Default" with the router off`:

```ts
/**
 * One model option's text. The chosen one names its provider ("Groq · llama-3"), so the closed picker shows the
 * provider and the model as the Mac's composer chip does; the open list keeps the bare name under its group. Pure.
 */
export function modelOptionText(g: Pick<ModelGroup, "label" | "catalog">, m: Pick<ModelChoice, "label" | "toolsSupported">, chosen: boolean): string {
  const badge = g.catalog && m.toolsSupported !== undefined ? `  (${toolsBadge(m.toolsSupported)})` : "";
  return `${chosen ? `${g.label} · ` : ""}${m.label}${badge}`;
}
/** The Mac's one row at the bottom of the menu while only Claude is set up (ComposerCatalog.moreProvidersHint). */
export const MORE_PROVIDERS_HINT = "More providers: Settings → Providers";

```

In `ui/screens/chat/Pickers.tsx`, replace the second import line from `./route`:

```ts
  meterText, modelDefaultLabel, modelPickerValue, parseLimit, plainChatDetail, raisedLimit, toolsBadge, type ModelGroup, type ModelPickerRoute, type PermissionMode, type PlainChatReason, type RouteView,
```

with:

```ts
  MORE_PROVIDERS_HINT, meterText, modelDefaultLabel, modelOptionText, modelPickerValue, parseLimit, plainChatDetail, raisedLimit, type ModelGroup, type ModelPickerRoute, type PermissionMode, type PlainChatReason, type RouteView,
```

Replace the option body:

```tsx
                  {m.label}{g.catalog && m.toolsSupported !== undefined ? `  (${toolsBadge(m.toolsSupported)})` : ""}
```

with:

```tsx
                  {modelOptionText(g, m, value === `${m.provider}|${m.model}`)}
```

After the line `{groups.filter((g) => g.note).map((g) => <span key={g.id} className="chat-muted">{g.label}: {g.note}</span>)}`, add:

```tsx
      {groups.length > 0 && groups.every((g) => g.id === "anthropic") && <span className="chat-muted">{MORE_PROVIDERS_HINT}</span>}
```

In `ui/screens/chat/tests/review-fixes.test.mjs`, the chosen option now names its provider. Replace `["anthropic|claude-b", "Claude B"]);` with `["anthropic|claude-b", "Claude · Claude B"]);`, and `["anthropic|claude-a", "Claude A"]);` with `["anthropic|claude-a", "Claude · Claude A"]);`.

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/model-chip.test.mjs ../ui/screens/chat/tests/review-fixes.test.mjs ../ui/screens/chat/tests/components.test.mjs ../ui/screens/chat/tests/model-additions.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/route.ts ui/screens/chat/Pickers.tsx ui/screens/chat/tests/model-chip.test.mjs ui/screens/chat/tests/review-fixes.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): name the provider of the chosen model in the picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Restore the context meter in the composer bar (25 min)

`6669e115` removed the "Context N%" chip. Since then `state.context` (`state.ts:425-426`) is rendered nowhere. The Mac showed a ring and the percentage next to the send button. Its popover listed the SDK's categories with their share, "used" rows first, and it turned to the warning colour from 80% (`ChatComposer.swift:741-818`, `ContextUsagePresentation.swift`).

**Files:**
- Create: `ui/screens/chat/context-meter.ts`, `ui/screens/chat/ContextMeter.tsx`
- Modify: `ui/screens/chat/ChatScreen.tsx:13` (import), `:375` (pass `meter`)
- Modify: `ui/screens/chat/chat.css` (append)
- Modify: `ui/screens/chat/tests/entry.ts:16`
- Test: `ui/screens/chat/tests/context-meter.test.mjs` (create)

**Interfaces:**
- Consumes: `ChatState.context` (`state.ts:98`), `ContextCategory` (`events.ts:6`), `ComposerProps.meter` (`Composer.tsx:28`).
- Produces: `ContextUsage`, `CONTEXT_WARN_PERCENT`, `contextWarns`, `contextPercentLabel`, `contextTokensLabel`, `contextRows`, `contextShare` (`context-meter.ts`); `ContextMeter({ usage }: { usage: ContextUsage | null })` (`ContextMeter.tsx`).

- [ ] **Step 1: Write the failing test** — in `ui/screens/chat/tests/entry.ts` replace `export * from "../Pickers";` with:

```ts
export * from "../Pickers";
export * from "../context-meter";
export * from "../ContextMeter";
```

and create `ui/screens/chat/tests/context-meter.test.mjs`:

```js
// The composer's context ring (the Mac's ChatComposer.contextUsageChip + ContextUsagePresentation), restored after
// 6669e115 dropped the "Context N%" chip and left state.context unrendered.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("context-meter"); });

const U = { totalTokens: 41250, maxTokens: 200000, percentage: 21, categories: [
  { name: "System prompt", kind: "used", tokens: 3200 }, { name: "Free space", kind: "free", tokens: 158750 }, { name: "Messages", kind: "used", tokens: 38050 }] };

test("labels and rows follow the Mac's ContextUsagePresentation", () => {
  assert.equal(c.contextPercentLabel(U), "21%");
  assert.equal(c.contextTokensLabel(U), "41,250 / 200,000 tokens");
  assert.deepEqual(c.contextRows(U).used.map((r) => r.name), ["System prompt", "Messages"], "used rows first, SDK order kept");
  assert.deepEqual(c.contextRows(U).other.map((r) => r.name), ["Free space"]);
  assert.equal(c.contextShare(U.categories[0], U), "1.6%");
  assert.equal(c.contextShare(U.categories[0], { ...U, maxTokens: 0 }), "–");
  assert.equal(c.contextWarns(U), false);
  assert.equal(c.contextWarns({ ...U, percentage: 80 }), true, "warning from 80 percent");
});

test("the meter renders nothing before a turn reports usage, and a ring with the percentage after", () => {
  assert.equal(html(h(c.ContextMeter, { usage: null })), "");
  const out = html(h(c.ContextMeter, { usage: U }));
  assert.match(out, /aria-label="Context used 21%"/);
  assert.match(out, /title="Context used: 41,250 \/ 200,000 tokens"/);
  assert.match(out, /<circle[^>]*stroke-dasharray=/);
  assert.doesNotMatch(out, /data-warn/);
  assert.match(html(h(c.ContextMeter, { usage: { ...U, percentage: 92 } })), /data-warn="true"/);
});

test("the chat screen hands the meter to the composer bar", () => {
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.match(screen, /meter=\{<ContextMeter usage=\{state\.context\} \/>\}/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/context-meter.test.mjs`
Expected: FAIL, all 3: the bundle cannot resolve `../context-meter`.

- [ ] **Step 3: Implement** — create `ui/screens/chat/context-meter.ts`:

```ts
// The composer's context-window meter, ported from the Mac (`ContextUsagePresentation`, `ChatComposer.contextUsageChip`).
// Pure: names and kinds are the SDK's own, so a category a newer SDK adds is listed as it arrives.
import type { ContextCategory } from "./events";

export interface ContextUsage { totalTokens: number; maxTokens: number; percentage: number; categories: readonly ContextCategory[] }

/** From this percentage the meter turns to the warning colour. */
export const CONTEXT_WARN_PERCENT = 80;

export const contextWarns = (u: ContextUsage): boolean => u.percentage >= CONTEXT_WARN_PERCENT;
export const contextPercentLabel = (u: ContextUsage): string => `${u.percentage}%`;
export const contextTokensLabel = (u: ContextUsage): string => `${u.totalTokens.toLocaleString("en-US")} / ${u.maxTokens.toLocaleString("en-US")} tokens`;

/** "used" rows first, then the rest (free space, buffers), each in the SDK's order. */
export function contextRows(u: ContextUsage): { used: ContextCategory[]; other: ContextCategory[] } {
  return { used: u.categories.filter((c) => c.kind === "used"), other: u.categories.filter((c) => c.kind !== "used") };
}

/** A category's share of the window with one decimal ("0.2%"); "–" without a window size. */
export function contextShare(c: ContextCategory, u: ContextUsage): string {
  return u.maxTokens > 0 ? `${((c.tokens / u.maxTokens) * 100).toFixed(1)}%` : "–";
}
```

Create `ui/screens/chat/ContextMeter.tsx`:

```tsx
// The Mac's context ring in the composer bar: a ring and the percentage of the last turn's context window; the
// popover lists the SDK's categories. Nothing until a turn has reported one (a new chat, an older core).
import { useState } from "react";
import { contextPercentLabel, contextRows, contextShare, contextTokensLabel, contextWarns, type ContextUsage } from "./context-meter";

const R = 5;
const RING = 2 * Math.PI * R;

export function ContextMeter({ usage }: { usage: ContextUsage | null }) {
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const rows = contextRows(usage);
  const filled = Math.min(1, Math.max(0, usage.percentage / 100)) * RING;
  const row = (c: ContextUsage["categories"][number], muted: boolean) => (
    <li key={`${c.kind}:${c.name}`} data-muted={muted || undefined}><span>{c.name}</span><span>{c.tokens.toLocaleString("en-US")}</span><span>{contextShare(c, usage)}</span></li>
  );
  return (
    <div className="chat-context" data-warn={contextWarns(usage) || undefined}>
      <button type="button" className="chat-context-chip" aria-label={`Context used ${contextPercentLabel(usage)}`} aria-haspopup="dialog" aria-expanded={open}
        title={`Context used: ${contextTokensLabel(usage)}`} onClick={() => setOpen((v) => !v)}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <circle cx="6" cy="6" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${filled} ${RING}`} transform="rotate(-90 6 6)" />
        </svg>
        <span>{contextPercentLabel(usage)}</span>
      </button>
      {open ? (
        <div role="dialog" aria-label="Context usage" className="chat-popover chat-context-popover" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
          <p className="chat-context-total">{contextTokensLabel(usage)}</p>
          <ul className="chat-context-list">{rows.used.map((c) => row(c, false))}</ul>
          {rows.other.length > 0 ? <ul className="chat-context-list">{rows.other.map((c) => row(c, true))}</ul> : null}
        </div>
      ) : null}
    </div>
  );
}
```

In `ui/screens/chat/ChatScreen.tsx`, after `import { MessageList } from "./MessageList";` add `import { ContextMeter } from "./ContextMeter";`. Then replace:

```tsx
              busy={busy} aborting={state.phase === "aborting"} queue={state.queue} history={history}
              memory={<>
```

with:

```tsx
              busy={busy} aborting={state.phase === "aborting"} queue={state.queue} history={history}
              meter={<ContextMeter usage={state.context} />}
              memory={<>
```

Append to `ui/screens/chat/chat.css`:

```css
.chat-context-chip { display: inline-flex; align-items: center; gap: var(--tok-space-xs); font: inherit; font-size: var(--tok-type-caption-size); font-variant-numeric: tabular-nums; color: var(--tok-color-text-muted); background: none; border: 0; padding: 0 var(--tok-space-xs); cursor: pointer; }
.chat-context[data-warn] .chat-context-chip { color: var(--tok-color-warning); }
.chat-context-popover { top: auto; bottom: calc(100% + 6px); right: 0; z-index: 20; }
.chat-context-total { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.chat-context-list li { display: grid; grid-template-columns: 1fr auto 48px; }
.chat-context-list li > span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.chat-context-list li[data-muted] { color: var(--tok-color-text-muted); }
```

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/context-meter.test.mjs ../ui/screens/chat/tests/components.test.mjs ../ui/screens/chat/tests/review-fixes.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/context-meter.ts ui/screens/chat/ContextMeter.tsx ui/screens/chat/ChatScreen.tsx ui/screens/chat/chat.css ui/screens/chat/tests/entry.ts ui/screens/chat/tests/context-meter.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): restore the context meter as the Mac's ring in the composer bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Composer bar in the Mac's order, pickers inside it (30 min)

The Mac kept one toolbar under the text field (`ChatComposer.swift:413-433`): Library/attach, subagents, model, permission, memory | context, ↵, voice, send. When the toolbar did not fit, it fell back to two rows (`:436-466`). The desktop puts Mode/Model/Effort/Permission in a separate row above the composer (`ChatScreen.tsx:360-370`). Its bar starts with Memory and Dictate (`Composer.tsx:173-176`).

**Files:**
- Modify: `ui/screens/chat/Composer.tsx:26-27` (props), `:173-186` (bar)
- Modify: `ui/screens/chat/ChatScreen.tsx:360-370` (row → notes), the `DraftComposer` props
- Modify: `ui/screens/chat/chat.css:66`, `:99` (remove `.chat-controls`), append
- Test: `ui/screens/chat/tests/composer-layout.test.mjs` (create)

**Interfaces:**
- Consumes: `ContextMeter` (Task 3; the `meter=` line is the anchor).
- Produces: `ComposerProps.controls?: ReactNode`.

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/composer-layout.test.mjs`:

```js
// The composer bar in the Mac's order (ChatComposer.toolbarSingleRow): Library/Attach, the pickers, memory, then
// at the right the context meter, the key hint, dictation, Stop and Send. The pickers left the row above the composer.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("composer-layout"); });

const noop = () => {};
const base = { draft: "hi", onDraft: noop, busy: true, aborting: false, queue: [], history: [], onSend: noop, onStop: noop, onDropQueued: noop, onAttach: noop };

test("bar order: Attach, controls, memory, spacer, meter, key hint, Stop, Send", () => {
  const out = html(h(c.Composer, { ...base,
    controls: h("span", { id: "ctl" }, "CTL"), memory: h("span", { id: "mem" }, "MEM"), meter: h("span", { id: "mtr" }, "MTR") }));
  const bar = out.slice(out.indexOf('class="chat-composer-bar"'));
  const at = (needle) => { const i = bar.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
  const order = [at('aria-label="Attach files"'), at('id="ctl"'), at('id="mem"'), at('class="chat-spacer"'), at('id="mtr"'), at('role="img"'), at('aria-label="Stop the running turn"'), at('type="submit"')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("the chat screen passes the pickers to the composer and keeps only the notices above it", () => {
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.doesNotMatch(screen, /className="chat-controls"/);
  const controls = screen.slice(screen.indexOf("controls={<>"), screen.indexOf("</>}", screen.indexOf("controls={<>")));
  for (const picker of ["<ModePicker", "<ModelPicker", "<EffortPicker", "<PermissionChip"]) assert.ok(controls.includes(picker), `${picker} is in the composer bar`);
  assert.match(screen, /<div className="chat-notes">[\s\S]*<PendingSwitchNote/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/composer-layout.test.mjs`
Expected: `# fail 2` (`missing id="ctl"`; `chat-controls` still present).

- [ ] **Step 3: Implement**

In `ui/screens/chat/Composer.tsx` replace:

```ts
  /** Bottom-bar leading control (session memory). */
  memory?: ReactNode;
```

with:

```ts
  /** The mode, model, effort and permission pickers: in the bottom bar after Library/Attach, as on the Mac. */
  controls?: ReactNode;
  /** Session memory, after the pickers (the Mac's memoryButton). */
  memory?: ReactNode;
```

Replace the start of the bar, from `      <div className="chat-composer-bar">` through `        <KeyHint />`:

```tsx
      <div className="chat-composer-bar">
        {p.memory}
        {voice ? <button type="button" className="chat-btn" aria-pressed={listening} onClick={toggleVoice} aria-label={listening ? "Stop dictation" : "Dictate a message"} title={`Dictate with the system speech recogniser (${dictationShortcutLabel()})`}>{listening ? "Listening…" : "Dictate"}</button> : null}
        {p.extras?.toolbar}
        {!p.extras?.toolbar && p.onAttach && <button type="button" className="chat-btn" onClick={p.onAttach} aria-label="Attach files">Attach</button>}
        {tooLong && <span role="alert" className="chat-error">Message is too long ({p.draft.length.toLocaleString("en-US")} of {MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters).</span>}
        {p.disabledReason && <span className="chat-muted">{p.disabledReason}</span>}
        {blocked && <span className="chat-muted" role="status">{blocked}</span>}
        <span className="chat-spacer" />
        {p.meter}
        <KeyHint />
```

with:

```tsx
      {/* The Mac's toolbar order (ChatComposer.toolbarSingleRow): context buttons, pickers, memory | meter, key hint, voice, send. */}
      <div className="chat-composer-bar">
        {p.extras?.toolbar}
        {!p.extras?.toolbar && p.onAttach && <button type="button" className="chat-btn" onClick={p.onAttach} aria-label="Attach files">Attach</button>}
        {p.controls}
        {p.memory}
        {tooLong && <span role="alert" className="chat-error">Message is too long ({p.draft.length.toLocaleString("en-US")} of {MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters).</span>}
        {p.disabledReason && <span className="chat-muted">{p.disabledReason}</span>}
        {blocked && <span className="chat-muted" role="status">{blocked}</span>}
        <span className="chat-spacer" />
        {p.meter}
        <KeyHint />
        {voice ? <button type="button" className="chat-btn" aria-pressed={listening} onClick={toggleVoice} aria-label={listening ? "Stop dictation" : "Dictate a message"} title={`Dictate with the system speech recogniser (${dictationShortcutLabel()})`}>{listening ? "Listening…" : "Dictate"}</button> : null}
```

In `ui/screens/chat/ChatScreen.tsx` replace:

```tsx
            <div className="chat-controls">
              <ModePicker value={current.mode} resolved={state.resolvedMode} onChange={(mode) => setCurrent({ mode })} />
              <ModelPicker groups={groups} provider={current.provider} model={current.model} plainChat={plain} route={route}
                onChange={pickModel} addGroup={addTargetGroup(groups, current.provider)} onAdd={addModel}
                userModels={userModels} onRemove={removeModel} />
              <EffortPicker levels={effortLevels} value={effectiveEffort(effortPick, effortLevels)} onChange={effortStore.set} />
              {modelNotice && <p className="chat-error" role="alert">{modelNotice}</p>}
              <ModelNotices kinds={modelNotices({ plainChat: plain, routerOn: route?.enabled, groups })} onAllowTools={() => void allowProviderTools()} />
              <PendingSwitchNote pending={route?.pending} />
              <PermissionChip value={permission} onChange={(m) => void changePermission(m)} />
            </div>
```

with:

```tsx
            <div className="chat-notes">
              {modelNotice && <p className="chat-error" role="alert">{modelNotice}</p>}
              <ModelNotices kinds={modelNotices({ plainChat: plain, routerOn: route?.enabled, groups })} onAllowTools={() => void allowProviderTools()} />
              <PendingSwitchNote pending={route?.pending} />
            </div>
```

and replace `              meter={<ContextMeter usage={state.context} />}` with:

```tsx
              meter={<ContextMeter usage={state.context} />}
              controls={<>
                <ModePicker value={current.mode} resolved={state.resolvedMode} onChange={(mode) => setCurrent({ mode })} />
                <ModelPicker groups={groups} provider={current.provider} model={current.model} plainChat={plain} route={route}
                  onChange={pickModel} addGroup={addTargetGroup(groups, current.provider)} onAdd={addModel}
                  userModels={userModels} onRemove={removeModel} />
                <EffortPicker levels={effortLevels} value={effectiveEffort(effortPick, effortLevels)} onChange={effortStore.set} />
                <PermissionChip value={permission} onChange={(m) => void changePermission(m)} />
              </>}
```

In `ui/screens/chat/chat.css` delete the two dead lines `.chat-controls { display: flex; … }` and `.chat-dock-mode .chat-controls { flex-wrap: wrap; }`, then append:

```css
.chat-composer-bar { flex-wrap: wrap; }
.chat-composer-bar .chat-pick-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.chat-notes { display: flex; flex-wrap: wrap; gap: var(--tok-space-sm); padding: 0 var(--tok-space-md); }
.chat-notes:empty { display: none; }
```

The picker labels are hidden only visually. Each select keeps its `aria-label` ("Mode", "Model", "Effort", "Permission mode").

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/*.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output (`components.test.mjs` still finds `aria-label="Mode"`, `"Model"` and `"Permission mode"`).

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/Composer.tsx ui/screens/chat/ChatScreen.tsx ui/screens/chat/chat.css ui/screens/chat/tests/composer-layout.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): move the pickers into the composer bar in the Mac's order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The header route chip names the pinned model (10 min)

The Mac's route chip showed `pinnedLabel ?? "Route"` and then the meter (`ChatRouteControl.swift:42-63`, `ChatRouteModel.swift:85-88`). The desktop chip shows only the meter (`Pickers.tsx:154`).

**Files:**
- Modify: `ui/screens/chat/route.ts` (insert before `/** One-click raise at the cap`, line 113)
- Modify: `ui/screens/chat/Pickers.tsx:7` (import), `:152-155` (button)
- Test: `ui/screens/chat/tests/route-chip.test.mjs` (create)

**Interfaces:**
- Produces: `capChipText(route: Pick<RouteView,"pinned"|"model"|"tokenLimit"|"used">): string`.

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/route-chip.test.mjs`:

```js
// The header route chip names the chat's pinned model, as the Mac's ChatRouteControl did ("Route" when unpinned).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("route-chip"); });

const used = (billable, cacheRead = 0) => ({ in: 0, out: 0, cacheWrite: 0, cacheRead, billable });

test("capChipText: pinned model or Route, then the meter once a limit is set or tokens were used", () => {
  assert.equal(c.capChipText({ pinned: false, model: "", tokenLimit: null, used: used(0) }), "Route");
  assert.equal(c.capChipText({ pinned: true, model: "glm-5", tokenLimit: null, used: used(0) }), "glm-5");
  assert.equal(c.capChipText({ pinned: true, model: "glm-5", tokenLimit: 50000, used: used(45000) }), "glm-5 · 45k / 50k");
  assert.equal(c.capChipText({ pinned: false, model: "x", tokenLimit: null, used: used(1200, 90000) }), "Route · 1.2k (+90k cached reads)");
});

test("the chip shows the pinned model and keeps its token-limit label", () => {
  const route = { enabled: true, capEnforced: true, chatSessionId: "a", provider: "custom:ac-glm", model: "glm-5", pinned: true, tokenLimit: 50000, used: used(45000), remaining: 5000, switchSeq: 1 };
  const out = html(h(c.CapChip, { route, onSetLimit: () => {} }));
  assert.match(out, />glm-5 · 45k \/ 50k<\/button>/);
  assert.match(out, /aria-label="Token limit 45k \/ 50k"/);
  assert.match(out, /title="This chat&#x27;s model and token limit"/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/route-chip.test.mjs`
Expected: `# fail 2` (`c.capChipText is not a function`; the button text is `45k / 50k`).

- [ ] **Step 3: Implement** — in `ui/screens/chat/route.ts`, insert before `/** One-click raise at the cap: 50 percent more`:

```ts
/**
 * The header route chip's text (the Mac's ChatRouteControl label): the pinned model, else "Route", then the meter once
 * a limit is set or tokens were used. Pure.
 */
export function capChipText(route: Pick<RouteView, "pinned" | "model" | "tokenLimit" | "used">): string {
  const name = route.pinned && route.model ? route.model : "Route";
  const used = route.used.billable;
  return route.tokenLimit !== null || used > 0 ? `${name} · ${meterText(used, route.tokenLimit, route.used.cacheRead)}` : name;
}

```

In `ui/screens/chat/Pickers.tsx` replace `CAP_APPROXIMATION_NOTE, CAP_COUNTED_NOTE,` (first import line from `./route`) with `CAP_APPROXIMATION_NOTE, CAP_COUNTED_NOTE, capChipText,`. Then in `CapChip` replace:

```tsx
        disabled={disabled} onClick={() => { setText(route.tokenLimit ? String(route.tokenLimit) : ""); setOpen(!open); }}>
        {meterText(used, route.tokenLimit, route.used.cacheRead)}
      </button>
```

with:

```tsx
        title="This chat's model and token limit" disabled={disabled} onClick={() => { setText(route.tokenLimit ? String(route.tokenLimit) : ""); setOpen(!open); }}>
        {capChipText(route)}
      </button>
```

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/route-chip.test.mjs ../ui/screens/chat/tests/components.test.mjs ../ui/screens/chat/tests/dock.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/route.ts ui/screens/chat/Pickers.tsx ui/screens/chat/tests/route-chip.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): show the pinned model on the header route chip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Each reply shows the mode it ran in (15 min)

The Mac drew a `ModeBadge` under "llm-agent" on every assistant turn. Auto and Execute were muted (`ChatMessageList.swift:783-789`, `ModeBadge.swift`). The desktop has a `ModeBadge` (`badges/Badges.tsx:10`) that nothing renders. Replies also do not keep their mode.

**Files:**
- Modify: `ui/screens/chat/state.ts:57-58` (`AssistantMessage.mode`), `:371-373` (`mode_set`)
- Modify: `ui/screens/chat/MessageView.tsx:6` (import), `:161` (badge)
- Modify: `ui/screens/chat/chat.css` (append)
- Test: `ui/screens/chat/tests/mode-badge.test.mjs` (create)

**Interfaces:**
- Consumes: `ModeBadge({ mode, resolved })` (`badges/Badges.tsx:10`).
- Produces: `AssistantMessage.mode?: string` (live turns only; loaded history has none).

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/mode-badge.test.mjs`:

```js
// Each reply names the mode it ran in (the Mac's ModeBadge above an assistant turn), reusing badges/Badges.tsx.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("mode-badge"); });
const ev = (type, o = {}) => c.decodeEvent({ type, ...o }).event;

test("mode_set stamps the running reply with its mode", () => {
  let s = c.reduce(c.initialState("c1"), { type: "send", id: "t1", text: "plan it" });
  s = c.reduce(s, { type: "events", events: [ev("mode_set", { mode: "plan" }), ev("delta", { text: "ok" })] });
  assert.equal(s.messages.at(-1).mode, "plan");
  assert.equal(s.resolvedMode, "plan");
});

test("an assistant reply renders its mode badge after the role label; a reply without a mode shows none", () => {
  const m = { role: "assistant", id: "a1", parts: [], notices: [], status: "done", mode: "review" };
  assert.match(html(h(c.MessageView, { m, host: {} })), /llm-agent<\/span><span class="chat-badge" data-mode="review" aria-label="Mode: Code Review">Code Review<\/span>/);
  assert.doesNotMatch(html(h(c.MessageView, { m: { ...m, mode: undefined }, host: {} })), /chat-badge/);
});

test("Auto and Execute badges are muted, as on the Mac", () => {
  assert.match(readFileSync(join(CHAT, "chat.css"), "utf8"), /\.chat-assistant > \.chat-badge:is\(\[data-mode="auto"\], \[data-mode="execute"\]\)/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/mode-badge.test.mjs`
Expected: `# fail 3`.

- [ ] **Step 3: Implement**

In `ui/screens/chat/state.ts`, in `interface AssistantMessage`, after `usage?: UsageCounts;` add:

```ts
  /** The mode the server ran this reply in (`mode_set`), shown as the Mac's ModeBadge. Live turns only. */
  mode?: string;
```

and replace:

```ts
      case "mode_set":
        next.resolvedMode = ev.mode;
        break;
```

with:

```ts
      case "mode_set":
        next.resolvedMode = ev.mode;
        if (target) target.mode = ev.mode;
        break;
```

In `ui/screens/chat/MessageView.tsx`, after `import { Markdown } from "./MarkdownView";` add `import { ModeBadge } from "./badges/Badges";`. Then in `Assistant` replace `      <span className="chat-role">llm-agent</span>` with:

```tsx
      <span className="chat-role">llm-agent</span>
      {m.mode ? <ModeBadge mode={m.mode} resolved={null} /> : null}
```

Append to `ui/screens/chat/chat.css`:

```css
.chat-assistant > .chat-badge { display: inline-block; margin-bottom: var(--tok-space-xs); padding: 0 var(--tok-space-sm); border-radius: 999px; font-size: var(--tok-type-caption-size); font-weight: 600; text-transform: uppercase; color: var(--tok-color-accent); background: color-mix(in srgb, var(--tok-color-accent) 12%, transparent); }
.chat-assistant > .chat-badge:is([data-mode="auto"], [data-mode="execute"]) { color: var(--tok-color-text-muted); background: color-mix(in srgb, var(--tok-color-text-muted) 10%, transparent); }
```

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/mode-badge.test.mjs ../ui/screens/chat/tests/state.test.mjs ../ui/screens/chat/tests/plan.test.mjs ../ui/screens/chat/tests/components.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/state.ts ui/screens/chat/MessageView.tsx ui/screens/chat/chat.css ui/screens/chat/tests/mode-badge.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): show the mode each reply ran in, like the Mac's mode badge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Mac empty state and composer prompt (15 min)

The Mac showed "Code Assistant", one line and four suggestion chips that fill the draft (`ChatMessageList.swift:402-451`). Its prompt was "Ask Claude about the attached code…" (`ChatComposer.swift:265`). The desktop shows "Ask anything. Mode and model are below." (`ChatScreen.tsx:340`) and "Message" (`Composer.tsx:157`).

**Files:**
- Create: `ui/screens/chat/EmptyChat.tsx`
- Modify: `ui/screens/chat/ChatScreen.tsx` (import after `./ContextMeter`; `empty=` at line 340)
- Modify: `ui/screens/chat/Composer.tsx:33` (constant), `:157` (placeholder)
- Modify: `ui/screens/chat/chat.css` (append), `ui/screens/chat/tests/entry.ts`
- Test: `ui/screens/chat/tests/empty-chat.test.mjs` (create)

**Interfaces:**
- Produces: `EMPTY_SUGGESTIONS`, `EmptyChat({ onPick })` (`EmptyChat.tsx`); `COMPOSER_PLACEHOLDER` (`Composer.tsx`).

- [ ] **Step 1: Write the failing test** — in `ui/screens/chat/tests/entry.ts` replace `export * from "../ContextMeter";` with:

```ts
export * from "../ContextMeter";
export * from "../EmptyChat";
```

and create `ui/screens/chat/tests/empty-chat.test.mjs`:

```js
// An empty chat mirrors the Mac's emptyState: title, one line, four suggestions that fill (never send) the composer.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("empty-chat"); });

test("the empty state has the Mac's title, line and four suggestions", () => {
  const out = html(h(c.EmptyChat, { onPick: () => {} }));
  assert.match(out, /<h3 class="chat-empty-title">Code Assistant<\/h3>/);
  assert.match(out, /Attach context with the buttons below, then describe what you want\./);
  assert.deepEqual([...c.EMPTY_SUGGESTIONS], ["Review for bugs", "Refactor for readability", "Add unit tests", "Explain this code"]);
  for (const s of c.EMPTY_SUGGESTIONS) assert.match(out, new RegExp(`<button type="button" class="chat-suggestion">${s}</button>`));
});

test("a suggestion fills the draft through the controller's view and re-mounts the composer; it does not send", () => {
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.match(screen, /empty=\{<EmptyChat onPick=\{\(text\) => \{ controller\.setView\(activeId, \{ draft: text \}\); setRefineNonce\(\(n\) => n \+ 1\); \}\} \/>\}/);
});

test("the composer's empty-field prompt is the Mac's", () => {
  assert.equal(c.COMPOSER_PLACEHOLDER, "Ask Claude about the attached code…");
  const noop = () => {};
  const out = html(h(c.Composer, { draft: "", onDraft: noop, busy: false, aborting: false, queue: [], history: [], onSend: noop, onStop: noop, onDropQueued: noop }));
  assert.match(out, /placeholder="Ask Claude about the attached code…"/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/empty-chat.test.mjs`
Expected: FAIL, all 3: the bundle cannot resolve `../EmptyChat`.

- [ ] **Step 3: Implement** — create `ui/screens/chat/EmptyChat.tsx`:

```tsx
// An empty chat (the Mac's ChatMessageList.emptyState): the Code Assistant title, one line on what to do, and four
// quiet suggestions that fill the composer (never send).
export const EMPTY_SUGGESTIONS = ["Review for bugs", "Refactor for readability", "Add unit tests", "Explain this code"] as const;

export function EmptyChat({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="chat-empty-state">
      <h3 className="chat-empty-title">Code Assistant</h3>
      <p className="chat-muted">Attach context with the buttons below, then describe what you want.</p>
      <div className="chat-empty-suggestions" role="group" aria-label="Suggestions">
        {EMPTY_SUGGESTIONS.map((s) => <button key={s} type="button" className="chat-suggestion" onClick={() => onPick(s)}>{s}</button>)}
      </div>
    </div>
  );
}
```

In `ui/screens/chat/ChatScreen.tsx`, after `import { ContextMeter } from "./ContextMeter";` add `import { EmptyChat } from "./EmptyChat";`. Replace:

```tsx
              empty={<p className="chat-muted chat-pad">Ask anything. Mode and model are below.</p>}
```

with:

```tsx
              empty={<EmptyChat onPick={(text) => { controller.setView(activeId, { draft: text }); setRefineNonce((n) => n + 1); }} />}
```

In `ui/screens/chat/Composer.tsx`, before `/** Longest message the composer accepts` add:

```ts
/** The Mac's empty-field prompt (ChatComposer.inputBar). */
export const COMPOSER_PLACEHOLDER = "Ask Claude about the attached code…";

```

and replace `placeholder={p.busy ? "Type to queue the next message" : "Message"}` with `placeholder={p.busy ? "Type to queue the next message" : COMPOSER_PLACEHOLDER}`.

Append to `ui/screens/chat/chat.css`:

```css
.chat-empty-state { display: grid; justify-items: center; align-content: center; gap: var(--tok-space-sm); min-height: 100%; padding: var(--tok-space-lg); text-align: center; }
.chat-empty-title { margin: 0; font-size: var(--tok-type-title-size); font-weight: 600; }
.chat-empty-suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--tok-space-sm); margin-top: var(--tok-space-xs); }
.chat-suggestion { font: inherit; font-size: var(--tok-type-caption-size); color: var(--tok-color-text-muted); background: var(--tok-color-surface); border: 1px solid var(--tok-color-border); border-radius: 999px; padding: var(--tok-space-xs) var(--tok-space-md); cursor: pointer; }
.chat-suggestion:hover { color: var(--tok-color-text); border-color: var(--tok-color-accent); }
```

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/empty-chat.test.mjs ../ui/screens/chat/tests/components.test.mjs ../ui/screens/chat/tests/dock.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/EmptyChat.tsx ui/screens/chat/ChatScreen.tsx ui/screens/chat/Composer.tsx ui/screens/chat/chat.css ui/screens/chat/tests/entry.ts ui/screens/chat/tests/empty-chat.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): Mac empty state with suggestions and the composer prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Header trash deletes the open chat (15 min)

The Mac header had a trash button. It deleted an empty chat at once and asked first when the chat had messages (`ChatSessionHeader.swift:192-213`). The desktop hides Delete in the ⋯ menu and always confirms (`DockHeader.tsx:77-98`). There is no trash glyph in `ui/kit` icons, so the button draws an inline SVG, as the memory chip does.

**Files:**
- Modify: `ui/screens/chat/DockHeader.tsx:41-44` (prop + pure rule), `:46` (signature), `:99` (button before New chat)
- Modify: `ui/screens/chat/ChatScreen.tsx:315` (pass `hasMessages`)
- Test: `ui/screens/chat/tests/header-delete.test.mjs` (create)

**Interfaces:**
- Produces: `DockHeaderProps.hasMessages?: boolean`; `deleteChatAction(hasMessages: boolean): "confirm" | "delete"`.

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/header-delete.test.mjs`:

```js
// The header trash deletes the open chat, asking first only when it has messages (the Mac's clearChatButton).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("header-delete"); });
const noop = () => {};
const props = { sessions: [{ id: "s1", title: "One", updatedAt: 1 }], activeId: "s1", busyIds: new Set(), route: null, routeDisabled: false, onSelect: noop, onNew: noop, onSetLimit: async () => {} };

test("an empty chat is deleted at once; a chat with messages asks first", () => {
  assert.equal(c.deleteChatAction(false), "delete");
  assert.equal(c.deleteChatAction(true), "confirm");
});

test("the trash is a named control only when a chat is open and can be deleted, before New chat", () => {
  const out = html(h(c.DockHeader, { ...props, onDelete: noop, hasMessages: true }));
  assert.ok(out.indexOf('aria-label="Delete current chat"') >= 0);
  assert.ok(out.indexOf('aria-label="Delete current chat"') < out.indexOf('aria-label="New chat"'));
  assert.doesNotMatch(html(h(c.DockHeader, props)), /Delete current chat/, "no onDelete, no trash");
  assert.doesNotMatch(html(h(c.DockHeader, { ...props, activeId: null, onDelete: noop })), /Delete current chat/);
});

test("the screen tells the header whether the open chat has messages", () => {
  assert.match(readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8"), /hasMessages=\{state\.messages\.length > 0\}/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/header-delete.test.mjs`
Expected: `# fail 3`.

- [ ] **Step 3: Implement** — in `ui/screens/chat/DockHeader.tsx` replace:

```ts
  onRename?: (title: string) => void;
  onDelete?: () => void;
}
```

with:

```ts
  onRename?: (title: string) => void;
  onDelete?: () => void;
  /** The open chat has messages: the header trash asks first (the Mac's clearChatButton); an empty chat goes at once. */
  hasMessages?: boolean;
}

/** What the header trash does (ChatSessionHeader.clearChatButton): an empty chat has nothing to lose. Pure. */
export const deleteChatAction = (hasMessages: boolean): "confirm" | "delete" => (hasMessages ? "confirm" : "delete");
```

Replace the signature line with:

```tsx
export function DockHeader({ sessions, activeId, busyIds, route, routeDisabled, meta, onSelect, onNew, onCollapse, onSetLimit, onRename, onDelete, hasMessages = false }: DockHeaderProps) {
```

Replace `      <button type="button" className="chat-dock-btn" aria-label="New chat" title="New chat" onClick={onNew}><Icon name="plus" size={13} /></button>` with:

```tsx
      {activeId && onDelete ? (
        <button type="button" className="chat-dock-btn" aria-label="Delete current chat" title="Delete current chat"
          onClick={() => { if (deleteChatAction(hasMessages) === "delete") onDelete(); else { setRenaming(false); setConfirm(true); setActions(true); } }}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ) : null}
      <button type="button" className="chat-dock-btn" aria-label="New chat" title="New chat" onClick={onNew}><Icon name="plus" size={13} /></button>
```

The confirm path reuses the ⋯ menu's existing confirmation, which already uses the Mac's copy (`DELETE_CHAT_TITLE`/`DELETE_CHAT_DETAIL`).

In `ui/screens/chat/ChatScreen.tsx` replace `          onDelete={() => activeId && deleteSession(activeId)}` with:

```tsx
          onDelete={() => activeId && deleteSession(activeId)} hasMessages={state.messages.length > 0}
```

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/header-delete.test.mjs ../ui/screens/chat/tests/dock.test.mjs ../ui/screens/chat/tests/parity-batch-a.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/DockHeader.tsx ui/screens/chat/ChatScreen.tsx ui/screens/chat/tests/header-delete.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): header trash deletes the open chat, asking only when it has messages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Esc stops a running turn from anywhere on the chat surface (10 min)

On the Mac, Stop was the window's cancel action (`ChatComposer.swift:539`). The desktop stops on Esc only while the textarea has focus (`Composer.tsx:166`).

**Files:**
- Modify: `ui/screens/chat/Composer.tsx` (pure rule before `export function nextRecall(`; effect before `const recall = useRef`)
- Test: `ui/screens/chat/tests/escape-stop.test.mjs` (create)

**Interfaces:**
- Produces: `stopsOnEscape(e: { key: string; defaultPrevented: boolean; isComposing?: boolean }, active: boolean, busy: boolean): boolean`.

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/escape-stop.test.mjs`:

```js
// Esc stops the running turn from anywhere on the chat surface, as the Mac's Stop (.cancelAction) did.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("escape-stop"); });
const esc = (o = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, ...o });

test("only a fresh Escape on the active surface during a turn stops it", () => {
  assert.equal(c.stopsOnEscape(esc(), true, true), true);
  assert.equal(c.stopsOnEscape(esc(), false, true), false, "another section is on screen");
  assert.equal(c.stopsOnEscape(esc(), true, false), false, "nothing is running");
  assert.equal(c.stopsOnEscape(esc({ defaultPrevented: true }), true, true), false, "the textarea or a popover already handled it");
  assert.equal(c.stopsOnEscape(esc({ isComposing: true }), true, true), false, "an input method owns the key");
  assert.equal(c.stopsOnEscape(esc({ key: "Enter" }), true, true), false);
});

test("the listener is bound only while active and busy, and removed after", () => {
  const src = readFileSync(join(CHAT, "Composer.tsx"), "utf8");
  assert.match(src, /if \(!p\.active \|\| !p\.busy\) return undefined;/);
  assert.match(src, /return \(\) => window\.removeEventListener\("keydown", onKey\);\n  \}, \[p\.active, p\.busy\]\);/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/escape-stop.test.mjs`
Expected: `# fail 2`.

- [ ] **Step 3: Implement** — in `ui/screens/chat/Composer.tsx`, insert before `export function nextRecall(`:

```ts
/**
 * Esc stops a running turn from anywhere on the chat surface (the Mac's Stop button is the window's cancel action).
 * A key a popover, the textarea or an input method already handled is left alone. Pure.
 */
export function stopsOnEscape(e: { key: string; defaultPrevented: boolean; isComposing?: boolean }, active: boolean, busy: boolean): boolean {
  return active && busy && e.key === "Escape" && !e.defaultPrevented && e.isComposing !== true;
}

```

and replace `  const recall = useRef<number | null>(null);` with:

```tsx
  const stopRef = useRef(p.onStop);
  stopRef.current = p.onStop;
  useEffect(() => {
    if (!p.active || !p.busy) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => { if (stopsOnEscape(e, true, true)) { e.preventDefault(); stopRef.current(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.active, p.busy]);

  const recall = useRef<number | null>(null);
```

The textarea's own Esc handler calls `preventDefault`, so a focused textarea does not stop twice. Popovers call `stopPropagation`, so their Esc never reaches `window`.

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/escape-stop.test.mjs ../ui/screens/chat/tests/components.test.mjs ../ui/screens/chat/tests/review-fixes.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/Composer.tsx ui/screens/chat/tests/escape-stop.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): Esc stops the running turn from anywhere on the chat surface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Ghost prediction from sent prompts (20 min)

While typing, the Mac predicted the newest sent prompt that extends the draft. Tab accepted it, and Esc hid it for that draft (`ChatComposer.swift:289`, `:1021-1027`). A textarea cannot draw inline ghost text, so the desktop shows the prediction on one muted line above the bar. It only fills the draft and never sends.

**Files:**
- Modify: `ui/screens/chat/Composer.tsx` (pure function before `export function nextRecall(`; state after `const recall = useRef`; keys after `p.extras?.onKeyDown`; line before the bar)
- Modify: `ui/screens/chat/chat.css` (append)
- Test: `ui/screens/chat/tests/ghost-suggestion.test.mjs` (create)

**Interfaces:**
- Produces: `promptSuggestion(draft: string, history: readonly string[], recalling: boolean): string | null`.

- [ ] **Step 1: Write the failing test** — create `ui/screens/chat/tests/ghost-suggestion.test.mjs`:

```js
// The Mac's ghost prediction: the newest sent prompt that extends the draft; Tab accepts it, Esc hides it for this draft.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("ghost-suggestion"); });
const noop = () => {};

test("promptSuggestion: newest extending prompt; none for an empty draft, while recalling, or for an exact repeat", () => {
  const hist = ["fix the login bug", "fix the build", "explain"];
  assert.equal(c.promptSuggestion("fix the", hist, false), "fix the build", "the newest match wins");
  assert.equal(c.promptSuggestion("fix the l", hist, false), "fix the login bug");
  assert.equal(c.promptSuggestion("", hist, false), null);
  assert.equal(c.promptSuggestion("fix the", hist, true), null);
  assert.equal(c.promptSuggestion("explain", hist, false), null, "the draft already is that prompt");
  assert.equal(c.promptSuggestion("zzz", hist, false), null);
});

test("the composer shows the prediction above its bar", () => {
  const out = html(h(c.Composer, { draft: "fix the", onDraft: noop, busy: false, aborting: false, queue: [], history: ["fix the build"], onSend: noop, onStop: noop, onDropQueued: noop }));
  assert.match(out, /<p class="chat-muted chat-ghost" role="status">Tab: fix the build<\/p>/);
});

test("Tab accepts after the slash menu had its turn; Esc hides it only while idle (Stop wins during a turn)", () => {
  const src = readFileSync(join(CHAT, "Composer.tsx"), "utf8");
  const menu = src.indexOf("if (p.extras?.onKeyDown(e)) return;");
  const tab = src.indexOf('if (e.key === "Tab" && !e.shiftKey && ghost) { e.preventDefault(); p.onDraft(ghost); return; }');
  const esc = src.indexOf('if (e.key === "Escape" && ghost && !p.busy) { e.preventDefault(); setGhostOffFor(p.draft); return; }');
  assert.ok(menu >= 0 && tab > menu && esc > tab);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test ../ui/screens/chat/tests/ghost-suggestion.test.mjs`
Expected: `# fail 3`.

- [ ] **Step 3: Implement** — in `ui/screens/chat/Composer.tsx`, insert before `export function nextRecall(`:

```ts
/**
 * The Mac's ghost prediction (ChatComposer.promptSuggestion): the newest sent prompt that extends the draft. None for
 * an empty draft, while recalling history, or when it would only repeat the draft. Pure.
 */
export function promptSuggestion(draft: string, history: readonly string[], recalling: boolean): string | null {
  if (!draft || recalling) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h !== draft && h.startsWith(draft)) return h;
  }
  return null;
}

```

Replace `  const recall = useRef<number | null>(null);` with:

```tsx
  const recall = useRef<number | null>(null);
  // An Esc-dismissed prediction stays dismissed only for the draft it was dismissed on.
  const [ghostOffFor, setGhostOffFor] = useState<string | null>(null);
  const ghost = ghostOffFor === p.draft || p.extras?.menu ? null : promptSuggestion(p.draft, p.history, recall.current !== null);
```

Replace `          if (p.extras?.onKeyDown(e)) return;` with:

```tsx
          if (p.extras?.onKeyDown(e)) return;
          if (e.key === "Tab" && !e.shiftKey && ghost) { e.preventDefault(); p.onDraft(ghost); return; }
          if (e.key === "Escape" && ghost && !p.busy) { e.preventDefault(); setGhostOffFor(p.draft); return; }
```

Replace `      <div className="chat-composer-bar">` with:

```tsx
      {ghost ? <p className="chat-muted chat-ghost" role="status">Tab: {ghost}</p> : null}
      <div className="chat-composer-bar">
```

Append to `ui/screens/chat/chat.css`:

```css
.chat-ghost { margin: 0; padding: 0 var(--tok-space-sm); font-size: var(--tok-type-caption-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Run the tests**

Run: `cd desktop && node --test ../ui/screens/chat/tests/ghost-suggestion.test.mjs ../ui/screens/chat/tests/slash.test.mjs ../ui/screens/chat/tests/components.test.mjs && npx tsc --noEmit -p .`
Expected: `# fail 0`, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/Composer.tsx ui/screens/chat/chat.css ui/screens/chat/tests/ghost-suggestion.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): predict the next prompt from sent ones, Tab to accept

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Whole-suite check and docs (10 min)

**Files:**
- Modify: `docs/superpowers/MASTER-PLAN.md` (S2 row "Chat desktop gap list": add one sentence naming this plan and its commits)
- Modify: `docs/superpowers/plans/parity-inventory/chat-mac-vs-desktop-2026-11-07.md` (rows 1-4, 6, 13, 17, 28, 33, 39-41: status → same, with the commit hash)

- [ ] **Step 1: Run the whole chat suite and the type check**

Run: `cd desktop && node --test ../ui/screens/chat/tests/*.test.mjs && npx tsc --noEmit -p .`
Expected: `# tests 374`, `# fail 0`, no tsc output.

- [ ] **Step 2: Run the desktop tests and the pre-push gate**

Run: `cd desktop && npm test` then `make regression` (from the repo root)
Expected: both exit 0.

- [ ] **Step 3: Update the two docs** with the commit hashes from Tasks 1-10 (`git log --oneline -10`).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/MASTER-PLAN.md docs/superpowers/plans/parity-inventory/chat-mac-vs-desktop-2026-11-07.md
git commit -m "$(cat <<'EOF'
docs: record the chat Mac-mirror work in the gap report and master plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Real-window check (you).** Run `desktop/RUN-ON-MAC.md` and check these in the app:
  - The picker lists a connected Claude-compatible endpoint and a local server.
  - The closed picker reads "Provider · model".
  - The context ring appears after the first reply.
  - The pickers sit in the composer bar and wrap in the narrow dock.
  - The route chip names a pinned model.
  - Mode badges appear on replies.
  - The empty-chat suggestions fill the draft.
  - The trash button deletes the open chat.
  - Esc stops a turn while focus is in the message list.
  - Tab accepts a prediction.

---

## Later (not in this plan)

| Item | Gap row | Why later / what it needs |
|---|---|---|
| Mac-synced custom providers in the picker | 55 | `GET /kb/providers/custom` returns no model ids for `synced` rows. That needs a core change (API **123**, bump checklist). The Mac is retired, so only migrated installs have them. |
| Autonomous continue + "Stop autonomous agent" | 31 | It spends tokens without a send. It must be off by default, stop at the cap, on Stop and on any approval wait (chat-triage Batch B3). |
| Paste a screenshot as an image attachment | 24 | `attach/manager.ts` takes host file handles only, so pasted bytes need a host command for a temporary image. |
| Per-row Rename / Delete in the session dropdown | 16 | `DockHeader.tsx` rows are plain buttons. It needs a row component with its own confirmation. |
| Header "N files" count | 12 | It needs the attachment count lifted out of `slash/extras.tsx` into the screen. |
| Subagent chip in the composer bar | 11 | Move `SubagentChip` from `HeaderBadges` into the bar (`controls`). |
| Memory button shows last memory tokens | 10 | `state.memory.approxTokens` exists. It is a button label change once the session-vs-project memory split is settled. |
| Effort inside the model menu | 8 | Native `<select>` cannot hold a second section that acts differently. It waits for a custom menu component in `ui/kit`. |
| Last-turn tokens chip when no context report | 5 | The per-reply and header totals already show it. |
| Repeat-question save-to-memory nudge | 50 | A Rust write into the project memory folder, gated by Workspace Trust (chat-triage Batch B5). |

## Self-review

- Spec coverage: every gap row is a task (1-4, 6, 13, 17, 28, 33, 39-41) or a Later row (5, 8, 10-12, 16, 24, 31, 50, 55).
- Placeholders: none. Every code step carries its code. Every test step carries its test and the expected result.
- Names across tasks: `loadModelGroups`, `modelOptionText`, `MORE_PROVIDERS_HINT`, `ContextMeter`/`ContextUsage`, `controls`, `capChipText`, `AssistantMessage.mode`, `EmptyChat`/`EMPTY_SUGGESTIONS`/`COMPOSER_PLACEHOLDER`, `deleteChatAction`/`hasMessages`, `stopsOnEscape` and `promptSuggestion` are each defined once and used with the same signature.
- Order dependencies: Task 4 anchors on Task 3's `meter=` line. Task 7 anchors on Task 3's `ContextMeter` import and `entry.ts` line. Tasks 9 and 10 both anchor on `const recall = useRef`, and Task 10's anchor is still unique after Task 9.
