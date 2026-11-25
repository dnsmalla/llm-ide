import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../shell/tests/helpers.mjs";

const { defaultModelForMode, standardTierModel, nextDefaultModel } = await load("../chat/route.ts");
const groups = [{ id: "g", label: "G", catalog: false, models: [
  { provider: "p", model: "gpt-5", label: "GPT-5" },
  { provider: "p", model: "haiku-4", label: "Haiku" },
] }];

test("Ask/Document/Review prefer a cheap model; Plan/Execute prefer the strong one", () => {
  assert.equal(defaultModelForMode(groups, "ask")?.model, "haiku-4");
  assert.equal(defaultModelForMode(groups, "document")?.model, "haiku-4");
  assert.equal(defaultModelForMode(groups, "review")?.model, "haiku-4");
  assert.equal(defaultModelForMode(groups, "plan")?.model, "gpt-5");
  assert.equal(defaultModelForMode(groups, "execute")?.model, "gpt-5");
  assert.equal(defaultModelForMode(groups, "auto")?.model, "gpt-5");
});

test("no models returns null; no name hint returns the provider's first", () => {
  assert.equal(defaultModelForMode([], "ask"), null);
  const plain = [{ id: "g", label: "G", catalog: false, models: [{ provider: "p", model: "x", label: "X" }] }];
  assert.equal(defaultModelForMode(plain, "ask")?.model, "x");
});

const claude = [{ id: "c", label: "Claude", catalog: false, models: [
  { provider: "anthropic", model: "claude-opus-5-5", label: "Opus 5.5" },
  { provider: "anthropic", model: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { provider: "anthropic", model: "claude-haiku-5-5", label: "Haiku 5.5" },
] }];
const tiers = { tiers: { strong: { provider: "anthropic", model: "claude-opus-5-5" }, standard: { provider: "anthropic", model: "claude-sonnet-5-5" }, cheap: { provider: "anthropic", model: "claude-haiku-5-5" } } };

test("a new chat starts on the Standard tier's model in every mode", () => {
  for (const mode of ["ask", "document", "review", "plan", "execute", "auto"]) assert.equal(defaultModelForMode(claude, mode, tiers)?.model, "claude-sonnet-5-5", mode);
  assert.equal(defaultModelForMode(claude, "auto")?.model, "claude-opus-5-5", "without tiers the old rule still applies");
});

test("Standard is skipped when unset, not listed, or marked unavailable", () => {
  assert.equal(standardTierModel(null, claude), null);
  assert.equal(standardTierModel({ tiers: { cheap: { provider: "anthropic", model: "claude-haiku-5-5" } } }, claude), null);
  assert.equal(standardTierModel({ tiers: { standard: { provider: "anthropic", model: "nope" } } }, claude), null);
  const off = [{ id: "c", label: "C", catalog: false, models: [{ provider: "anthropic", model: "claude-sonnet-5-5", label: "S", unavailable: "x" }, { provider: "anthropic", model: "claude-haiku-5-5", label: "H" }] }];
  assert.equal(standardTierModel(tiers, off), null);
  assert.equal(defaultModelForMode(off, "auto", tiers)?.model, "claude-haiku-5-5", "falls back to the mode rule");
});

const none = { provider: null, model: null };
const opus = { provider: "anthropic", model: "claude-opus-5-5" };
const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5" };
const base = { groups: claude, mode: "auto", tiers: null, tiersLoaded: false, current: none, autoPicked: null, hasMessages: false };

test("before the tier answer a new chat starts at once on the mode rule", () => {
  assert.equal(nextDefaultModel(base)?.model, "claude-opus-5-5");
});

test("tiers arriving before any send move the auto pick to Standard's model", () => {
  const first = nextDefaultModel(base);
  const next = nextDefaultModel({ ...base, tiers, tiersLoaded: true, current: first, autoPicked: first });
  assert.equal(next?.model, "claude-sonnet-5-5");
  assert.equal(nextDefaultModel({ ...base, tiers, tiersLoaded: true, current: sonnet, autoPicked: sonnet }), null, "settled");
  assert.equal(nextDefaultModel({ ...base, tiers, tiersLoaded: true })?.model, "claude-sonnet-5-5", "tiers already in: straight to Standard");
});

test("tiers arriving after the first send leave the model unchanged", () => {
  assert.equal(nextDefaultModel({ ...base, tiers, tiersLoaded: true, current: opus, autoPicked: opus, hasMessages: true }), null);
});

test("a user-picked model is never overridden", () => {
  const haiku = { provider: "anthropic", model: "claude-haiku-5-5" };
  assert.equal(nextDefaultModel({ ...base, tiers, tiersLoaded: true, current: haiku, autoPicked: null }), null);
  assert.equal(nextDefaultModel({ ...base, tiers, tiersLoaded: true, current: haiku, autoPicked: opus }), null, "differs from the auto pick");
});
