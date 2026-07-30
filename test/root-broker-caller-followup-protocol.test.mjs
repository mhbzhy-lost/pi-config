import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKER_METHODS,
  parseBrokerRequest,
} from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";

const request = {
  schemaVersion: "pi-root-subagent-broker-request.v1",
  requestId: "request-followup-1",
  rootSessionId: "root-session-1",
  callerRunId: "plan-run-1",
  callerToken: "a".repeat(64),
  method: "caller.followup",
  params: { wakeId: "plan-opened-1", reason: "plan-opened" },
};

const invalidParamsCases = [
  {
    name: "missing wakeId",
    params: { reason: "plan-opened" },
    message: /params\.wakeId/,
  },
  {
    name: "missing reason",
    params: { wakeId: "plan-opened-1" },
    message: /params\.reason/,
  },
  {
    name: "extra field",
    params: { wakeId: "plan-opened-1", reason: "plan-opened", extra: true },
    message: /params.*extra/,
  },
  {
    name: "unsafe wakeId",
    params: { wakeId: "../escape", reason: "plan-opened" },
    message: /params\.wakeId/,
  },
  {
    name: "unsupported reason",
    params: { wakeId: "plan-opened-1", reason: "executor-complete" },
    message: /params\.reason/,
  },
];

test("parses caller.followup broker requests", () => {
  assert.deepEqual(parseBrokerRequest(request), request);
  assert.equal(BROKER_METHODS.includes("caller.followup"), true);
});

for (const { name, params, message } of invalidParamsCases) {
  test(`rejects caller.followup requests with ${name}`, () => {
    assert.throws(() => parseBrokerRequest({ ...request, params }), message);
  });
}
