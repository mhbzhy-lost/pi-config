import assert from "node:assert/strict";
import test from "node:test";
import { parseBrokerRequest } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";

const base = { schemaVersion: "pi-root-subagent-broker-request.v1", requestId: "req", rootSessionId: "root", callerRunId: "run", callerToken: "a".repeat(64) };
test("auto integration operations accept no model identity fields", () => {
  for (const method of ["coordinator.request"]) {
    const request = { ...base, method, params: { operation: method === "coordinator.request" ? "prepare_auto_integration" : method, input: {} } };
    assert.doesNotThrow(() => parseBrokerRequest(request));
  }
});
test("auto integration rejects model-supplied identity", () => {
  assert.throws(() => parseBrokerRequest({ ...base, method: "coordinator.request", params: { operation: "prepare_auto_integration", input: { workspaceId: "fake" } } }));
});
