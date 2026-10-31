import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeInstalled, decodeCatalog, decodeItem } from "../decoders.ts";
import {
  catalogNeverFetched, consentLines, entryAction, flagText, groupItems, hasUpdate, orderKinds, outcomeText, reasonText, refreshSummary, repairText, repoName, sourceStatusText, trustLabel, validateInstallPath, validateInstallUrl,
} from "../presentation.ts";
import { fx } from "./helpers.ts";

const items = () => decodeInstalled(fx("get-auth-me-extensions-installed-200-2").response).items;

test("items group by kind in the fixed order, sorted by name", () => {
  const g = groupItems(items());
  assert.deepEqual(g.map((x) => x.kind), ["skill", "plugin"]);
  assert.deepEqual(g[1]?.items.map((i) => i.name), ["runner", "sketchy"]);
});

test("unknown kinds sort last", () => {
  const base = items()[0]!;
  const g = groupItems([{ ...base, kind: "zeta" }, { ...base, id: "x", kind: "skill" }, { ...base, id: "y", kind: "alpha" }]);
  assert.deepEqual(g.map((x) => x.kind), ["skill", "alpha", "zeta"]);
});

test("update badge needs a different latest commit", () => {
  const it = items()[0]!;
  assert.equal(hasUpdate(it), false);
  assert.equal(hasUpdate({ ...it, update: { latest: it.pinnedCommit, checkedAt: "x" } }), false);
  assert.equal(hasUpdate({ ...it, update: { latest: "f".repeat(40), checkedAt: "x" } }), true);
});

test("consent lines name each executable kind and what would run, from the item's own members", () => {
  const kinds = orderKinds(["lsp", "hook", "weird", "bin", "mcp"]);
  assert.deepEqual(kinds, ["hook", "mcp", "lsp", "bin", "weird"]);
  const lines = consentLines(["hook", "mcp"], [{ type: "hook", name: "Stop" }, { type: "hook", name: "Pre" }, { type: "skill", name: "a" }], [{ type: "hook", executable: true, text: "Runs commands automatically." }]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!.detail, /Shell commands that run on your machine/);
  assert.match(lines[0]!.detail, /Declared: Stop, Pre\./);
  assert.match(lines[0]!.detail, /Runs commands automatically\./);
  assert.match(lines[1]!.detail, /MCP servers/);
  assert.ok(!lines[1]!.detail.includes("Declared"));
});

test("a long member list is summarised, not dumped", () => {
  const members = Array.from({ length: 80 }, (_, i) => ({ type: "hook", name: `h${i}` }));
  const [line] = consentLines(["hook"], members, []);
  assert.match(line!.detail, /and 60 more/);
});

test("install address and folder validation mirror the server's rules", () => {
  assert.equal(validateInstallUrl("https://github.com/acme/tidy"), null);
  assert.equal(validateInstallUrl("https://github.com/acme/tidy.git"), null);
  for (const bad of ["", "http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://user@github.com/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b/tree/main", "git@github.com:a/b.git"]) assert.notEqual(validateInstallUrl(bad), null, bad);
  assert.equal(validateInstallPath(""), null);
  assert.equal(validateInstallPath("skills/pdf"), null);
  for (const bad of ["/etc", "../x", "a/../b", "a\\b", "a\nb", "./x"]) assert.notEqual(validateInstallPath(bad), null, bad);
});

test("catalog entries: installable, browse-only with a reason, already installed", () => {
  const page = decodeCatalog(fx("get-auth-me-extensions-catalog-200-2").response);
  const e = page.results[0]!;
  assert.deepEqual(entryAction(e), { installable: true, reason: null });
  assert.equal(entryAction({ ...e, installed: true }).installable, false);
  const browse = entryAction({ ...e, installable: false, reason: "registry_install_not_supported" });
  assert.equal(browse.installable, false);
  assert.match(browse.reason!, /MCP registry/);
  assert.match(reasonText("package_launcher"), /never run/);
  assert.match(reasonText("source_not_allowed"), /Extension sources/);
  assert.match(reasonText("odd"), /\(odd\)/);
  assert.equal(entryAction({ ...e, sourceUrl: undefined }).installable, false);
});

test("source status and refresh summary", () => {
  const page = decodeCatalog(fx("get-auth-me-extensions-catalog-200").response);
  assert.equal(catalogNeverFetched(page.sources), true);
  assert.equal(sourceStatusText(page.sources[0]!), "not fetched yet");
  assert.equal(catalogNeverFetched([]), false);
  const s = refreshSummary({ results: [{ id: "a", status: "refreshed" }, { id: "b", status: "throttled" }, { id: "c", status: "error", error: "upstream" }] });
  assert.match(s, /Refreshed 1 of 3/);
  assert.match(s, /1 skipped/);
  assert.match(s, /c \(upstream\)/);
});

test("outcome, repair, flag and misc text", () => {
  assert.match(outcomeText({ from: "e".repeat(40), to: "f".repeat(40), enabled: false, wasEnabled: true, kinds: ["hook"] }, "Updated"), /eeeeeeee to ffffffff\. It was switched off until you consent .*hook/);
  assert.equal(outcomeText({ from: "e".repeat(40), to: "f".repeat(40), enabled: true, wasEnabled: true, kinds: [] }, "Updated"), "Updated eeeeeeee to ffffffff.");
  assert.match(repairText({ status: "restored", was: "corrupt" }), /they were corrupt/);
  assert.match(repairText({ status: "ok" }), /nothing to repair/);
  assert.match(flagText("new_executable_kind"), /new kind of code/);
  assert.equal(flagText("zzz"), "zzz");
  assert.equal(trustLabel("official"), "Official");
  assert.equal(trustLabel("anything"), "Unverified");
  assert.equal(repoName("https://github.com/acme/tidy.git"), "acme/tidy");
  assert.equal(repoName("not a url"), "not a url");
  assert.equal(decodeItem(fx("post-auth-me-extensions-update-200").response && (fx("post-auth-me-extensions-update-200").response as { item: unknown }).item).version, "2.0.0");
});
