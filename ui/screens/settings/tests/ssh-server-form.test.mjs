// The SSH form shared by the Settings card and the Welcome connect dialog: the Settings card must render exactly this
// form, and a caller's link actions take the place of Connect only while the link is up.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const h = React.createElement;
let form;
let view;
let model;
before(async () => {
  form = await load("../settings/sections/SshServerForm.tsx");
  view = await load("../settings/sections/SshServerView.tsx");
  model = await load("../settings/ssh-server-model.ts");
});

const io = { test: async () => { throw new Error("not used"); }, confirm: async () => { throw new Error("not used"); }, connect: async () => { throw new Error("not used"); }, disconnect: async () => { throw new Error("not used"); }, status: async () => { throw new Error("not used"); }, stop: async () => { throw new Error("not used"); }, uninstall: async () => { throw new Error("not used"); }, saved: async () => { throw new Error("not used"); }, installKey: async () => { throw new Error("not used"); }, recent: async () => [], forget: async () => undefined };

function filled() {
  const m = new model.SshServerModel(io);
  m.setField("host", "server.example.com");
  m.setField("port", "22");
  m.setField("user", "deploy");
  m.setField("keyPath", "/home/deploy/.ssh/id_ed25519");
  return m;
}

test("the Settings card renders the shared form unchanged", () => {
  const m = filled();
  const s = m.getState();
  const formHtml = renderToStaticMarkup(h(form.SshServerForm, { m, s, password: "", onPassword() {} }));
  const viewHtml = renderToStaticMarkup(h(view.SshServerView, { m, s, password: "", onPassword() {}, dialog: null, onDialog() {}, onRestart() {} }));
  assert.ok(viewHtml.includes(formHtml), "the card's markup contains the form's markup");
});

test("the form offers Connect; a caller's link actions replace it only while the link is up", () => {
  const m = filled();
  const offline = renderToStaticMarkup(h(form.SshServerForm, { m, s: m.getState(), password: "", onPassword() {}, linkActions: h("button", null, "Disconnect") }));
  assert.match(offline, />Connect</);
  assert.doesNotMatch(offline, />Disconnect</);
  m.setField("port", "2222");
  const up = { ...m.getState(), status: { link: "connected", host: "server.example.com", port: 2222, user: "deploy", localUrl: "http://127.0.0.1:3456", version: "1.2.3", claude: "2.0.0", error: null } };
  const linked = renderToStaticMarkup(h(form.SshServerForm, { m, s: up, password: "", onPassword() {}, linkActions: h("button", null, "Disconnect") }));
  assert.match(linked, />Disconnect</);
  assert.doesNotMatch(linked, />Connect</);
});

test("read-only fields and a disabled sign-in choice when the dialog opens from a recent server", () => {
  const m = filled();
  const html = renderToStaticMarkup(h(form.SshServerForm, { m, s: m.getState(), password: "", onPassword() {}, readOnly: true }));
  assert.equal((html.match(/<input[^>]*readonly=""[^>]*>/gi) ?? []).length, 4, "host, port, user and key path");
  assert.equal((html.match(/<input[^>]*type="radio"[^>]*disabled=""[^>]*>/g) ?? []).length, 2, "both sign-in choices are disabled");
});
