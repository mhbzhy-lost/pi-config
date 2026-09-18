import assert from "node:assert/strict";
import test from "node:test";

import {
  COORDINATOR_PROTOCOL_VERSION,
  authorizeCoordinatorRequest,
  parseCoordinatorReply,
  parseCoordinatorRequest,
} from "../packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts";

const repositoryId = "a".repeat(64);
const capability = "b".repeat(64);

function request(overrides = {}) {
  return {
    protocol: COORDINATOR_PROTOCOL_VERSION,
    requestId: "request-1",
    repositoryId,
    role: "root-broker",
    capability,
    method: "workspace.attach",
    params: { workspaceId: "workspace-1", owner: { kind: "standalone-subagent", rootSessionId: "forged-root" } },
    ...overrides,
  };
}

const trusted = Object.freeze({
  repositoryId,
  role: "root-broker",
  capability,
  ownerScope: Object.freeze({ kind: "standalone-subagent", rootSessionId: "root-1" }),
  childBindings: new Map([["workspace-1", { workspaceId: "workspace-1", runId: "run-1" }]]),
  adminLeaseAuthorized: false,
});

test("protocol v1 strictly parses request and reply unions", () => {
  const parsed = parseCoordinatorRequest(request());
  assert.equal(parsed.protocol, "repository-workspace-coordinator.v1");
  assert.throws(() => parseCoordinatorRequest({ ...request(), unknown: true }), /unknown/i);
  assert.throws(() => parseCoordinatorRequest({ ...request(), params: { workspaceId: "workspace-1", owner: { kind: "standalone-subagent", rootSessionId: "root-1" }, extra: true } }), /unknown/i);
  assert.throws(() => parseCoordinatorReply({ protocol: COORDINATOR_PROTOCOL_VERSION, requestId: "request-1", repositoryId, ok: true, result: {}, extra: true }), /unknown/i);
});

test("authorization binds repository and trusted root scope rather than request parameters", () => {
  const authorized = authorizeCoordinatorRequest(request(), trusted);
  assert.deepEqual(authorized.ownerScope, trusted.ownerScope);
  assert.notEqual(authorized.request.params.owner.rootSessionId, authorized.ownerScope.rootSessionId);
  assert.throws(() => authorizeCoordinatorRequest(request({ repositoryId: "c".repeat(64) }), trusted), /repository/i);
  assert.throws(() => authorizeCoordinatorRequest(request({ capability: "d".repeat(64) }), trusted), /capability/i);
});

test("permission matrix rejects host publish, unauthorised admin reconcile, and internal claims", () => {
  assert.throws(() => authorizeCoordinatorRequest(request({ role: "root-host", method: "queue.publish", params: { workspaceId: "workspace-1" } }), { ...trusted, role: "root-host" }), /permission/i);
  assert.throws(() => authorizeCoordinatorRequest(request({ role: "admin", method: "workspace.reconcile", params: {} }), { ...trusted, role: "admin" }), /authorization|permission/i);
  assert.throws(() => authorizeCoordinatorRequest(request({ role: "coordinator-internal", method: "queue.claim", params: {} }), { ...trusted, role: "coordinator-internal" }), /internal|permission/i);
});

test("foreign bind_run and record_terminal_proof plus unauthorized_reconcile fail before handlers", () => {
  const foreign = { kind: "standalone-subagent", rootSessionId: "root-foreign" };
  for (const method of ["bind_run", "record_terminal_proof"]) {
    assert.throws(
      () => authorizeCoordinatorRequest(request({ method, params: { workspaceId: "workspace-1", owner: foreign } }), trusted),
      /owner|foreign|scope/i,
    );
  }
  assert.throws(
    () => authorizeCoordinatorRequest(request({ role: "admin", method: "authorized_reconcile", params: {} }), { ...trusted, role: "admin" }),
    /authorization|permission/i,
  );
});
