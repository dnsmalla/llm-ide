import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionsFromMe, chatBlockReason, allowedModes } from "../permissions.ts";

const modes = [{ id: "auto" }, { id: "ask" }, { id: "execute" }];

test("an older core (no permissions) is unknown: nothing is hidden", () => {
  assert.equal(permissionsFromMe({ id: "u", member: { teamRole: "owner" } }), null);
  assert.equal(chatBlockReason(null), null);
  assert.deepEqual(allowedModes(null, modes), modes);
});

test("a viewer may only Ask; a read-only member cannot pick Execute; no model class blocks chat", () => {
  const viewer = permissionsFromMe({ member: { permissions: ["self.read", "self.write", "model.ask", "host"] } });
  assert.equal(chatBlockReason(viewer), null);
  assert.deepEqual(allowedModes(viewer, modes).map((m) => m.id), ["ask"]);
  const none = permissionsFromMe({ member: { permissions: ["self.read", "self.write", "host"] } });
  assert.match(chatBlockReason(none), /team role/);
  const reader = permissionsFromMe({ member: { permissions: ["self.read", "self.write", "model.ask", "model.read"] } });
  assert.equal(chatBlockReason(reader), null);
  assert.deepEqual(allowedModes(reader, modes).map((m) => m.id), ["auto", "ask"]);
  const doer = permissionsFromMe({ member: { permissions: ["model.read", "model.exec"] } });
  assert.deepEqual(allowedModes(doer, modes), modes);
});
