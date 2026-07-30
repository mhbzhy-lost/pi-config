import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const npmRoot = join(process.cwd(), "pi/npm/node_modules");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai/compat": `${npmRoot}/@earendil-works/pi-ai/dist/compat.js`,
    "@earendil-works/pi-tui": `${npmRoot}/@earendil-works/pi-tui/dist/index.js`,
    "@earendil-works/pi-coding-agent": `${npmRoot}/@earendil-works/pi-coding-agent/dist/index.js`,
    "@earendil-works/pi-ai": `${npmRoot}/@earendil-works/pi-ai/dist/index.js`,
    "@earendil-works/pi-agent-core": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js",
  },
});
const runtimeModule = await jiti.import("../pi/extensions/subagent-runtime.ts");

test("Root broker upstream exposes only frozen RPC forwarding methods including private resume", () => {
  const { createRootBrokerUpstream } = runtimeModule;
  assert.equal(typeof createRootBrokerUpstream, "function");

  const calls = [];
  const rpc = Object.fromEntries([
    "ping", "spawn", "status", "resume", "steer", "interrupt", "stop", "dispose",
  ].map((method) => [method, (...args) => {
    const result = { method, args };
    calls.push({ method, args, result });
    return result;
  }]));
  const supervisorCalls = [];
  const executeSupervisor = (params, context) => {
    const result = { params, context };
    supervisorCalls.push({ params, context, result });
    return result;
  };

  const upstream = createRootBrokerUpstream({ rpc, executeSupervisor });
  assert.deepEqual(Object.keys(upstream).sort(), [
    "dispose", "executeSupervisor", "interrupt", "ping", "resume", "spawn", "status", "steer", "stop",
  ]);
  assert.equal(Object.isFrozen(upstream), true);

  for (const method of ["ping", "spawn", "status", "steer", "interrupt", "stop", "dispose"]) {
    const args = [{ method }, { requestId: `${method}-request` }];
    const result = upstream[method](...args);
    const call = calls.at(-1);
    assert.equal(call.method, method);
    assert.strictEqual(call.args[0], args[0]);
    assert.strictEqual(call.args[1], args[1]);
    assert.strictEqual(result, call.result);
  }

  const resumeParams = { sessionId: "child-resume-123", message: "continue from checkpoint" };
  const supervisorContext = { sessionId: "root-session-456", source: "private-resume" };
  const resumeResult = upstream.resume(resumeParams, supervisorContext);
  const resumeCall = calls.at(-1);
  assert.equal(resumeCall.method, "resume");
  assert.strictEqual(resumeCall.args[0], resumeParams);
  assert.strictEqual(resumeCall.args[1], supervisorContext);
  assert.strictEqual(resumeResult, resumeCall.result);

  const supervisorParams = { request: "resume supervision" };
  const supervisorResult = upstream.executeSupervisor(supervisorParams, supervisorContext);
  assert.strictEqual(supervisorCalls[0].params, supervisorParams);
  assert.strictEqual(supervisorCalls[0].context, supervisorContext);
  assert.strictEqual(supervisorResult, supervisorCalls[0].result);
});
