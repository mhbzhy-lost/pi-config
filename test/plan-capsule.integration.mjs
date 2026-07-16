import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createPlanRunnerDependencies } from "../scripts/lib/plan/plan-runner-dependencies.mjs";
import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import { processesReferencing, terminateDetachedRun } from "./support/plan-e2e-process-cleanup.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const reportPrefix = "PI_PLAN_HANDLE=";

function runRpcUntil(command, args, { input, onSpawn, until, closeWhen, timeoutMs = 60_000, ...options }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    onSpawn?.(child);
    const records = [];
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let timedOut = false;
    let stdinClosed = false;
    let closeWhenPending = false;
    let predicateError;
    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      child.stdin.end();
    };
    const evaluateCloseWhen = (record) => {
      if (!closeWhen || closeWhenPending || stdinClosed) return;
      closeWhenPending = true;
      Promise.resolve(closeWhen(record, records)).then((shouldClose) => {
        if (shouldClose) closeStdin();
        else closeWhenPending = false;
      }, (error) => {
        predicateError = error;
        child.kill("SIGTERM");
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const record = JSON.parse(line);
        records.push(record);
        if (until?.(record, records)) closeStdin();
        evaluateCloseWhen(record);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({
        error: predicateError ?? (timedOut ? new Error(`Pi RPC timed out after ${timeoutMs}ms`) : undefined),
        status,
        signal,
        stdout,
        stderr,
        records,
      });
    });
    child.stdin.write(`${input}\n`);
  });
}

function runRpcPromptsUntil(command, args, { inputs, onSpawn, onRecord, until, closeWhen, timeoutMs = 90_000, ...options }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    onSpawn?.(child);
    const records = [];
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let timedOut = false;
    let stdinClosed = false;
    let closeWhenPending = false;
    let predicateError;
    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      child.stdin.end();
    };
    const evaluateCloseWhen = (record) => {
      if (!closeWhen || closeWhenPending || stdinClosed) return;
      closeWhenPending = true;
      Promise.resolve(closeWhen(record, records)).then((shouldClose) => {
        if (shouldClose) closeStdin();
        else closeWhenPending = false;
      }, (error) => {
        predicateError = error;
        child.kill("SIGTERM");
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const record = JSON.parse(line);
        records.push(record);
        onRecord?.(record, records, child.stdin);
        if (until?.(record, records)) closeStdin();
        evaluateCloseWhen(record);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({
        error: predicateError ?? (timedOut ? new Error(`Pi RPC timed out after ${timeoutMs}ms`) : undefined),
        status,
        signal,
        stdout,
        stderr,
        records,
      });
    });
    for (const input of inputs) child.stdin.write(`${input}\n`);
  });
}

function notification(records, prefix) {
  return records.find((record) => record.type === "extension_ui_request"
    && record.method === "notify"
    && record.message?.startsWith(prefix));
}

async function waitFor(path, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(path, "utf8"));
      if (predicate(last)) return last;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${path}; last=${JSON.stringify(last)}`);
}

async function waitForMissing(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${path} to be removed`);
}

async function waitForProcessExit(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

async function waitForJsonLines(path, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let entries = [];
  while (Date.now() < deadline) {
    try {
      entries = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      if (predicate(entries)) return entries;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for JSONL events in ${path}; entries=${JSON.stringify(entries)}`);
}

async function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function diagnostic(file) {
  try { return await readFile(file, "utf8"); } catch (error) { return `<${error.code ?? error.message}>`; }
}

async function artifactDiagnostics(root) {
  const files = await readdir(root, { recursive: true }).catch(() => []);
  const selected = files.filter((file) => /(?:status\.json|events\.jsonl|stderr\.log|session\.jsonl)$/.test(file));
  return (await Promise.all(selected.map(async (file) => `${file}:\n${await diagnostic(join(root, file))}`))).join("\n");
}

const domainPlanSource = `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Ship it

**Files:**
- Create: \`src/a.mjs\`
`;

async function persistedDomainFixture(t, planId = "persisted-domain") {
  const origin = await mkdtemp(join(tmpdir(), "pi-plan-capsule-domain-"));
  const worktree = join(origin, "worktree");
  const planPath = join(origin, "approved-plan.md");
  await writeFile(join(origin, "README.md"), "base\n");
  await git(origin, "init");
  await git(origin, "config", "user.email", "plan@example.test");
  await git(origin, "config", "user.name", "Plan Test");
  await git(origin, "add", "README.md");
  await git(origin, "commit", "-m", "base");
  const baseCommit = await git(origin, "rev-parse", "HEAD");
  await git(origin, "worktree", "add", "-b", `pi-plan/${planId}`, worktree, baseCommit);
  await writeFile(planPath, domainPlanSource);
  t.after(() => rm(origin, { recursive: true, force: true }));
  const { sha256, tasks } = parsePlanDocument(domainPlanSource, planPath);
  const binding = { planId, planPath, planHash: sha256, baseCommit, worktree, allowPlanCommits: true };
  const statusPath = join(origin, "var", "plan-runs", planId, "status.json");
  const eventsPath = join(origin, "events.jsonl");
  const entries = [];
  const append = async (entry) => {
    entries.push(entry);
    await writeFile(eventsPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
  };
  const created = {
    schemaVersion: "pi-plan-event.v1",
    eventId: "created",
    planId,
    occurredAt: "2026-07-15T00:00:00.000Z",
    type: "plan.created",
    data: {
      workspace: { originRoot: origin, worktree, baseCommit, headCommit: baseCommit, planPath, planHash: sha256 },
      tasks: tasks.map((task) => task.id),
    },
  };
  await append(created);
  async function replayContext() {
    const persisted = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    return { cwd: worktree, sessionManager: { getBranch: () => persisted.map((data) => ({ customType: "pi-plan-event-v1", data })) } };
  }
  function factory(options = {}) {
    return createPlanRunnerDependencies({
      pi: { appendEntry(_type, entry) { return append(entry); } },
      runtimePollIntervalMs: 0,
      runtimePollTimeoutMs: 10,
      ...options,
    });
  }
  return { origin, worktree, planId, binding, statusPath, eventsPath, entries, append, replayContext, factory };
}

test("persisted domain integration: stale gate evidence is not reused after HEAD advances", async (t) => {
  const repo = await persistedDomainFixture(t, "persisted-stale-gate");
  await writeFile(join(repo.worktree, "src-a.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "src-a.mjs");
  await git(repo.worktree, "commit", "-m", "first change");
  const firstHead = await git(repo.worktree, "rev-parse", "HEAD");
  await repo.append({ schemaVersion: "pi-plan-event.v1", eventId: "accepted", planId: repo.planId, occurredAt: "2026-07-15T00:00:01.000Z", type: "task.accepted", data: { taskId: "task-1" } });

  const first = repo.factory({
    audit: async () => {
      await writeFile(join(repo.worktree, "src-b.mjs"), "export default 2;\n");
      await git(repo.worktree, "add", "src-b.mjs");
      await git(repo.worktree, "commit", "-m", "head advanced during gates");
      return { findings: [] };
    },
    externalReview: async () => ({ available: true, findings: [] }),
  });
  assert.equal((await first.verifyPlan({ ctx: await repo.replayContext() })).validated, false);
  const currentHead = await git(repo.worktree, "rev-parse", "HEAD");
  const restarted = repo.factory({ audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }) });
  const status = await restarted.status({ ctx: await repo.replayContext() });

  assert.equal(status.lifecycle, "verifying");
  assert.equal(status.validatedHead, null);
  assert.notEqual(status.validatedHead, currentHead);
  assert.equal((await restarted.verifyPlan({ ctx: await repo.replayContext() })).validated, true);
  assert.deepEqual((await readFile(repo.eventsPath, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.type === "workspace.head-observed").map((entry) => entry.data.headCommit), [firstHead, currentHead]);
});

test("persisted domain integration: failed worker recovery settles without accepting or validating", async (t) => {
  const repo = await persistedDomainFixture(t, "persisted-worker-crash");
  const initial = repo.factory();
  const next = await initial.continuePlan({}, { ctx: await repo.replayContext() });
  initial.authorizeNestedSubagent(next.tool, { ctx: await repo.replayContext() });
  const recovered = repo.factory({ readRuntimeArtifacts: async () => ({ status: { kind: "stable", value: { state: "failed" } } }) });
  const result = await recovered.handleNestedResult({ toolName: "subagent", input: next.tool, details: { runId: "crashed-run", asyncDir: "/stable/crashed-run" } }, { ctx: await repo.replayContext() });
  const entries = (await readFile(repo.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const status = JSON.parse(await readFile(repo.statusPath, "utf8"));

  assert.equal(result.state, "failed");
  assert.deepEqual(entries.map((entry) => entry.type), ["plan.created", "attempt.dispatch-requested", "attempt.bound", "attempt.settled"]);
  assert.equal(entries.some((entry) => entry.type === "task.accepted" || entry.type === "plan.validated"), false);
  assert.equal(status.lifecycle, "running");
  const replayed = repo.factory();
  await replayed.continuePlan({}, { ctx: await repo.replayContext() });
  const dispatches = (await waitForJsonLines(
    repo.eventsPath,
    (events) => events.filter((entry) => entry.type === "attempt.dispatch-requested").length === 2,
  )).filter((entry) => entry.type === "attempt.dispatch-requested");
  assert.equal(dispatches.length, 2);
  assert.notEqual(dispatches[0].eventId, dispatches[1].eventId);
});

test("persisted domain integration: unavailable external review persists gate failure and prevents validation", async (t) => {
  const repo = await persistedDomainFixture(t, "persisted-review-unavailable");
  await writeFile(join(repo.worktree, "src-a.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "src-a.mjs");
  await git(repo.worktree, "commit", "-m", "change");
  await repo.append({ schemaVersion: "pi-plan-event.v1", eventId: "accepted", planId: repo.planId, occurredAt: "2026-07-15T00:00:01.000Z", type: "task.accepted", data: { taskId: "task-1" } });

  const runner = repo.factory({ audit: async () => ({ findings: [] }), externalReview: async () => ({ available: false, findings: [] }) });
  const result = await runner.verifyPlan({ ctx: await repo.replayContext() });
  const entries = (await readFile(repo.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const status = JSON.parse(await readFile(repo.statusPath, "utf8"));

  assert.equal(result.validated, false);
  assert.equal(entries.filter((entry) => entry.type === "gate.finished").find((entry) => entry.data.type === "external-review").data.status, "unavailable");
  assert.equal(entries.some((entry) => entry.type === "plan.validated"), false);
  assert.equal(status.lifecycle, "verifying");
  assert.equal(status.validatedHead, null);
});

test("real Parent Launcher starts a deterministic Plan Runner through stable RPC and persists only a handle", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const planPath = join(originRoot, "approved-plan.md");
  const statePath = join(originRoot, "var", "plan-runs", "e2e-plan", "status.json");
  let handle;

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(originRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    await writeFile(planPath, `# Approved plan\n\n## Execution Contract\n\n\`\`\`json\n{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}\n\`\`\`\n\n### Task 1: Implement fixture\n\n**Files:**\n- Modify: \`README.md\`\n`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({
          pi,
          audit: async () => ({ findings: [] }),
          externalReview: async () => ({ available: true, findings: [] }),
          taskReview: async () => ({ accepted: true, findings: [] }),
          runtimePollTimeoutMs: 30000,
        }));
      }
    `);
    await writeFile(join(originRoot, ".pi", "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(originRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 30000 });
      }
    `);

    const result = await runRpcUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"],
      {
        cwd: originRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
        input: JSON.stringify({ id: "plan-e2e", type: "prompt", message: `/plan-run ${JSON.stringify({ planPath, planId: "e2e-plan", allowPlanCommits: true })}` }),
        until: () => false,
        async closeWhen(record) {
          if (record.type !== "extension_ui_request" || record.method !== "notify" || !record.message?.startsWith(reportPrefix)) return false;
          handle = JSON.parse(record.message.slice(reportPrefix.length));
          await waitFor(statePath, (value) => value.planId === "e2e-plan" && value.lifecycle === "validated", 90_000);
          await waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId && ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state), 90_000);
          return true;
        },
      },
    );

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const event = notification(result.records, reportPrefix);
    assert.ok(event, `missing lifecycle report\nstdout=${result.stdout}\nstderr=${result.stderr}\nartifacts=${await artifactDiagnostics(originRoot)}`);
    handle = JSON.parse(event.message.slice(reportPrefix.length));
    assert.equal(typeof handle.runId, "string", JSON.stringify(handle));
    assert.equal(typeof handle.asyncDir, "string", JSON.stringify(handle));
    assert.equal(typeof handle.sessionFile, "string", JSON.stringify(handle));
    assert.equal(handle.tasks, undefined, JSON.stringify(handle));
    assert.equal(handle.gates, undefined, JSON.stringify(handle));
    assert.equal(handle.attempts, undefined, JSON.stringify(handle));
    let status;
    try {
      status = await waitFor(statePath, (value) => value.planId === "e2e-plan" && value.lifecycle === "validated", 90_000);
    } catch (error) {
      const artifacts = await Promise.all([
        "status.json",
        "events.jsonl",
        "runner.stderr.log",
      ].map(async (name) => `${name}:\n${await diagnostic(join(handle.asyncDir, name))}`));
      const session = await diagnostic(handle.sessionFile);
      throw new Error(`${error.message}\n${artifacts.join("\n")}\nsession:\n${session}`);
    }
    assert.equal(status.lifecycle, "validated", JSON.stringify(status));
    assert.equal(status.validatedHead, await git(handle.worktree, "rev-parse", "HEAD"));
  } finally {
    await terminateDetachedRun(handle);
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test("real Parent keeps a running plan child isolated while handling an unrelated prompt", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-isolation-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-isolation-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const planPath = join(originRoot, "approved-plan.md");
  const statePath = join(originRoot, "var", "plan-runs", "e2e-isolation", "status.json");
  let handle;

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(originRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    await writeFile(planPath, `# Approved plan\n\n## Execution Contract\n\n\`\`\`json\n{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}\n\`\`\`\n\n### Task 1: Implement fixture\n\n**Files:**\n- Modify: \`README.md\`\n`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({ pi, audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }), taskReview: async () => ({ accepted: true, findings: [] }), runtimePollTimeoutMs: 30000 }));
      }
    `);
    await writeFile(join(originRoot, ".pi", "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(originRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 90000 });
      }
    `);

    let sentUnrelatedPrompt = false;
    let agentEndsAfterHandle = 0;
    const result = await runRpcPromptsUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"],
      {
        cwd: originRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
        inputs: [JSON.stringify({ id: "plan-isolation", type: "prompt", message: `/plan-run ${JSON.stringify({ planPath, planId: "e2e-isolation", allowPlanCommits: true })}` })],
        onRecord(record, _records, stdin) {
          const event = record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith(reportPrefix);
          if (event && !sentUnrelatedPrompt) {
            handle = JSON.parse(record.message.slice(reportPrefix.length));
            sentUnrelatedPrompt = true;
            stdin.write(`${JSON.stringify({ id: "unrelated", type: "prompt", message: "What is 2 + 2?" })}\n`);
          }
          if (sentUnrelatedPrompt && record.type === "agent_end") agentEndsAfterHandle += 1;
        },
        until: () => false,
        async closeWhen() {
          if (!handle || agentEndsAfterHandle < 2) return false;
          await waitFor(statePath, (value) => value.planId === "e2e-isolation" && value.lifecycle === "validated", 90_000);
          await waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId && ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state), 90_000);
          return true;
        },
      },
    );

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(handle, `missing lifecycle handle\n${result.stdout}`);
    assert.equal(handle.planId, "e2e-isolation");
    assert.equal(agentEndsAfterHandle, 2);
    const status = await waitFor(statePath, (value) => value.planId === "e2e-isolation" && value.lifecycle === "validated", 90_000);
    assert.equal(status.validatedHead, await git(handle.worktree, "rev-parse", "HEAD"));
  } finally {
    await terminateDetachedRun(handle);
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test("real Parent runs two deterministic Plan Runners concurrently with isolated lifecycle artifacts", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-concurrent-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-concurrent-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const planPaths = [join(originRoot, "approved-a.md"), join(originRoot, "approved-b.md")];
  const planIds = ["e2e-concurrent-a", "e2e-concurrent-b"];
  const startGatePath = join(originRoot, "concurrent-start-gate.json");
  const handles = [];

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(originRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    for (const planPath of planPaths) await writeFile(planPath, `# Approved plan\n\n## Execution Contract\n\n\`\`\`json\n{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}\n\`\`\`\n\n### Task 1: Implement fixture\n\n**Files:**\n- Modify: \`README.md\`\n`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { readFile } from "node:fs/promises";
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        const waitForPeer = async () => {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            try {
              if (JSON.parse(await readFile(${JSON.stringify(startGatePath)}, "utf8")).released) return;
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("concurrent E2E start gate was not released");
        };
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({ pi, audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }), taskReview: async () => { await waitForPeer(); return { accepted: true, findings: [] }; }, runtimePollTimeoutMs: 30000 }));
      }
    `);
    await writeFile(join(originRoot, ".pi", "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(originRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 90000 });
      }
    `);

    let releaseStartGate;
    const result = await runRpcPromptsUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"],
      {
        cwd: originRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
        inputs: planIds.map((planId, index) => JSON.stringify({ id: `plan-${planId}`, type: "prompt", message: `/plan-run ${JSON.stringify({ planPath: planPaths[index], planId, allowPlanCommits: true })}` })),
        onRecord(record) {
          if (record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith(reportPrefix)) {
            handles.push(JSON.parse(record.message.slice(reportPrefix.length)));
            if (handles.length === 2 && !releaseStartGate) {
              releaseStartGate = writeFile(startGatePath, JSON.stringify({ released: true }));
            }
          }
        },
        until: () => false,
        async closeWhen() {
          if (handles.length !== 2) return false;
          await releaseStartGate;
          await Promise.all(handles.map((handle) => waitFor(handle.statusPath, (value) => value.planId === handle.planId && value.lifecycle === "validated", 90_000)));
          await Promise.all(handles.map((handle) => waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId && ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state), 90_000)));
          return true;
        },
      },
    );

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(handles.length, 2, `missing lifecycle handles\n${result.stdout}`);
    assert.deepEqual(new Set(handles.map((handle) => handle.planId)), new Set(planIds));
    for (const key of ["runId", "asyncDir", "sessionFile", "worktree", "statusPath"]) {
      assert.equal(new Set(handles.map((handle) => handle[key])).size, 2, `${key} must be isolated`);
    }
    const launchedStatuses = await Promise.all(handles.map((handle) => waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId)));
    assert.equal(launchedStatuses.every((status) => status.state !== "completed"), true, "both runs must remain active when their handles coexist");
    const statuses = await Promise.all(handles.map((handle) => waitFor(handle.statusPath, (value) => value.planId === handle.planId && value.lifecycle === "validated", 90_000)));
    for (let index = 0; index < handles.length; index += 1) {
      assert.equal(statuses[index].validatedHead, await git(handles[index].worktree, "rev-parse", "HEAD"));
    }
  } finally {
    await Promise.all(handles.map((handle) => terminateDetachedRun(handle)));
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test("real Parent cancels a running Plan child only after its persisted acknowledgement", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-cancel-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-cancel-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const planPath = join(originRoot, "approved-plan.md");
  const planId = "e2e-cancel";
  const latchPath = join(originRoot, "cancel-latch.json");
  const handles = [];

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(originRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    await writeFile(planPath, `# Approved plan\n\n## Execution Contract\n\n\`\`\`json\n{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}\n\`\`\`\n\n### Task 1: Implement fixture\n\n**Files:**\n- Modify: \`README.md\`\n`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { readFile } from "node:fs/promises";
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        const waitForCancel = async () => {
          while (true) {
            try { if (JSON.parse(await readFile(${JSON.stringify(latchPath)}, "utf8")).released) return; } catch {}
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({ pi, audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }), taskReview: async () => { await waitForCancel(); return { accepted: true, findings: [] }; }, runtimePollTimeoutMs: 30000 }));
      }
    `);
    await writeFile(join(originRoot, ".pi", "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(originRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 90000 });
      }
    `);

    let cancelSent = false;
    let cancelResponse;
    let cancelError;
    const result = await runRpcPromptsUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"],
      {
        cwd: originRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
        inputs: [JSON.stringify({ id: "plan-cancel-run", type: "prompt", message: `/plan-run ${JSON.stringify({ planPath, planId, allowPlanCommits: true })}` })],
        onRecord(record, _records, stdin) {
          const event = record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith(reportPrefix);
          if (event && !cancelSent) {
            const handle = JSON.parse(record.message.slice(reportPrefix.length));
            handles.push(handle);
            cancelSent = true;
            stdin.write(`${JSON.stringify({ id: "plan-cancel", type: "prompt", message: `/plan-cancel ${planId}` })}\n`);
          }
          if (record.type === "extension_error" && record.extensionPath === "command:plan-cancel") cancelError = record;
          if (record.type === "response" && record.id === "plan-cancel") cancelResponse = record;
        },
        until: () => Boolean(cancelResponse),
      },
    );

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(handles.length, 1, `missing lifecycle handle\n${result.stdout}`);
    assert.equal(cancelError, undefined, JSON.stringify(cancelError));
    assert.equal(cancelResponse?.success, true, JSON.stringify(cancelResponse));
    const handle = handles[0];
    const controlRoot = join(originRoot, "var", "plan-runs", planId, "control");
    const request = JSON.parse(await readFile(join(controlRoot, "cancel-request.json"), "utf8"));
    const acknowledgement = JSON.parse(await readFile(join(controlRoot, "cancel-ack.json"), "utf8"));
    assert.equal(acknowledgement.requestId, request.requestId);
    assert.equal(acknowledgement.planId, request.planId);
    assert.equal(acknowledgement.runId, request.runId);
    assert.equal(acknowledgement.lifecycle, "cancelled");
    const planStatus = JSON.parse(await readFile(handle.statusPath, "utf8"));
    assert.equal(planStatus.lifecycle, "cancelled");
    const upstream = await waitFor(join(handle.asyncDir, "status.json"), (value) => ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state), 90_000);
    assert.ok(Date.parse(acknowledgement.occurredAt) <= upstream.lastUpdate, JSON.stringify({ acknowledgement, upstream }));
    const sessionEntries = (await readFile(handle.sessionFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(sessionEntries.some((entry) => entry.customType === "pi-plan-event-v1" && entry.data?.type === "plan.cancelled"));
  } finally {
    await Promise.all(handles.map((handle) => terminateDetachedRun(handle)));
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test("real Parent normal shutdown stops its running Plan child", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-shutdown-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-shutdown-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const planPath = join(originRoot, "approved-plan.md");
  const planId = "e2e-normal-shutdown";
  const latchPath = join(originRoot, "shutdown-latch.json");
  let handle;

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(originRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    await writeFile(planPath, `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Implement fixture

**Files:**
- Modify: \`README.md\`
`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { readFile } from "node:fs/promises";
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        const waitForShutdown = async () => {
          while (true) {
            try { if (JSON.parse(await readFile(${JSON.stringify(latchPath)}, "utf8")).released) return; } catch {}
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({ pi, audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }), taskReview: async () => { await waitForShutdown(); return { accepted: true, findings: [] }; }, runtimePollTimeoutMs: 30000 }));
      }
    `);
    await writeFile(join(originRoot, ".pi", "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(originRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 90000 });
      }
    `);

    const result = await runRpcPromptsUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"],
      {
        cwd: originRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
        inputs: [JSON.stringify({ id: "plan-shutdown-run", type: "prompt", message: `/plan-run ${JSON.stringify({ planPath, planId, allowPlanCommits: true })}` })],
        onRecord(record) {
          const event = record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith(reportPrefix);
          if (!event || handle) return;
          handle = JSON.parse(record.message.slice(reportPrefix.length));
        },
        closeWhen: async () => {
          if (!handle) return false;
          const active = await waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId && value.state === "running");
          assert.ok(Number.isInteger(active.pid) && active.pid > 1, JSON.stringify(active));
          return true;
        },
      },
    );

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(handle, `missing lifecycle handle\n${result.stdout}`);
    const terminal = await waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId && ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state), 90_000);
    const leasePath = join(originRoot, "var", "plan-runs", planId, "control", "parent-lease.json");
    await waitForMissing(leasePath);
    assert.equal(terminal.runId, handle.runId);
    await waitForProcessExit(terminal.pid);
  } finally {
    await terminateDetachedRun(handle);
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test("real Parent crash stops its running Plan child through the parent lease", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-crash-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-crash-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const planPath = join(originRoot, "approved-plan.md");
  const planId = "e2e-parent-crash";
  const latchPath = join(originRoot, "crash-latch.json");
  let handle;
  let parent;
  let parentClose;
  let cleanupNeeded = true;

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(originRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    await writeFile(planPath, `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Implement fixture

**Files:**
- Modify: \`README.md\`
`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { readFile } from "node:fs/promises";
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        const waitForCrash = async () => {
          while (true) {
            try { if (JSON.parse(await readFile(${JSON.stringify(latchPath)}, "utf8")).released) return; } catch {}
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({ pi, audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }), taskReview: async () => { await waitForCrash(); return { accepted: true, findings: [] }; }, runtimePollTimeoutMs: 30000 }));
      }
    `);
    await writeFile(join(originRoot, ".pi", "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(originRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 90000, parentLeaseIntervalMs: 100, parentLeaseTimeoutMs: 1500 });
      }
    `);

    const resultPromise = runRpcPromptsUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"],
      {
        cwd: originRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
        inputs: [JSON.stringify({ id: "plan-crash-run", type: "prompt", message: `/plan-run ${JSON.stringify({ planPath, planId, allowPlanCommits: true })}` })],
        onSpawn(child) {
          parent = child;
          parentClose = new Promise((resolveClose) => child.once("close", (status, signal) => resolveClose({ status, signal })));
        },
        onRecord(record) {
          const event = record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith(reportPrefix);
          if (!event || handle) return;
          handle = JSON.parse(record.message.slice(reportPrefix.length));
        },
        closeWhen: async () => {
          if (!handle) return false;
          const active = await waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId && value.state === "running");
          assert.ok(Number.isInteger(active.pid) && active.pid > 1, JSON.stringify(active));
          assert.equal(parent.kill("SIGKILL"), true, "parent SIGKILL was not delivered");
          return false;
        },
      },
    );

    const result = await resultPromise;
    const closed = await parentClose;
    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(closed.signal, "SIGKILL", JSON.stringify(closed));
    assert.ok(handle, `missing lifecycle handle\n${result.stdout}`);
    const controlRoot = join(originRoot, "var", "plan-runs", planId, "control");
    const parentLost = await waitFor(join(controlRoot, "parent-lost.json"), (value) => value.planId === planId, 30_000);
    assert.equal(parentLost.planId, planId, JSON.stringify(parentLost));
    const terminal = await waitFor(join(handle.asyncDir, "status.json"), (value) => value.runId === handle.runId && ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state), 30_000);
    await waitForProcessExit(terminal.pid);
    assert.deepEqual(await processesReferencing(originRoot, packageRoot), []);
    cleanupNeeded = false;
  } finally {
    if (cleanupNeeded) await terminateDetachedRun(handle);
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test("real Parent restart observes the terminated run without respawning or takeover", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-restart-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-restart-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const planPath = join(originRoot, "approved-plan.md");
  const planId = "e2e-restart";
  const latchPath = join(originRoot, "restart-latch.json");
  const sessionDir = join(originRoot, "parent-sessions");
  const sessionId = "e2e-parent-restart";
  const handles = [];

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(originRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    await writeFile(planPath, `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Implement fixture

**Files:**
- Modify: \`README.md\`
`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { readFile } from "node:fs/promises";
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        const waitForRestart = async () => {
          while (true) {
            try { if (JSON.parse(await readFile(${JSON.stringify(latchPath)}, "utf8")).released) return; } catch {}
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({ pi, audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }), taskReview: async () => { await waitForRestart(); return { accepted: true, findings: [] }; }, runtimePollTimeoutMs: 30000 }));
      }
    `);
    await writeFile(join(originRoot, ".pi", "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(originRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 90000 });
      }
    `);

    const firstParentArgs = ["--mode", "rpc", "--session-dir", sessionDir, "--session-id", sessionId, "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"];
    const first = await runRpcUntil(piBinary, firstParentArgs, {
      cwd: originRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
      input: JSON.stringify({ id: "plan-restart-run", type: "prompt", message: `/plan-run ${JSON.stringify({ planPath, planId, allowPlanCommits: true })}` }),
      until: (record) => record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith(reportPrefix),
    });
    assert.equal(first.error, undefined, `${first.error?.message}\n${first.stderr}\n${first.stdout}`);
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
    const launch = notification(first.records, reportPrefix);
    assert.ok(launch, `missing lifecycle handle\n${first.stdout}`);
    const original = JSON.parse(launch.message.slice(reportPrefix.length));
    handles.push(original);
    const active = await waitFor(join(original.asyncDir, "status.json"), (value) => value.runId === original.runId && !["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state));
    const parentSessionFiles = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
    assert.deepEqual(parentSessionFiles, [], "slash-only Parent session must not be required for handle recovery");

    const leasePath = join(originRoot, "var", "plan-runs", planId, "control", "parent-lease.json");
    const terminal = await waitFor(join(original.asyncDir, "status.json"), (value) => value.runId === original.runId && ["complete", "failed", "timedOut", "cancelled", "stopped"].includes(value.state), 30_000);
    await waitForProcessExit(terminal.pid);
    await waitForMissing(leasePath);

    let recoverResponse;
    let recoverNotification;
    let recoverError;
    const secondParentArgs = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"];
    const second = await runRpcPromptsUntil(piBinary, secondParentArgs, {
      cwd: originRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" },
      inputs: [JSON.stringify({ id: "plan-restart-recover", type: "prompt", message: `/plan-recover ${planId}` })],
      onRecord(record) {
        if (record.type === "extension_error" && record.extensionPath === "command:plan-recover") recoverError = record;
        if (record.type === "extension_ui_request" && record.method === "notify" && record.message?.includes(original.runId)) recoverNotification = record;
        if (record.type === "response" && record.id === "plan-restart-recover") recoverResponse = record;
      },
      until: () => Boolean(recoverResponse),
    });
    assert.equal(second.error, undefined, `${second.error?.message}\n${second.stderr}\n${second.stdout}`);
    assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
    assert.equal(recoverError, undefined, JSON.stringify(recoverError));
    assert.equal(recoverResponse?.success, true, JSON.stringify(recoverResponse));
    assert.ok(recoverNotification, `missing recover notification\n${second.stdout}`);
    assert.equal(notification(second.records, reportPrefix), undefined, "recover must not append a second launch handle");
    const persistedHandle = JSON.parse(await readFile(join(originRoot, "var", "plan-runs", planId, "parent-handle.json"), "utf8"));
    assert.deepEqual(persistedHandle, original);
    const recovered = JSON.parse(recoverNotification.message);
    assert.equal(recovered.runId, original.runId, JSON.stringify(recovered));
    assert.equal(recovered.asyncDir, original.asyncDir, JSON.stringify(recovered));
    assert.equal(recovered.sessionFile, original.sessionFile, JSON.stringify(recovered));
    assert.equal(recovered.worktree, original.worktree, JSON.stringify(recovered));
    assert.match(recovered.status.text, new RegExp(`^State: ${terminal.state}$`, "m"), JSON.stringify(recovered));
    assert.equal(recovered.ownerState, undefined, JSON.stringify(recovered));
    assert.equal(recovered.blocked, undefined, JSON.stringify(recovered));
    assert.equal(recovered.takeover, undefined, JSON.stringify(recovered));
    assert.equal(await access(leasePath).then(() => true, () => false), false, "recovery must not recreate the Parent lease");
    assert.deepEqual((await readdir(dirname(original.asyncDir))).filter((entry) => entry === original.runId), [original.runId]);
    const finalStatus = JSON.parse(await readFile(join(original.asyncDir, "status.json"), "utf8"));
    assert.equal(finalStatus.runId, original.runId);
    assert.equal(finalStatus.state, terminal.state);
    assert.notEqual(finalStatus.lifecycle, "validated");
  } finally {
    await Promise.all(handles.map((handle) => terminateDetachedRun(handle)));
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test("real Plan Runner preserves plan.created in compaction before the fixed detached runner exits", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-compact-package-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pi-plan-capsule-compact-origin-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
  const probe = join(packageRoot, "plan-launch-probe.mjs");
  const planRunnerEntry = join(packageRoot, "plan-runner-entry.mjs");
  const agentDir = join(packageRoot, "pi-agent");
  const planPath = join(originRoot, "approved-plan.md");
  const planId = "e2e-compaction";
  const statePath = join(originRoot, "var", "plan-runs", planId, "status.json");
  let handle;

  try {
    execFileSync("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"], { encoding: "utf8" });
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    await writeFile(join(originRoot, "README.md"), "origin\n");
    execFileSync("git", ["init"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "plan@example.test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Plan Test"], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["add", "."], { cwd: originRoot, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, encoding: "utf8" });
    await writeFile(planPath, `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Implement fixture

**Files:**
- Modify: \`README.md\`
`);
    await writeFile(planRunnerEntry, `
      import providerExtension from ${JSON.stringify(new URL(providerExtension, "file:").href)};
      import { createPlanCapsuleExtension } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-capsule-extension.mjs"), "file:").href)};
      import { createPlanRunnerDependencies } from ${JSON.stringify(new URL(join(repoRoot, "scripts/lib/plan/plan-runner-dependencies.mjs"), "file:").href)};
      export default function (pi) {
        providerExtension(pi);
        let requested = false;
        pi.on("agent_end", async (_event, ctx) => {
          if (requested) return;
          requested = true;
          ctx.compact({ customInstructions: "Summarize the Plan fixture." });
        });
        pi.registerTool({
          name: "compact_plan_session",
          label: "Compact Plan Session",
          description: "Test-only real session compaction trigger",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            return { content: [{ type: "text", text: "finish this turn before compaction" }] };
          },
        });
        createPlanCapsuleExtension(pi, createPlanRunnerDependencies({ pi, audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }), taskReview: async () => ({ accepted: true, findings: [] }), runtimePollTimeoutMs: 30000 }));
      }
    `);
    await writeFile(join(agentDir, "agents", "plan-runner.md"), `---
name: plan-runner
description: deterministic E2E plan child
model: fake/deterministic
extensions: ""
tools: plan_open, compact_plan_session, plan_status, plan_continue, plan_verify, plan_block, subagent, read, bash
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(join(agentDir, "agents", "executor.md"), `---
name: executor
description: deterministic E2E executor child
model: fake/deterministic
extensions: ""
tools: bash, read
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic provider tool-call state machine.
`);
    await writeFile(probe, `
      import { createPlanLauncherExtension } from ${JSON.stringify(new URL("../scripts/lib/plan/plan-launcher-extension.mjs", import.meta.url).href)};
      export default function (pi) {
        createPlanLauncherExtension(pi, { originRoot: ${JSON.stringify(originRoot)}, stateRoot: ${JSON.stringify(originRoot)}, planRunnerEntry: ${JSON.stringify(planRunnerEntry)}, spawnTimeoutMs: 30000 });
      }
    `);

    const result = await runRpcUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", providerExtension, "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "fake", "--model", "fake/deterministic"],
      {
        cwd: originRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "not-used" },
        input: JSON.stringify({ id: "plan-compaction", type: "prompt", message: `/plan-run ${JSON.stringify({ planPath, planId, allowPlanCommits: true })}` }),
        until: (record) => record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith(reportPrefix),
      },
    );
    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const event = notification(result.records, reportPrefix);
    assert.ok(event, `missing lifecycle report\n${result.stdout}`);
    handle = JSON.parse(event.message.slice(reportPrefix.length));

    const sessionEntries = await waitForJsonLines(handle.sessionFile, (entries) => {
      const compactIndex = entries.findIndex((entry) => entry.type === "compaction");
      return compactIndex > 0 && entries.slice(0, compactIndex).some((entry) => entry.customType === "pi-plan-event-v1" && entry.data?.type === "plan.created");
    }, 90_000);
    assert.ok(sessionEntries.some((entry) => entry.type === "compaction"));
    const runtime = await waitFor(join(handle.asyncDir, "status.json"), (value) => value.state === "complete", 30_000);
    assert.equal(runtime.runId, handle.runId);
    await assert.rejects(readFile(statePath, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    await terminateDetachedRun(handle);
    await rm(packageRoot, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});
