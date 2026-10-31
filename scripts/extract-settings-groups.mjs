#!/usr/bin/env node
// Extracts the Mac Settings page's group list (order, title, SF Symbol) from the Swift source so the desktop
// Settings cannot drift from it. Prints JSON: { app: [...], project: [...] }.
//   node scripts/extract-settings-groups.mjs
//
// How the page is derived (all textual, like scripts/extract-chat-slash-builtins.mjs):
//  - SettingsView.swift lists the cards in order: a view name (`BackendSettingsSection()`) or a slot
//    (`SettingsSlotView(slot: .docGen)`). The App block is the text after `Text("App")`, the Project block
//    the text after `Text("Project")`.
//  - A slot expands to what Shell/FeatureCatalog.swift registers for it (sorted by `order:`).
//  - A view expands to the `SettingsSectionCard(icon:, title:)` literals in its own body plus those of the views
//    it names (Workspace names Build). A view with no card but a `SectionLabel("X", size: 12)` header
//    (Connections) uses that, with the `Image(systemName:)` just before it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MAC_SRC = join(REPO, "mac/Sources/LlmIdeMac");

/** Views whose cards render INSIDE another group's card (Repositories embeds GitHub and GitLab), not as groups. */
const NESTED = new Set(["GitHubSettingsSection", "GitLabSettingsSection"]);

function swiftFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) swiftFiles(p, out);
    else if (n.endsWith(".swift")) out.push(p);
  }
  return out;
}

/** `struct Name` declarations (any nesting/modifier) with the text up to the next top-level declaration. */
function indexStructs(files) {
  const structs = new Map();
  const consts = new Map(); // `Enum.title` -> literal
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const decl = /^(?:(?:private|fileprivate|public|final)\s+)*(struct|enum|extension)\s+(\w+)[^\n]*\{/gm;
    const marks = [...src.matchAll(decl)];
    marks.forEach((m, i) => {
      const body = src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length);
      if (m[1] === "struct") structs.set(m[2], body);
      if (m[1] === "enum") {
        const t = /static let title = "([^"]+)"/.exec(body);
        if (t) consts.set(`${m[2]}.title`, t[1]);
      }
    });
  }
  return { structs, consts };
}

export function extractSettingsGroups(src = MAC_SRC) {
  const { structs, consts } = indexStructs(swiftFiles(src));
  const settingsView = readFileSync(join(src, "Features/Settings/Views/SettingsView.swift"), "utf8");
  const catalog = readFileSync(join(src, "Shell/FeatureCatalog.swift"), "utf8");

  // Slot registrations: register(slot: .x, id: "...", [order: N]) { AnyView(Name(...)) }
  const slots = new Map();
  for (const m of catalog.matchAll(/register\(slot: \.(\w+),[^{]*?(?:order: (\d+))?\)\s*\{\s*AnyView\((\w+)\(/g)) {
    const list = slots.get(m[1]) ?? [];
    list.push({ order: m[2] ? Number(m[2]) : 0, name: m[3], seq: list.length });
    slots.set(m[1], list);
  }
  for (const l of slots.values()) l.sort((a, b) => a.order - b.order || a.seq - b.seq);

  const cardsIn = (name, seen = new Set()) => {
    const body = structs.get(name);
    if (!body || seen.has(name)) return [];
    seen.add(name);
    const out = [];
    const re = /SettingsSectionCard\(icon: "([^"]+)", title: (?:"([^"]+)"|([A-Za-z]+\.title))/g;
    for (const m of body.matchAll(re)) out.push({ sf: m[1], title: m[2] ?? consts.get(m[3]) });
    if (out.length === 0) {
      const h = /Image\(systemName: "([^"]+)"\)[\s\S]{0,200}?SectionLabel\("([^"]+)", size: 12\)/.exec(body);
      if (h) out.push({ sf: h[1], title: h[2] });
    }
    for (const m of body.matchAll(/\b([A-Z]\w*)\(/g)) {
      if (m[1] !== name && structs.has(m[1]) && !NESTED.has(m[1])) out.push(...cardsIn(m[1], seen));
    }
    return out;
  };

  const block = (text) => {
    const out = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("//")) continue;
      const slot = /^SettingsSlotView\(slot: \.(\w+)\)/.exec(t);
      if (slot) {
        for (const e of slots.get(slot[1]) ?? []) out.push(...cardsIn(e.name));
        continue;
      }
      const view = /^([A-Z]\w*)\(/.exec(t);
      if (view && structs.has(view[1])) out.push(...cardsIn(view[1]));
    }
    return out.filter((c, i) => c.title && out.findIndex((d) => d.title === c.title) === i);
  };

  const iApp = settingsView.indexOf('Text("App")');
  const iProject = settingsView.indexOf('Text("Project")');
  if (iApp < 0 || iProject < 0) throw new Error("SettingsView.swift no longer has the App / Project headings this extractor reads");
  return { app: block(settingsView.slice(iApp, iProject)), project: block(settingsView.slice(iProject)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(extractSettingsGroups(), null, 2));
}
