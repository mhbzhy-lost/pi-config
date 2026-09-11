import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequest } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const hash = (character) => character.repeat(64);

async function loadV2Codec() {
  const contract = await import("../packages/pi-subagents-enhanced/src/workspace/contract.ts");
  return contract.createManagedWorkspaceRequestV2;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "managed-workspace-contract-"));
  const originRoot = join(root, "origin");
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "initial");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { originRoot, root, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

function request(fixture, workspaceId) {
  return createManagedWorkspaceRequest({
    workspaceId,
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: `tool-${workspaceId}` },
    originRoot: fixture.originRoot,
    requestedCwd: join(fixture.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: fixture.baseCommit,
    contractHash: hash("a"),
    mode: "coding",
    writePaths: ["src/**"],
  });
}

function v2Request(fixture, workspaceId, baseCommit) {
  return {
    workspaceId,
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: `tool-${workspaceId}` },
    originRoot: fixture.originRoot,
    requestedCwd: join(fixture.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit,
    contractHash: hash("a"),
    policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] },
  };
}

test("requires a public v2 policy codec before creating a publishable lease", async (t) => {
  const f = await fixture(t);
  const createManagedWorkspaceRequestV2 = await loadV2Codec();
  assert.equal(typeof createManagedWorkspaceRequestV2, "function", "public v2 request/policy codec must exist before publish/apply is available");

  for (const baseCommit of [f.baseCommit, hash("b")]) {
    const requestV2 = createManagedWorkspaceRequestV2(v2Request(f, `v2-${baseCommit.length}`, baseCommit));
    assert.equal(requestV2.baseCommit, baseCommit, "v2 policy codec must accept 40- and 64-character commit identities");
    assert.equal(requestV2.policy.application, "allowed");
  }
});

test("keeps a v1 lease on frozen dispositions without publish or apply authority", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: join(f.root, "state") });
  const active = service.ensureAllocated(request(f, "frozen-v1"));
  const status = service.status({ workspaceId: active.workspaceId });

  assert.equal(active.schemaVersion, "managed-workspace.v1");
  assert.equal(Object.hasOwn(active, "policy"), false);
  assert.equal(Object.hasOwn(active, "publication"), false);
  assert.equal(Object.hasOwn(active, "application"), false);
  assert.deepEqual(status.allowedDispositions, ["discard", "preserve"]);
  assert.equal(status.allowedDispositions.includes("publish"), false);
  assert.equal(status.allowedDispositions.includes("apply"), false);
  const issued = service.issueDisposition({ workspaceId: active.workspaceId });
  const preserved = service.dispose({
    workspaceId: active.workspaceId,
    disposition: "preserve",
    reason: "v1 disposition remains frozen",
    actionToken: issued.actionToken,
  });
  assert.deepEqual(preserved.disposition, { action: "preserve", reason: "v1 disposition remains frozen" });
  assert.equal(service.release({ workspaceId: active.workspaceId }).state, "released");
});

test("publishes and applies only an observed v2 lease through status and action tokens", async (t) => {
  const f = await fixture(t);
  const createManagedWorkspaceRequestV2 = await loadV2Codec();
  assert.equal(typeof createManagedWorkspaceRequestV2, "function", "public v2 request/policy codec must exist before v2 lifecycle operations");

  const service = createManagedWorkspaceService({ stateRoot: join(f.root, "state") });
  await writeFile(join(f.originRoot, "origin-dirty.txt"), "do not overwrite\n");
  const active = service.ensureAllocated(createManagedWorkspaceRequestV2(v2Request(f, "publish-v2", f.baseCommit)));
  await writeFile(join(active.path, "src", "agent.txt"), "durable result\n");
  const ownerScope = { kind: "standalone-subagent", rootSessionId: "root-1" };
  const terminalProof = {
    state: "observed",
    conflict: false,
    runId: "run-publish-v2",
    rootSessionId: "root-1",
    asyncDir: join(f.root, "async-publish-v2"),
    processInstance: "process-publish-v2",
    proofId: hash("e"),
  };

  service.bindRun({ workspaceId: active.workspaceId, run: { runId: terminalProof.runId, asyncDir: terminalProof.asyncDir } });
  const publishStatus = service.statusOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof });
  const publishAction = service.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "publish", terminalProof, snapshotHash: publishStatus.snapshotHash });
  const artifact = service.publishOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof, actionToken: publishAction.actionToken });
  assert.match(artifact.publishedTree, /^[a-f0-9]{40,64}$/);

  const applyStatus = service.statusOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof });
  const applyAction = service.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "apply", terminalProof, snapshotHash: applyStatus.snapshotHash });
  assert.equal(service.applyOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof, artifactId: artifact.artifactId, actionToken: applyAction.actionToken }).applied, false);
});
