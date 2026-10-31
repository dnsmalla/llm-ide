import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeInstalled } from "../decoders.ts";
import { HEADER_ROW_HEIGHT, ITEM_ROW_HEIGHT, browseWindow, fileWindow, flattenGroups, offsetsOf, rowAtOffset, rowIndexOf, stepItem, visibleRows } from "../list-model.ts";
import { fx } from "./helpers.ts";

const many = (n: number) => {
  const base = (fx("get-auth-me-extensions-installed-200-2").response as { items: Record<string, unknown>[] }).items[0]!;
  const kinds = ["skill", "plugin", "mcp", "llm-source"];
  return decodeInstalled({ corrupt: false, items: Array.from({ length: n }, (_, i) => ({ ...base, id: `${kinds[i % 4]}:o/n${i}`, kind: kinds[i % 4], name: `n${String(i).padStart(5, "0")}` })) }).items;
};

test("rows: one header per kind, then its items", () => {
  const rows = flattenGroups(many(8));
  assert.deepEqual(rows.filter((r) => r.kind === "header").map((r) => (r as { label: string }).label), ["Skills", "Plugins", "MCP servers", "Skill bundles"]);
  assert.equal(rows.length, 12);
  assert.equal(rows[0]?.kind, "header");
});

test("offsets are prefix sums of mixed heights and the binary search finds the row", () => {
  const rows = flattenGroups(many(8));
  const o = offsetsOf(rows);
  assert.equal(o[1], HEADER_ROW_HEIGHT);
  assert.equal(o[2], HEADER_ROW_HEIGHT + ITEM_ROW_HEIGHT);
  assert.equal(rowAtOffset(o, 0), 0);
  assert.equal(rowAtOffset(o, HEADER_ROW_HEIGHT), 1);
  assert.equal(rowAtOffset(o, o[o.length - 1]! + 1000), rows.length - 1);
});

test("with 5,000 installed items only a screenful of rows is mounted", () => {
  const rows = flattenGroups(many(5000));
  const o = offsetsOf(rows);
  const w = visibleRows(o, 100_000, 600);
  assert.ok(w.end - w.start <= 30, `mounted ${w.end - w.start}`);
  assert.ok(w.start > 1000);
  assert.equal(w.padTop + w.padBottom + o[w.end]! - o[w.start]!, w.total);
  assert.deepEqual(visibleRows(offsetsOf([]), 0, 600), { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 });
});

test("arrow stepping skips headers and clamps at the ends", () => {
  const rows = flattenGroups(many(8));
  const first = stepItem(rows, null, 1)!;
  assert.ok(first.startsWith("skill:"));
  assert.equal(stepItem(rows, first, -1), first);
  const second = stepItem(rows, first, 1)!;
  assert.notEqual(second, first);
  const last = stepItem(rows, null, "last")!;
  assert.equal(stepItem(rows, last, 1), last);
  assert.equal(stepItem(rows, "gone", 1), first);
  assert.equal(stepItem([], null, 1), null);
  assert.ok(rowIndexOf(rows, last) > 0);
  assert.equal(rowIndexOf(rows, null), -1);
});

test("browse and file windows mount a bounded number of rows", () => {
  const b = browseWindow(5000, 200_000, 700);
  assert.ok(b.end - b.start <= 30);
  assert.equal(browseWindow(0, 0, 600).end, 0);
  const f = fileWindow(200, 2000, 240);
  assert.ok(f.end - f.start <= 30);
  assert.equal(fileWindow(3, 0, 240).end, 3);
});
