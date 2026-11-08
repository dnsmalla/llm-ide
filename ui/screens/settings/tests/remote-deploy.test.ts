import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteDeployModel, decodeDeployPlan, decodeDeployReport, canDeploy, type DeployIo } from "../remote-deploy-model.ts";

const config = { mode: "remote" as const, host: "hub.example.com", port: 22, user: "deploy", keyPath: "/k", label: "prod", hubUrl: "https://hub.example.com", tlsPin: "" };
const plan = {
  id: "p1", version: "0.0.0", domain: "hub.example.com", arch: "x86_64",
  stages: [{ id: "base", title: "Base", mutating: true, detail: "dirs" }],
  blockers: [], warnings: [], confirmation: "hub.example.com", bundlePath: "/tmp/b.tar.gz", createdAt: 1,
};
const report = { version: "0.0.0", url: "https://hub.example.com", apiVersion: 128, hub: true, ownerWindowOpen: true, setupUrl: "https://hub.example.com/setup?t=x", rolledBack: false, failedStage: null };

function io(over: Partial<DeployIo> = {}): DeployIo {
  return {
    plan: async () => plan,
    bootstrap: async () => ({ installed: true, command: "", staging: "/home/deploy/.llmide-deploy" }),
    run: async () => report,
    lock: async () => {},
    rollback: async () => {},
    ...over,
  };
}

test("preflight loads a plan, and only the exact typed domain enables deploy", async () => {
  const m = new RemoteDeployModel(io(), () => config);
  m.setDomain("Hub.Example.com");
  m.setReviewAck(true);
  await m.preflight();
  assert.equal(m.getState().plan?.id, "p1");
  assert.equal(canDeploy(m.getState()), false);
  m.setConfirmation("wrong.example.com");
  assert.equal(canDeploy(m.getState()), false);
  m.setConfirmation("hub.example.com");
  assert.equal(canDeploy(m.getState()), true);
});

test("a rollback report is surfaced, not hidden as success", async () => {
  const m = new RemoteDeployModel(io({ run: async () => ({ ...report, ownerWindowOpen: false, rolledBack: true, failedStage: "start" }) }), () => config);
  m.setDomain("hub.example.com");
  m.setReviewAck(true);
  await m.preflight();
  m.setConfirmation("hub.example.com");
  await m.deploy();
  assert.equal(m.getState().phase, "failed");
  assert.match(m.getState().error ?? "", /start/);
});

test("decoders refuse invented shapes", () => {
  assert.equal(decodeDeployPlan({ id: "x" }), null);
  assert.equal(decodeDeployReport({ version: "1" }), null);
});
