import assert from "node:assert/strict";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { createRootBrokerUpstream } = await jiti.import("../pi/extensions/subagent-runtime.ts");

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
