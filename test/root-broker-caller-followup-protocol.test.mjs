import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKER_METHODS,
  parseBrokerRequest,
} from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";

test("parses caller.followup broker requests", () => {
  const request = {
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-followup-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-run-1",
    callerToken: "a".repeat(64),
    method: "caller.followup",
    params: { wakeId: "plan-opened-1", reason: "plan-opened" },
  };

  assert.deepEqual(parseBrokerRequest(request), request);
  assert.equal(BROKER_METHODS.includes("caller.followup"), true);
});
