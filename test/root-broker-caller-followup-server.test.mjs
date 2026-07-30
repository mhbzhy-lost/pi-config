import assert from "node:assert/strict";
import test from "node:test";

import { parseBrokerRequest } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

test("registers a plan-runner caller.followup wake intent", async () => {
  const callerToken = "a".repeat(64);
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream: {},
    writeGrant: async () => "/tmp/followup-grant",
    randomToken: () => callerToken,
  });
  await server.grantCaller({
    callerRunId: "plan-runner-1",
    planId: "plan-1",
    cwd: "/workspace",
    originRoot: "/origin",
    stateRoot: "/state",
    role: "plan-runner",
  });

  const request = parseBrokerRequest({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-followup-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    callerToken,
    method: "caller.followup",
    params: { wakeId: "plan-opened-1", reason: "plan-opened" },
  });
  const response = await server.dispatch(request, {});

  assert.deepEqual(response.data, { accepted: true, wakeId: "plan-opened-1" });
  assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), [
    { wakeId: "plan-opened-1", reason: "plan-opened" },
  ]);
});
