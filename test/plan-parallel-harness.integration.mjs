import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createPlanHostRuntime } from "../scripts/lib/plan/plan-host-runtime.mjs";
import { createPlanLauncherExtension } from "../scripts/lib/plan/plan-launcher-extension.mjs";
import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import { createPlanWorkspace } from "../scripts/lib/plan/workspace.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const provider = path.join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
const planRunnerExtension = path.join(repoRoot, "test", "fixtures", "plan-harness", "plan-runner-extension.ts");
const sourcePlan = path.join(repoRoot, "test", "fixtures", "plan-harness", "plans", "parallel-success.md");
const sourceAttentionPlan = path.join(repoRoot, "test", "fixtures", "plan-harness", "plans", "attention-roundtrip.md");

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function waitForPlanStatus(file, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(file, "utf8"));
      if (predicate(last)) return last;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Plan Harness timed out; last status=${JSON.stringify(last)}`);
}

test("real submodule Standalone Plan Runner reaches validated and produces the requested artifact", { timeout: 300_000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN is required for the Plan Harness integration test");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-harness-real-"));
  const sourceRepo = path.join(root, "source-repo");
  const superproject = path.join(root, "superproject");
  const origin = path.join(superproject, "plugins", "fixture");
  const stateRoot = origin;
  let handle;
  let host;
  let passed = false;
  try {
    await mkdir(path.join(sourceRepo, "docs"), { recursive: true });
    await mkdir(path.join(sourceRepo, ".pi", "agents"), { recursive: true });
    await mkdir(superproject, { recursive: true });
    await git(sourceRepo, "init");
    await git(sourceRepo, "config", "user.email", "harness@example.com");
    await git(sourceRepo, "config", "user.name", "Plan Harness");
    await writeFile(path.join(sourceRepo, "README.md"), "base\n");
    await copyFile(sourcePlan, path.join(sourceRepo, "docs", "plan.md"));
    await writeFile(path.join(sourceRepo, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic Plan Harness executor
model: fake/deterministic
thinking: off
temperature: 0
tools: bash,read,contact_supervisor
subagentOnlyExtensions: ${provider}
---
Execute only the approved task and commit the result.
`);
    await git(sourceRepo, "add", ".");
    await git(sourceRepo, "commit", "-m", "harness base");
    await git(superproject, "init");
    await git(superproject, "config", "user.email", "harness@example.com");
    await git(superproject, "config", "user.name", "Plan Harness");
    await git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", sourceRepo, "plugins/fixture");
    await git(superproject, "commit", "-am", "add harness submodule");
    const baseCommit = await git(origin, "rev-parse", "HEAD");
    const planId = "real-smoke";
    const lease = await createPlanWorkspace({ originRoot: origin, stateRoot, planId, baseCommit });
    const planPath = path.join(lease.workspacePath, "docs", "plan.md");
    const plan = parsePlanDocument(await readFile(planPath, "utf8"), planPath);
    const runDir = path.join(stateRoot, "var", "plan-runs", planId, "host");
    const statusPath = path.join(stateRoot, "var", "plan-runs", planId, "status.json");
    host = createPlanHostRuntime({
      model: "fake/deterministic",
      extraExtensions: [provider, path.join(repoRoot, "pi", "npm", "node_modules", "pi-subagents")],
      noExtensions: true,
      promptMarker: "PI_PLAN_HARNESS_STANDALONE",
    });
    handle = await host.spawnPlanRunner({
      planId,
      planPath,
      planHash: plan.sha256,
      baseCommit,
      originRoot: origin,
      stateRoot,
      cwd: lease.workspacePath,
      extension: planRunnerExtension,
      runDir,
      statusPath,
    });

    const status = await waitForPlanStatus(statusPath, (value) => ["validated", "blocked", "cancelled"].includes(value.lifecycle));
    assert.equal(status.lifecycle, "validated", JSON.stringify(status));
    assert.equal(status.validatedHead, status.headCommit);
    assert.equal(status.tasks.length, 2);
    assert.ok(status.tasks.every((task) => task.status === "accepted"), JSON.stringify(status.tasks));
    const attempts = status.tasks.map((task) => task.attempts[0]);
    assert.ok(attempts.every((attempt) => attempt.status === "integrated"), JSON.stringify(attempts));
    assert.ok(attempts.every((attempt) => attempt.baseCommit === baseCommit), JSON.stringify(attempts));
    assert.equal(await readFile(path.join(lease.workspacePath, "README.md"), "utf8"), "base\nworker\n");
    assert.equal(await readFile(path.join(lease.workspacePath, "worker.txt"), "utf8"), "worker-2\n");
    assert.equal(await git(lease.workspacePath, "rev-list", "--count", `${baseCommit}..HEAD`), "2");
    assert.equal(await git(lease.workspacePath, "status", "--porcelain"), "");
    for (const attempt of attempts) {
      await assert.rejects(access(path.join(stateRoot, "var", "plan-worktrees", planId, "attempts", attempt.attemptId)));
    }
    passed = true;
    t.diagnostic(`scenario=parallel-success lifecycle=${status.lifecycle} validatedHead=${status.validatedHead}`);
  } finally {
    if (handle && host) await host.stop(handle).catch(() => {});
    if (passed && process.env.PLAN_HARNESS_PRESERVE !== "1") {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } else {
      t.diagnostic(`preserved=${root}`);
    }
  }
});

test("real Root bridge keeps Attention pending until a fenced user decision resumes the Executor", { timeout: 300_000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN is required for the Plan Harness integration test");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-harness-attention-"));
  const sourceRepo = path.join(root, "source-repo");
  const superproject = path.join(root, "superproject");
  const origin = path.join(superproject, "plugins", "fixture");
  const planId = "real-attention";
  const attentionMessages = [];
  const tools = new Map();
  const handlers = new Map();
  let handle;
  let host;
  let passed = false;
  try {
    await mkdir(path.join(sourceRepo, "docs"), { recursive: true });
    await mkdir(path.join(sourceRepo, ".pi", "agents"), { recursive: true });
    await mkdir(superproject, { recursive: true });
    await git(sourceRepo, "init");
    await git(sourceRepo, "config", "user.email", "harness@example.com");
    await git(sourceRepo, "config", "user.name", "Plan Harness");
    await writeFile(path.join(sourceRepo, "README.md"), "base\n");
    await copyFile(sourceAttentionPlan, path.join(sourceRepo, "docs", "plan.md"));
    await writeFile(path.join(sourceRepo, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic Attention executor
model: fake/deterministic
thinking: off
temperature: 0
tools: bash,read,contact_supervisor
subagentOnlyExtensions: ${provider}
---
Request the required decision, then execute only the approved task and commit the result.
`);
    await git(sourceRepo, "add", ".");
    await git(sourceRepo, "commit", "-m", "harness attention base");
    await git(superproject, "init");
    await git(superproject, "config", "user.email", "harness@example.com");
    await git(superproject, "config", "user.name", "Plan Harness");
    await git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", sourceRepo, "plugins/fixture");
    await git(superproject, "commit", "-am", "add attention harness submodule");

    host = createPlanHostRuntime({
      model: "fake/deterministic",
      extraExtensions: [provider, path.join(repoRoot, "pi", "npm", "node_modules", "pi-subagents")],
      noExtensions: true,
      promptMarker: "PI_PLAN_HARNESS_STANDALONE",
      emitAttention: async (message) => { attentionMessages.push(message); },
    });
    const pi = {
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand() {},
      on(name, handler) { handlers.set(name, handler); },
      appendEntry() {},
      sendMessage() {},
    };
    createPlanLauncherExtension(pi, {
      originRoot: origin,
      stateRoot: origin,
      hostRuntime: host,
      planRunnerEntry: planRunnerExtension,
      attentionPollIntervalMs: 25,
      id: () => planId,
    });

    const launched = await tools.get("plan_run").execute(
      "launch",
      { planPath: path.join(origin, "docs", "plan.md") },
      undefined,
      undefined,
      {},
    );
    assert.equal(launched.isError, undefined, launched.content[0].text);
    handle = JSON.parse(launched.content[0].text);
    const statusPath = path.join(origin, "var", "plan-runs", planId, "status.json");
    const waiting = await waitForPlanStatus(statusPath, (status) => status.tasks?.some((task) =>
      task.attempts?.some((attempt) => attempt.status === "waiting-attention" && attempt.attention?.status === "pending")
    ));
    const waitingAttempt = waiting.tasks.flatMap((task) => task.attempts)
      .find((attempt) => attempt.status === "waiting-attention");

    const notificationDeadline = Date.now() + 10_000;
    while (attentionMessages.length === 0 && Date.now() < notificationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(attentionMessages.length, 1);
    const notification = attentionMessages[0];
    assert.match(notification.content, /wait for an explicit decision/i);
    assert.match(notification.content, /plan_attention_reply/);
    assert.doesNotMatch(notification.content, /Approve the deterministic Plan Harness change/);
    assert.match(
      await readFile(path.join(origin, "var", "plan-runs", planId, notification.details.bodyPath), "utf8"),
      /Approve the deterministic Plan Harness change/,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeReply = JSON.parse(await readFile(statusPath, "utf8"));
    const stillPending = beforeReply.tasks.flatMap((task) => task.attempts)
      .find((attempt) => attempt.attemptId === waitingAttempt.attemptId);
    assert.equal(stillPending.status, "waiting-attention");
    assert.equal(stillPending.attention.status, "pending");

    const replied = await tools.get("plan_attention_reply").execute("reply", {
      planId,
      requestId: waitingAttempt.attention.requestId,
      expectedProjectionVersion: waitingAttempt.attention.projectionVersion,
      message: "APPROVED",
    }, undefined, undefined, {});
    assert.equal(replied.isError, undefined, replied.content[0].text);

    const finalStatus = await waitForPlanStatus(statusPath, (status) => ["validated", "blocked", "cancelled"].includes(status.lifecycle));
    assert.equal(finalStatus.lifecycle, "validated", JSON.stringify(finalStatus));
    assert.equal(await readFile(path.join(handle.worktree, "decision.txt"), "utf8"), "approved\n");
    const finalAttempt = finalStatus.tasks[0].attempts[0];
    assert.equal(finalAttempt.attention.status, "resolved");
    passed = true;
    t.diagnostic(`scenario=attention-roundtrip lifecycle=${finalStatus.lifecycle} requestId=${waitingAttempt.attention.requestId}`);
  } finally {
    try { await handlers.get("session_shutdown")?.(); } catch {}
    if (handle && host) await host.stop(handle).catch(() => {});
    if (passed && process.env.PLAN_HARNESS_PRESERVE !== "1") {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } else {
      t.diagnostic(`preserved=${root}`);
    }
  }
});
