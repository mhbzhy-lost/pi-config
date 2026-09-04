import assert from "node:assert/strict";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { createRootBrokerUpstream } = await jiti.import("../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
const {
  bindManagedWorkspaceServiceSession,
  findManagedWorkspaceService,
  unbindManagedWorkspaceServiceSession,
} = await jiti.import("../packages/pi-subagents-enhanced/src/workspace/registry.ts");

test("Root broker upstream exposes only direct-owner lifecycle operations", async () => {
  const calls = [];
  const rpc = {
    ping(...args) { calls.push(["ping", ...args]); return { alive: true }; },
    stop(...args) { calls.push(["stop", ...args]); return { stopped: true }; },
    dispose(...args) { calls.push(["dispose", ...args]); return { disposed: true }; },
    resume() { throw new Error("resume must not be exposed"); },
    spawn() { throw new Error("spawn must not be exposed"); },
  };
  const upstream = createRootBrokerUpstream({ rpc });
  assert.equal(Object.isFrozen(upstream), true);
  assert.deepEqual(Object.keys(upstream).sort(), ["dispose", "ping", "stop"]);
  assert.deepEqual(await upstream.ping("health"), { alive: true });
  assert.deepEqual(await upstream.stop({ runId: "executor-1" }), { stopped: true });
  assert.deepEqual(await upstream.dispose("shutdown"), { disposed: true });
  assert.deepEqual(calls, [
    ["ping", "health"],
    ["stop", { runId: "executor-1" }],
    ["dispose", "shutdown"],
  ]);
});

test("workspace service registry survives ExtensionAPI reload and CAS-unbinds the owning generation", () => {
  const events = {};
  const firstPi = { events };
  const replacementPi = { events };
  const consumerPi = { events: {} };
  const service = (name) => ({
    name,
    reserve() {}, ensureAllocated() {}, bindRun() {}, status() {},
    issueDisposition() {}, dispose() {}, release() {}, reconcile() {},
  });
  const first = service("first");
  const replacement = service("replacement");

  bindManagedWorkspaceServiceSession(firstPi, "root-workspace", first);
  assert.strictEqual(findManagedWorkspaceService(consumerPi, "root-workspace"), first);
  bindManagedWorkspaceServiceSession(replacementPi, "root-workspace", replacement);
  assert.strictEqual(findManagedWorkspaceService(firstPi), replacement);
  unbindManagedWorkspaceServiceSession(firstPi, "root-workspace", first);
  assert.strictEqual(findManagedWorkspaceService(consumerPi, "root-workspace"), replacement);
  unbindManagedWorkspaceServiceSession(replacementPi, "root-workspace", replacement);
  assert.equal(findManagedWorkspaceService(consumerPi, "root-workspace"), undefined);
});
