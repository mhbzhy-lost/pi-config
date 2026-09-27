import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { createAuthorizedDispatch } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts";

const rootSessionId = "root-session-42";

function authorization() {
  return createRunAuthorization({
    kind: "coding",
    binding: {
      runId: "run-42",
      asyncDir: "/tmp/pi-subagents/run-42",
      sessionId: rootSessionId,
      pid: 4242,
      agentProfile: "executor",
    },
    goal: null,
  });
}

async function fixture(t, isolation = "managed-workspace") {
  const root = await mkdtemp(join(tmpdir(), "execution-contract-"));
  const originRoot = join(root, "origin");
  const cwdRoot = join(originRoot, "project");
  const outside = join(root, "outside");
  await Promise.all([mkdir(cwdRoot, { recursive: true }), mkdir(outside)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    cwdRoot,
    grant: {
      rootSessionId,
      allowedProfiles: ["executor", "reviewer"],
      originRoot,
      cwdRoot,
      isolation,
      authorization: authorization(),
    },
    originRoot,
    outside,
  };
}

test("Host factory brands an envelope and preserves the Host authorization matrix", async (t) => {
  const { cwdRoot, grant } = await fixture(t);
  const dispatch = await createAuthorizedDispatch({
    agent: "reviewer",
    cwd: cwdRoot,
    model: "untrusted-model",
    prompt: "untrusted prompt",
  }, grant);

  assert.equal(dispatch.request.agent, "reviewer");
  assert.equal(dispatch.request.cwd, await realpath(cwdRoot));
  assert.equal(dispatch.request.isolation, "managed-workspace");
  assert.equal(dispatch.request.model, "untrusted-model");
  assert.equal(dispatch.request.prompt, "untrusted prompt");
  assert.strictEqual(dispatch.authorization, grant.authorization);
  assert.deepEqual(dispatch.authorization.capabilities, ["root.subscribe"]);
  assert.equal(Object.isFrozen(dispatch), true);
  assert.deepEqual(Object.keys(dispatch), ["request", "authorization"]);
  assert.doesNotMatch(JSON.stringify(dispatch), /authorized-dispatch/);
});

test("public authorization-like fields fail closed", async (t) => {
  const { grant } = await fixture(t);
  for (const field of ["authorization", "capabilities", "goal", "ticket", "workspacePolicy"]) {
    await assert.rejects(
      createAuthorizedDispatch({ agent: "executor", [field]: { forged: true } }, grant),
      /unknown|authorization|capabilit|goal|ticket|workspace/i,
      field,
    );
  }
});

test("allowed profiles and root session bind the Host grant", async (t) => {
  const { grant } = await fixture(t);
  await assert.rejects(createAuthorizedDispatch({ agent: "admin" }, grant), /profile|allowed/i);
  await assert.rejects(
    createAuthorizedDispatch({ agent: "executor" }, { ...grant, rootSessionId: "foreign-root" }),
    /root session|session/i,
  );
});

test("cwd confinement canonicalizes symlinks and rejects origin escapes", async (t) => {
  const { cwdRoot, grant, outside } = await fixture(t);
  const nested = join(cwdRoot, "nested");
  const escaped = join(cwdRoot, "escaped");
  await mkdir(nested);
  await symlink(outside, escaped);

  const inside = await createAuthorizedDispatch({ agent: "executor", cwd: nested }, grant);
  assert.equal(inside.request.cwd, await realpath(nested));
  await assert.rejects(createAuthorizedDispatch({ agent: "executor", cwd: escaped }, grant), /cwd|outside|confined/i);
  await assert.rejects(createAuthorizedDispatch({ agent: "executor", cwd: outside }, grant), /cwd|outside|confined/i);
});

test("managed state roots cannot become a dispatch cwd", async (t) => {
  const { grant, originRoot } = await fixture(t);
  const stateRoot = join(originRoot, "managed-state");
  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  await mkdir(stateRoot);
  process.env.PI_CODING_WORKSPACE_DIR = stateRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
  });

  await assert.rejects(createAuthorizedDispatch({ agent: "executor", cwd: stateRoot }, grant), /managed state|cwd/i);
});

test("cwd 落在 managed state root 内时报 INVALID_EXECUTION_CWD，而非 SUBAGENT_RPC_FAILED", async (t) => {
  const { cwdRoot, grant } = await fixture(t);
  const stateRoot = join(cwdRoot, "managed-state");
  const inside = join(stateRoot, "repositories", "aa", "worktrees", "wt-1");
  await mkdir(inside, { recursive: true });

  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  process.env.PI_CODING_WORKSPACE_DIR = stateRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
  });

  await assert.rejects(
    createAuthorizedDispatch({ agent: grant.allowedProfiles[0], cwd: inside }, grant),
    (error) => {
      assert.equal(error.code, "INVALID_EXECUTION_CWD", `实际 code=${error.code}`);
      assert.notEqual(error.code, "SUBAGENT_RPC_FAILED");
      assert.equal("operation" in error, false, "不得携带 operation，否则会被兜底逻辑判为 RPC 失败");
      assert.match(error.message, /managed state root/);
      assert.ok(error.message.includes(inside), "message 应回显实际 cwd");
      assert.match(error.message, /repository origin|execution\\.worktree/, "message 应给出下一步");
      assert.equal(error.detail?.code, "INVALID_EXECUTION_CWD");
      assert.equal(error.detail?.keypath, "cwd");
      return true;
    },
  );
});

test("既有 fail() 调用点的 message 文本未被改变", async (t) => {
  const { grant, cwdRoot } = await fixture(t);
  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  process.env.PI_CODING_WORKSPACE_DIR = join(cwdRoot, "managed-state");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
  });

  await assert.rejects(
    createAuthorizedDispatch({ agent: "definitely-not-an-allowed-profile", cwd: grant.cwdRoot }, grant),
    (error) => {
      assert.equal(error.message, "Dispatch execution contract is invalid: dispatch request agent is not an allowed profile");
      return true;
    },
  );
});

test("callers may narrow shared isolation but cannot downgrade managed isolation", async (t) => {
  const managed = await fixture(t, "managed-workspace");
  await assert.rejects(
    createAuthorizedDispatch({ agent: "executor", isolation: "shared" }, managed.grant),
    /isolation|shared|managed/i,
  );
  await assert.rejects(
    createAuthorizedDispatch({ agent: "executor", worktree: false }, managed.grant),
    /isolation|shared|managed/i,
  );

  const shared = await fixture(t, "shared");
  const narrowed = await createAuthorizedDispatch({ agent: "executor", isolation: "managed-workspace" }, shared.grant);
  assert.equal(narrowed.request.isolation, "managed-workspace");
});

test("forged envelope with a same-description symbol is rejected", async () => {
  const { dispatchExecution, createGenericDispatchAdapter } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/execution.ts");
  const { compileGenericPrompt } = await import("../packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts");
  const prompt = compileGenericPrompt({ task: "inspect", context: [], constraints: [], deliverable: "report", done: ["done"] });
  const forgedBrand = Symbol("authorized-dispatch");
  const forged = Object.freeze({
    request: { agent: "reviewer", cwd: "/repo", isolation: "shared" },
    authorization: authorization(),
    [forgedBrand]: true,
  });
  await assert.rejects(
    () => dispatchExecution(createGenericDispatchAdapter({ agent: "reviewer", title: "Review", prompt, cwd: "/repo" }), {
      authorizedDispatch: forged,
      execute: () => ({ runId: "must-not-run" }),
    }),
    /Host-authorized/,
  );
});
