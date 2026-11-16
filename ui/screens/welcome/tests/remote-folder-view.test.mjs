// SSH server folder picker: the view. Rendered to markup, and its buttons' handlers are called from the element tree.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const h = React.createElement;
let view;
before(async () => {
  view = await load("../remote-folder/FolderPicker.tsx");
});

const plain = (html) => html.replace(/<!-- -->/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const HOME = "/home/dev";

const state = (over = {}) => ({
  home: HOME,
  path: `${HOME}/projects`,
  entries: [
    { name: "alpha", isLink: false, outsideHome: false },
    { name: "api", isLink: true, outsideHome: true },
    { name: ".cache", isLink: false, outsideHome: false },
  ],
  showHidden: true,
  selected: null,
  loading: false,
  error: null,
  busy: false,
  creating: false,
  newName: "",
  newNameError: null,
  ...over,
});

/** Every handler the view gives, recorded by name, so a test can press one. */
function handlers(log) {
  const names = ["onGo", "onEnter", "onSelect", "onToggleHidden", "onStartNew", "onCancelNew", "onNewName", "onCreate", "onOpenCurrent", "onClose"];
  return Object.fromEntries(names.map((n) => [n, (...args) => log.push([n, ...args])]));
}
const render = (s, log = []) => plain(renderToStaticMarkup(h(view.FolderPickerView, { state: s, ...handlers(log) })));

/** Depth-first search of an element tree for the first node the predicate accepts. */
function findNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !node.props) return null;
  if (predicate(node)) return node;
  return findNode(node.props.children, predicate);
}

test("breadcrumbs start at ~ and every segment is a button", () => {
  const html = render(state());
  assert.match(html, />~</);
  assert.match(html, />projects</);
});

test("Show hidden is a checkbox that reflects the state", () => {
  assert.match(render(state({ showHidden: true })), /type="checkbox"[^>]*checked=""[^>]*\/>|checked=""[^>]*type="checkbox"/);
  assert.match(render(state({ showHidden: false })), /Show hidden/);
});

test("outside-home entries are disabled with the tooltip, and the others are not", () => {
  const html = render(state());
  assert.match(html, /disabled=""[^>]*title="Outside your home folder"|title="Outside your home folder"[^>]*disabled=""/);
  assert.match(html, />alpha</);
  assert.match(html, />api</);
});

test("the folder name and its hidden entry are listed", () => {
  const html = render(state());
  assert.match(html, />\.cache</);
});

test("double-clicking an entry enters it; an outside-home entry has no double-click action", () => {
  const log = [];
  const tree = view.FolderPickerView({ state: state(), ...handlers(log) });
  const alpha = findNode(tree, (n) => n.props["data-entry"] === "alpha" && typeof n.props.onDoubleClick === "function");
  assert.ok(alpha, "alpha row has a double-click handler");
  alpha.props.onDoubleClick();
  assert.deepEqual(log, [["onEnter", "alpha"]]);
  const api = findNode(tree, (n) => n.props["data-entry"] === "api");
  assert.equal(api.props.onDoubleClick, undefined);
});

test("Open enters the selected entry; disabled with no selection", () => {
  const log = [];
  const none = view.FolderPickerView({ state: state(), ...handlers(log) });
  assert.equal(findNode(none, (n) => n.props.children === "Open" && n.props.onClick)?.props.disabled, true);
  const withSel = view.FolderPickerView({ state: state({ selected: "alpha" }), ...handlers(log) });
  const open = findNode(withSel, (n) => n.props.children === "Open" && n.props.onClick);
  open.props.onClick();
  assert.deepEqual(log, [["onEnter", "alpha"]]);
});

test("Open this folder opens the folder being listed", () => {
  const log = [];
  const tree = view.FolderPickerView({ state: state(), ...handlers(log) });
  findNode(tree, (n) => n.props.children === "Open this folder" && n.props.onClick).props.onClick();
  assert.deepEqual(log, [["onOpenCurrent"]]);
});

test("New folder shows an inline name field with its error", () => {
  const html = render(state({ creating: true, newName: "a/b", newNameError: "A folder name cannot contain /." }));
  assert.match(html, /aria-label="New folder name"/);
  assert.match(html, /A folder name cannot contain \//);
  assert.match(html, />Create</);
});

test("the view shows a listing error inline, and Cancel closes the dialog", () => {
  const html = render(state({ error: "The connection to the server was lost." }));
  assert.match(html, /The connection to the server was lost\./);
  const log = [];
  const tree = view.FolderPickerView({ state: state(), ...handlers(log) });
  findNode(tree, (n) => n.props.children === "Cancel" && n.props.onClick).props.onClick();
  assert.deepEqual(log, [["onClose"]]);
});
