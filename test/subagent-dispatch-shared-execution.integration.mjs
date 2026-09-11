import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchExecution, createGenericDispatchAdapter, createCodingDispatchAdapter } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/execution.ts";
import { compileGenericPrompt } from "../packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts";
import { createAuthorizedDispatch } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

async function hostEnvelope(root, agent, kind = "generic") {
  const cwdRoot = join(root, agent);
  await mkdir(cwdRoot);
  return createAuthorizedDispatch({ agent, cwd: cwdRoot }, {
    rootSessionId: "root",
    allowedProfiles: [agent],
    originRoot: root,
    cwdRoot,
    isolation: "shared",
    authorization: createRunAuthorization({ kind, binding: { runId: `run-${agent}`, asyncDir: "/tmp/run", sessionId: "root", pid: 1, agentProfile: agent }, goal: null }),
  });
}

test("generic and coding adapters converge on one execution service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const genericAuthorization = await hostEnvelope(root, "reviewer");
  const codingAuthorization = await hostEnvelope(root, "executor", "coding");
  const calls = [];
  const execute = (request) => { calls.push(request); return { runId: `run-${calls.length}` }; };
  const generic = createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt: compileGenericPrompt({ task: "inspect", context: ["facts"], constraints: ["safe"], deliverable: "report", done: ["done"] }), cwd: "/repo" });
  const coding = createCodingDispatchAdapter({ agent: "executor", prompt: "# Coding Dispatch Contract v1", contractHash: "a".repeat(64), cwd: "/repo" });
  const genericReceipt = await dispatchExecution(generic, { authorizedDispatch: genericAuthorization, execute });
  const codingReceipt = await dispatchExecution(coding, { authorizedDispatch: codingAuthorization, execute });
  assert.equal(genericReceipt.runId, "run-1");
  assert.equal(codingReceipt.runId, "run-2");
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /# Generic Subagent Prompt/);
  assert.match(calls[0].prompt, /## Task/);
  assert.match(calls[0].prompt, /## Context/);
  assert.match(calls[0].prompt, /## Constraints/);
  assert.match(calls[0].prompt, /## Deliverable/);
  assert.match(calls[0].prompt, /## Done/);
  assert.equal(calls[0].worktree, false);
  assert.equal(calls[1].worktree, false);
  assert.equal(calls[1].contractHash, "a".repeat(64));
});

test("public adapters reject authority fields and shared execution requires a Host envelope", async (t) => {
  const prompt = compileGenericPrompt({ task: "inspect", context: [], constraints: [], deliverable: "report", done: ["done"] });
  assert.throws(() => createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt, cwd: "/repo", authorization: {} }), /authority/i);
  const fake = { request: { agent: "reviewer", cwd: "/repo", isolation: "shared" } };
  await assert.rejects(() => dispatchExecution(createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt, cwd: "/repo" }), {
    authorizedDispatch: fake,
    execute: () => ({ runId: "must-not-run" }),
  }), /Host-authorized/);
  const root = await mkdtemp(join(tmpdir(), "shared-execution-"));
  const cwdRoot = join(root, "cwd");
  await mkdir(cwdRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const envelope = await createAuthorizedDispatch({ agent: "reviewer", cwd: cwdRoot }, {
    rootSessionId: "root",
    allowedProfiles: ["reviewer"],
    originRoot: root,
    cwdRoot,
    isolation: "shared",
    authorization: createRunAuthorization({ kind: "generic", binding: { runId: "run", asyncDir: "/tmp/run", sessionId: "root", pid: 1, agentProfile: "reviewer" }, goal: null }),
  });
  let seen;
  await dispatchExecution(createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt, cwd: "/repo" }), {
    authorizedDispatch: envelope,
    execute: (value) => { seen = value; return { runId: "run" }; },
  });
  assert.equal(seen.authorizedDispatch, envelope);
});

test("shared execution rejects a missing Host envelope before executing", async () => {
  const prompt = compileGenericPrompt({ task: "inspect", context: [], constraints: [], deliverable: "report", done: ["done"] });
  await assert.rejects(() => dispatchExecution(createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt, cwd: "/repo" }), {
    execute: () => ({ runId: "must-not-run" }),
  }), /Host-authorized/);
});

test("managed workspace service is the only cwd replacement and missing state root is non-blocking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorization = await hostEnvelope(root, "reviewer");
  let seen;
  const request = createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt: compileGenericPrompt({ task: "inspect", context: [], constraints: [], deliverable: "report", done: ["done"] }), cwd: "/repo" });
  const receipt = await dispatchExecution(request, {
    authorizedDispatch: authorization,
    workspace: { dispatchCwd: "/managed/workspace" },
    execute: (value) => { seen = value; return { runId: "run" }; },
  });
  assert.equal(receipt.runId, "run");
  assert.equal(seen.cwd, "/managed/workspace");
  assert.equal(seen.worktree, false);
});
