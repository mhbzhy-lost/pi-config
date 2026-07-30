import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";

import { createRootBrokerClient } from "../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { brokerGrantPath, brokerSocketPath } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

test("root broker client sends a caller.followup wire request", async (t) => {
  const rootSessionId = `root-caller-followup-${process.pid}-${randomUUID()}`;
  const callerRunId = "plan-runner-followup-1";
  let cancels = 0;
  const server = new RootBrokerServer({
    rootSessionId,
    upstream: { async cancel() { cancels += 1; } },
  });
  await server.start();
  t.after(async () => {
    await server.closeRootSession();
    assert.equal(cancels, 0);
    assert.equal(server.sockets.size, 0);
    assert.equal(server.grantPaths.size, 0);
    await assert.rejects(access(brokerSocketPath(rootSessionId)), { code: "ENOENT" });
    await assert.rejects(access(brokerGrantPath(rootSessionId, callerRunId)), { code: "ENOENT" });
  });
  await server.grantCaller({
    callerRunId,
    planId: "plan-followup-1",
    cwd: process.cwd(),
    originRoot: process.cwd(),
    stateRoot: process.cwd(),
    role: "plan-runner",
  });
  const client = createRootBrokerClient({
    rootSessionId,
    callerRunId,
    randomUUID: () => "caller-followup-request-1",
  });
  t.after(() => client.dispose());

  const wakeId = "plan-opened-1";
  const reply = await client.callerFollowUp({ wakeId, reason: "plan-opened" });

  assert.deepEqual(reply, { accepted: true, wakeId });
  assert.deepEqual(server.callerFollowUps.get(callerRunId), [{ wakeId, reason: "plan-opened" }]);
});
