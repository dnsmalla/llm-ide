import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, lf, read, parseBlocks, kebab } from "./helpers.mjs";

const gen = await import(join(REPO, "scripts/gen-design-tokens.mjs"));
const src = gen.loadSource();
const css = gen.generateCss(src, { web: true });
const blocks = parseBlocks(css);
const pct = (x) => `${Number((x * 100).toFixed(4))}%`;

test("kit tokens.generated.css is exactly what the generator emits (LF-normalised)", () => {
  assert.equal(read("src/styles/tokens.generated.css"), css);
  assert.equal(read("src/themes.generated.ts"), gen.generateThemesTs(src));
});

test("the generator's --check passes for every output", () => {
  const out = execFileSync("node", [join(REPO, "scripts/gen-design-tokens.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /design-tokens: ok/);
});

test("all themes: every colour role and category hue is emitted per theme, with the authored value", () => {
  assert.deepEqual(src.themes.map((t) => t.id), ["dark", "light", "midnight"]);
  for (const t of src.themes) {
    const block = blocks.get(`:root[data-theme="${t.id}"]`);
    assert.ok(block, `block for ${t.id}`);
    assert.equal(block.size, Object.keys(t.colors).length, `${t.id} overrides colours only`);
    for (const [role, v] of Object.entries(t.colors)) {
      const got = block.get(`--tok-color-${kebab(role)}`);
      assert.ok(got, `${t.id}.${role}`);
      if (v.rgb) assert.equal(got, `rgb(${v.rgb.map(pct).join(" ")})`);
      else {
        const kind = "white" in v ? "white" : "black";
        const ch = kind === "white" ? "100%" : "0%";
        assert.equal(got, `rgb(${ch} ${ch} ${ch}${v[kind] === 1 ? "" : ` / ${pct(v[kind])}`})`);
      }
    }
  }
  for (const hue of ["purple", "teal", "amber"]) {
    for (const t of src.themes) assert.ok(blocks.get(`:root[data-theme="${t.id}"]`).has(`--tok-color-category-${hue}`));
  }
});

test("spacing, radius and the full type scale are in :root", () => {
  const root = blocks.get(":root");
  for (const [k, v] of Object.entries(src.spacing)) assert.equal(root.get(`--tok-space-${k}`), `${v}px`);
  for (const [k, v] of Object.entries(src.radius)) assert.equal(root.get(`--tok-radius-${k}`), `${v}px`);
  for (const [k, t] of Object.entries(src.typography)) {
    const name = kebab(k);
    assert.match(root.get(`--tok-type-${name}-size`) ?? "", /^\d+(\.\d+)?px$/, `${k} size (text styles get a web fallback)`);
    assert.match(root.get(`--tok-type-${name}-weight`) ?? "", /^[1-9]00$/, `${k} weight`);
    if (t.size !== undefined) assert.equal(root.get(`--tok-type-${name}-size`), `${t.size}px`);
  }
  assert.ok(root.get("--tok-type-sans-family").includes("sans-serif"));
  assert.ok(root.get("--tok-type-mono-family").includes("monospace"));
});

test("the legacy outputs keep their shape (os-view bundle stays valid): no web-only variables", () => {
  const legacy = gen.generateCss(src);
  assert.ok(!legacy.includes("--tok-type-sans-family"));
  assert.equal(lf(readFileSync(join(REPO, "schema/design/tokens.css"), "utf8")), legacy);
});

test("CRLF-safe: a CRLF tokens.json parses to the same CSS", () => {
  const raw = readFileSync(join(REPO, "schema/design/tokens.json"), "utf8");
  const crlf = lf(raw).replace(/\n/g, "\r\n");
  assert.equal(gen.generateCss(gen.loadSource(crlf), { web: true }), css);
});

test("a malformed source is a hard error", () => {
  const bad = JSON.parse(readFileSync(join(REPO, "schema/design/tokens.json"), "utf8"));
  delete bad.themes[0].colors.accent;
  assert.throws(() => gen.loadSource(JSON.stringify(bad)), /colors keys must be exactly/);
});

test("every var(--tok-*) used by kit CSS and components is defined", () => {
  const defined = new Set();
  for (const f of ["src/styles/tokens.generated.css", "src/styles/aliases.css"]) {
    for (const props of parseBlocks(read(f)).values()) for (const k of props.keys()) defined.add(k);
  }
  const used = new Set();
  for (const f of ["src/styles/components.css", "src/components/LibrarySidebar.tsx"]) {
    for (const m of read(f).matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
  }
  const local = new Set(["--tint"]); // set by a component rule, not a token
  const missing = [...used].filter((v) => !defined.has(v) && !local.has(v));
  assert.deepEqual(missing, []);
});

test("components use no raw colours (hex / rgb / hsl literals)", () => {
  const css2 = read("src/styles/components.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css2, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
});

test("aliases.css mirrors the derived colours declared in Theme.swift", () => {
  const swift = lf(readFileSync(join(REPO, "mac/Sources/LlmIdeMac/Core/Platform/Theme.swift"), "utf8"));
  const aliases = parseBlocks(read("src/styles/aliases.css")).get(":root");
  let n = 0;
  for (const m of swift.matchAll(/^\s*var (\w+): Color \{ (\w+)(?:\.opacity\(([\d.]+)\))? \}/gm)) {
    const [, name, ref, alpha] = m;
    const target = `var(--tok-color-${kebab(ref)})`;
    const want = alpha ? `color-mix(in srgb, ${target} ${Math.round(Number(alpha) * 100)}%, transparent)` : target;
    assert.equal(aliases.get(`--tok-color-${kebab(name)}`), want, name);
    n++;
  }
  assert.equal(aliases.size, n, "aliases.css has an alias Theme.swift does not");
});

const GRAPHKIT_PENDING_LIGHT_TEXT_MUTED = "rgb(42% 46% 55%)";

// U5: graph-kit keeps its own theme (separate repo); its role names must map onto tokens.json.
test("graph-kit web theme conforms to tokens.json (skipped when the submodule is absent)", (t) => {
  const themeCss = join(REPO, "mac/LocalPackages/graph-kit/web/src/theme.css");
  const themeTs = join(REPO, "mac/LocalPackages/graph-kit/web/src/theme.ts");
  if (!existsSync(themeCss)) return t.skip("graph-kit checkout absent");
  const theirs = parseBlocks(readFileSync(themeCss, "utf8"));
  const ours = parseBlocks(gen.generateCss(src));
  for (const sel of ours.keys()) {
    const a = ours.get(sel), b = theirs.get(sel);
    assert.ok(b, `graph-kit theme.css lacks ${sel}`);
    for (const [k, v] of a) {
      if (!k.startsWith("--tok-color-")) continue;
      // Pending until graph-kit (separate repo) takes the darker light textMuted and the pin is bumped
      // (`make graphkit-bump`); only the previous value is tolerated, and only for this one token.
      if (sel.includes('"light"') && k === "--tok-color-text-muted" && b.get(k) === GRAPHKIT_PENDING_LIGHT_TEXT_MUTED) continue;
      assert.equal(b.get(k), v, `${sel} ${k}`);
    }
  }
  const ids = [...readFileSync(themeTs, "utf8").matchAll(/'(\w+)'/g)].map((m) => m[1]).slice(0, src.themes.length);
  assert.deepEqual(ids, src.themes.map((x) => x.id));
});
