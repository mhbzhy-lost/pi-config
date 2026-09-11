import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileGenericPrompt, renderGenericPrompt } from "../packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts";
import { preparePublicCodingDispatch } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { createAuthorizedDispatch } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { dispatchExecution, createGenericDispatchAdapter, createCodingDispatchAdapter } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/execution.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha = (c) => c.repeat(64);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "standalone-e2e-"));
  const originRoot = join(root, "origin");
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "initial");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, originRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

function hostEnvelope(root, cwdRoot, agent, kind) {
  return createAuthorizedDispatch({ agent, cwd: cwdRoot }, {
    rootSessionId: "root-e2e",
    allowedProfiles: [agent],
    originRoot: root,
    cwdRoot,
    isolation: "managed-workspace",
    authorization: createRunAuthorization({
      kind,
      binding: { runId: `run-${agent}`, asyncDir: join(root, "async"), sessionId: "root-e2e", pid: 1, agentProfile: agent },
      goal: null,
    }),
  });
}

test("standalone reviewer generic contract reaches shared execution through a Host envelope", async (t) => {
  const f = await fixture(t);
  const prompt = compileGenericPrompt({
    task: "Review the isolated diff.",
    context: ["The reviewer has read-only scope."],
    constraints: ["Do not modify files."],
    deliverable: "A findings report.",
    done: ["Every finding cites evidence."],
  });
  assert.match(renderGenericPrompt(prompt), /## Done/);
  const envelope = await hostEnvelope(f.root, f.originRoot, "reviewer", "generic");
  let seen;
  const receipt = await dispatchExecution(
    createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt, cwd: f.originRoot }),
    { authorizedDispatch: envelope, execute: (value) => { seen = value; return { runId: "reviewer-run" }; } },
  );
  assert.equal(receipt.runId, "reviewer-run");
  assert.equal(seen.worktree, false);
  assert.equal(seen.authorizedDispatch, envelope);
  assert.match(seen.prompt, /# Generic Subagent Prompt/);
});

test("standalone executor coding contract reaches shared execution and allocates a v2 workspace", async (t) => {
  const f = await fixture(t);
  const coding = {
    version: "dispatch-ir.v1",
    taskId: "e2e.executor",
    title: "Executor coding task",
    agent: "executor",
    risk: "normal",
    objective: "Implement the change.",
    workflow: { mode: "tdd" },
    requirements: ["Preserve the public ABI."],
    context: { knownFacts: ["The contract is repository-managed."], decisions: ["Use the typed coding contract."], relevantFiles: ["src/**"] },
    boundaries: { writePaths: ["src/**"], excludedWork: ["Do not change the schema."], forbiddenActions: ["Do not commit."] },
    acceptance: { criteria: ["The change compiles."] },
    execution: { worktree: true },
  };
  const ir = preparePublicCodingDispatch(coding, { cwd: f.originRoot, timeoutMs: 30 * 60_000 });
  assert.equal(ir.hash.length, 64);
  const envelope = await hostEnvelope(f.root, f.originRoot, "executor", "coding");
  let seen;
  await dispatchExecution(
    createCodingDispatchAdapter({ agent: "executor", title: ir.title, prompt: "# Coding Dispatch Contract v1", cwd: f.originRoot, contractHash: ir.hash }),
    { authorizedDispatch: envelope, execute: (value) => { seen = value; return { runId: "executor-run" }; } },
  );
  assert.equal(seen.worktree, false);
  assert.equal(seen.contractHash, ir.hash);

  const service = createManagedWorkspaceService({ stateRoot: join(f.root, "state") });
  const request = createManagedWorkspaceRequestV2({
    workspaceId: "e2e-executor",
    owner: { kind: "standalone-subagent", rootSessionId: "root-e2e", toolCallId: "tool-e2e-executor" },
    originRoot: f.originRoot,
    requestedCwd: join(f.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: ir.hash,
    policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] },
  });
  const active = service.ensureAllocated(request);
  await writeFile(join(active.path, "src", "result.txt"), "result\n");
  const proof = { state: "observed", conflict: false, runId: "executor-run", rootSessionId: "root-e2e", asyncDir: join(f.root, "async"), processInstance: "proc-e2e", proofId: sha("e") };
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: proof.runId, asyncDir: proof.asyncDir } });
  const ownerScope = { kind: "standalone-subagent", rootSessionId: "root-e2e" };

  const publishStatus = service.statusOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof });
  const publishAction = service.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "publish", terminalProof: proof, snapshotHash: publishStatus.snapshotHash });
  const artifact = service.publishOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, actionToken: publishAction.actionToken });
  assert.match(artifact.publishedTree, /^[a-f0-9]{40,64}$/);
  // publish 已固化结果；清理 workspace 未提交文件使 release 可执行。
  await rm(join(active.path, "src", "result.txt"), { force: true });

  const applyStatus = service.statusOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof });
  const applyAction = service.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "apply", terminalProof: proof, snapshotHash: applyStatus.snapshotHash });
  const applied = service.applyOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, artifactId: artifact.artifactId, actionToken: applyAction.actionToken });
  assert.equal(applied.applied, true);
  assert.equal(git(f.originRoot, "rev-parse", "HEAD"), f.baseCommit);

  const preserveDisposition = service.issueOwnedDisposition({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof });
  service.disposeOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, disposition: "preserve", reason: "e2e preserved", actionToken: preserveDisposition.actionToken });
  const released = service.releaseOwned({ workspaceId: active.workspaceId, ownerScope });
  assert.equal(released.state, "released");
});

test("standalone dirty source allows publish but blocks apply", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.originRoot, "origin-dirty.txt"), "do not overwrite\n");
  const service = createManagedWorkspaceService({ stateRoot: join(f.root, "state") });
  const request = createManagedWorkspaceRequestV2({
    workspaceId: "e2e-dirty",
    owner: { kind: "standalone-subagent", rootSessionId: "root-e2e", toolCallId: "tool-e2e-dirty" },
    originRoot: f.originRoot,
    requestedCwd: join(f.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: sha("a"),
    policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] },
  });
  const active = service.ensureAllocated(request);
  await writeFile(join(active.path, "src", "result.txt"), "result\n");
  const proof = { state: "observed", conflict: false, runId: "dirty-run", rootSessionId: "root-e2e", asyncDir: join(f.root, "async"), processInstance: "proc-dirty", proofId: sha("d") };
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: proof.runId, asyncDir: proof.asyncDir } });
  const ownerScope = { kind: "standalone-subagent", rootSessionId: "root-e2e" };

  const publishStatus = service.statusOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof });
  const publishAction = service.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "publish", terminalProof: proof, snapshotHash: publishStatus.snapshotHash });
  const artifact = service.publishOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, actionToken: publishAction.actionToken });
  assert.match(artifact.publishedTree, /^[a-f0-9]{40,64}$/);

  const applyStatus = service.statusOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof });
  const applyAction = service.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "apply", terminalProof: proof, snapshotHash: applyStatus.snapshotHash });
  const blocked = service.applyOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, artifactId: artifact.artifactId, actionToken: applyAction.actionToken });
  assert.equal(blocked.applied, false);
  assert.equal(blocked.blocked, "origin-dirty");
});
