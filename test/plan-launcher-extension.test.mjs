import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanLauncherExtension } from "../scripts/lib/plan/plan-launcher-extension.mjs";

const planSource = `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["npm test"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Ship it

**Files:**
- Create: \`src/a.mjs\`
`;

function setup(options = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    sendMessage(message, sendOptions) { messages.push({ message, sendOptions }); },
  };
  createPlanLauncherExtension(pi, options);
  return { commands, tools, handlers, entries, messages };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-launcher-v3-"));
  const planPath = path.join(root, "approved-plan.md");
  await writeFile(planPath, planSource);
  return { root, planPath };
}

function workspace(root, planId) {
  return { planId, workspacePath: path.join(root, "var", "plan-worktrees", planId), baseCommit: "b".repeat(40) };
}

function handleFor(root, input, overrides = {}) {
  return {
    schemaVersion: "pi-plan-handle.v3",
    planId: input.planId,
    planHash: input.planHash,
    hostRunId: `host-${input.planId}`,
    processIdentity: `process-${input.planId}`,
    pid: 4242,
    runDir: input.runDir,
    sessionFile: path.join(input.runDir, "sessions", "plan.jsonl"),
    statusPath: input.statusPath,
    worktree: input.cwd,
    startedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

test("plan-run launches one Standalone Plan Runner and persists only the v3 Host handle", async () => {
  const { root, planPath } = await fixture();
  try {
    const launches = [];
    const hostRuntime = {
      async spawnPlanRunner(input) { launches.push(input); return handleFor(root, input); },
      async status() { return {}; }, async interrupt() {}, async stop() {}, async reconcile() {},
    };
    const { commands, entries } = setup({
      originRoot: root,
      stateRoot: root,
      hostRuntime,
      readBaseCommit: async () => "b".repeat(40),
      createWorkspace: async ({ planId }) => workspace(root, planId),
      id: () => "plan-one",
    });
    const notifications = [];
    await commands.get("plan-run").handler(planPath, {
      mode: "tui", hasUI: true,
      ui: { confirm: async () => true, notify: (...args) => notifications.push(args) },
    });

    assert.equal(launches.length, 1);
    assert.deepEqual(Object.keys(launches[0]).sort(), ["baseCommit", "cwd", "extension", "originRoot", "planHash", "planId", "planPath", "runDir", "stateRoot", "statusPath"]);
    assert.equal(launches[0].originRoot, root);
    assert.equal(launches[0].stateRoot, root);
    assert.equal("task" in launches[0], false);
    assert.equal("agent" in launches[0], false);
    assert.equal(entries[0].customType, "pi-plan-launch-handle-v3");
    assert.deepEqual(Object.keys(entries[0].data).sort(), [
      "hostRunId", "pid", "planHash", "planId", "processIdentity", "runDir", "schemaVersion", "sessionFile", "startedAt", "statusPath", "worktree",
    ].sort());
    assert.match(notifications[0][0], /^PI_PLAN_HANDLE=/);
    const persisted = JSON.parse(await readFile(path.join(root, "var", "plan-runs", "plan-one", "host-handle.json"), "utf8"));
    assert.deepEqual(persisted, entries[0].data);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Root session shutdown leaves the Standalone Host alive", async () => {
  const { root, planPath } = await fixture();
  try {
    let stops = 0;
    const hostRuntime = {
      async spawnPlanRunner(input) { return handleFor(root, input); },
      async stop() { stops++; }, async status() {}, async interrupt() {}, async reconcile() {},
    };
    const { commands, handlers } = setup({
      originRoot: root, stateRoot: root, hostRuntime,
      readBaseCommit: async () => "b".repeat(40),
      createWorkspace: async ({ planId }) => workspace(root, planId),
      id: () => "plan-one",
    });
    await commands.get("plan-run").handler(JSON.stringify({ planPath, planId: "plan-one", allowPlanCommits: true }), {});
    await handlers.get("session_shutdown")?.();
    assert.equal(stops, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active Root polls Host status so durable Attention is forwarded without a command", async () => {
  const { root, planPath } = await fixture();
  try {
    let poll;
    let cancelled;
    let statusCalls = 0;
    const hostRuntime = {
      async spawnPlanRunner(input) { return handleFor(root, input); },
      async status() { statusCalls++; return { host: { state: "running" }, plan: { lifecycle: "waiting-attention" } }; },
      async stop() {}, async interrupt() {}, async reconcile() {},
    };
    const { commands, handlers } = setup({
      originRoot: root,
      stateRoot: root,
      hostRuntime,
      readBaseCommit: async () => "b".repeat(40),
      createWorkspace: async ({ planId }) => workspace(root, planId),
      id: () => "plan-one",
      schedule: (callback) => { poll = callback; return "attention-timer"; },
      cancelSchedule: (timer) => { cancelled = timer; },
    });

    await commands.get("plan-run").handler(JSON.stringify({ planPath, planId: "plan-one", allowPlanCommits: true }), {});
    assert.equal(typeof poll, "function");
    await poll();
    assert.equal(statusCalls, 1);
    await handlers.get("session_shutdown")?.();
    assert.equal(cancelled, "attention-timer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-cancel records durable intent before stopping the Host", async () => {
  const { root } = await fixture();
  try {
    const calls = [];
    const handle = handleFor(root, {
      planId: "plan-one", planHash: "hash",
      runDir: path.join(root, "var", "plan-runs", "plan-one", "host"),
      statusPath: path.join(root, "var", "plan-runs", "plan-one", "status.json"),
      cwd: path.join(root, "var", "plan-worktrees", "plan-one"),
    });
    const { commands } = setup({
      stateRoot: root,
      findHandle: async () => handle,
      hostRuntime: {
        async stop(value) { calls.push(["stop", value.hostRunId]); },
        async interrupt() {}, async status() { return {}; }, async reconcile() {}, async spawnPlanRunner() {},
      },
      recordCancelIntent: async (value) => calls.push(["intent", value.hostRunId]),
    });
    assert.match(await commands.get("plan-cancel").handler("plan-one", {}), /cancelled/i);
    assert.deepEqual(calls, [["intent", "host-plan-one"], ["stop", "host-plan-one"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status and recover attach a trusted v3 handle without spawning", async () => {
  const { root } = await fixture();
  try {
    const handle = handleFor(root, {
      planId: "plan-one", planHash: "hash",
      runDir: path.join(root, "var", "plan-runs", "plan-one", "host"),
      statusPath: path.join(root, "var", "plan-runs", "plan-one", "status.json"),
      cwd: path.join(root, "var", "plan-worktrees", "plan-one"),
    });
    let spawns = 0;
    let recoveredPoll;
    const hostRuntime = {
      async spawnPlanRunner() { spawns++; },
      async status() { return { host: { state: "running" }, plan: { lifecycle: "waiting-attention" } }; },
      async reconcile() { return { attached: true, host: { state: "running" }, plan: { lifecycle: "waiting-attention" } }; },
      async interrupt() {}, async stop() {},
    };
    const { commands } = setup({
      stateRoot: root,
      findHandle: async () => handle,
      hostRuntime,
      schedule: (callback) => { recoveredPoll = callback; return "recovered-timer"; },
      cancelSchedule() {},
    });
    assert.equal((await commands.get("plan-status").handler("plan-one", {})).plan.lifecycle, "waiting-attention");
    assert.equal((await commands.get("plan-recover").handler("plan-one", {})).attached, true);
    assert.equal(typeof recoveredPoll, "function");
    assert.equal(spawns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted v1 and v2 handles fail with an explicit migration error", async () => {
  const { root } = await fixture();
  try {
    const directory = path.join(root, "var", "plan-runs", "legacy");
    await mkdir(directory, { recursive: true });
    for (const schemaVersion of ["pi-plan-handle.v1", "pi-plan-handle.v2"]) {
      await writeFile(path.join(directory, "host-handle.json"), JSON.stringify({ schemaVersion, planId: "legacy" }));
      const { commands } = setup({ stateRoot: root });
      await assert.rejects(commands.get("plan-recover").handler("legacy", {}), /migration.*v3|legacy.*handle/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch failure rolls back the workspace without a parent watchdog lease", async () => {
  const { root, planPath } = await fixture();
  try {
    const calls = [];
    const { commands } = setup({
      originRoot: root, stateRoot: root,
      hostRuntime: {
        async spawnPlanRunner() { calls.push("spawn"); throw new Error("spawn failed"); },
        async status() {}, async interrupt() {}, async stop() {}, async reconcile() {},
      },
      readBaseCommit: async () => "b".repeat(40),
      createWorkspace: async ({ planId }) => workspace(root, planId),
      rollbackWorkspace: async () => calls.push("rollback"),
      id: () => "plan-one",
    });
    await assert.rejects(commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /spawn failed/);
    assert.deepEqual(calls, ["spawn", "rollback"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan_run tool and plan-run command share the same noninteractive launch path", async () => {
  const { root, planPath } = await fixture();
  try {
    const hostRuntime = {
      async spawnPlanRunner(input) { return handleFor(root, input); },
      async status() {}, async interrupt() {}, async stop() {}, async reconcile() {},
    };
    const ids = ["tool-plan", "command-plan"];
    const { tools, commands, entries } = setup({
      originRoot: root, stateRoot: root, hostRuntime,
      readBaseCommit: async () => "b".repeat(40),
      createWorkspace: async ({ planId }) => workspace(root, planId),
      id: () => ids.shift(),
    });
    const toolResult = await tools.get("plan_run").execute("call", { planPath }, undefined, undefined, {});
    await commands.get("plan-run").handler(JSON.stringify({ planPath, planId: "command-plan", allowPlanCommits: true }), {});
    assert.equal(toolResult.isError, undefined);
    assert.deepEqual(entries.map(({ data }) => data.planId), ["tool-plan", "command-plan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan runner entry uses the public execution backend and no self-built Executor runtime", async () => {
  const source = await readFile(new URL("../pi/child-extensions/plan-runner.ts", import.meta.url), "utf8");
  assert.match(source, /createPiSubagentsExecutionBackend/);
  assert.match(source, /createSubagentsRpcClient/);
  assert.match(source, /originRoot:\s*process\.env\.PI_PLAN_ORIGIN_ROOT/);
  assert.match(source, /stateRoot:\s*process\.env\.PI_PLAN_STATE_ROOT/);
  assert.doesNotMatch(source, /spawnPiAgent|createMonitor|stopAgent/);
});

test("Root queues a fenced user decision through the Plan Attention reply tool", async () => {
  const { root } = await fixture();
  try {
    const handle = handleFor(root, {
      planId: "plan-one",
      planHash: "hash",
      runDir: path.join(root, "var", "plan-runs", "plan-one", "host"),
      statusPath: path.join(root, "var", "plan-runs", "plan-one", "status.json"),
      cwd: path.join(root, "var", "plan-worktrees", "plan-one"),
    });
    const plan = {
      lifecycle: "running",
      projectionVersion: 8,
      tasks: [{
        taskId: "task-1",
        attempts: [{
          attemptId: "attempt-1",
          runId: "run-1",
          status: "waiting-attention",
          attention: {
            requestId: "request-1",
            status: "pending",
            projectionVersion: 6,
            evidence: { bodyPath: "attention/request-1.md", bodySha256: "a".repeat(64) },
          },
        }],
      }],
    };
    const replies = [];
    const { tools } = setup({
      stateRoot: root,
      findHandle: async () => handle,
      hostRuntime: {
        async status() { return { host: { state: "running" }, plan }; },
        async spawnPlanRunner() {}, async stop() {}, async interrupt() {}, async reconcile() {},
      },
      planControl: {
        async readAttentionReplies() { return []; },
        async writeAttentionReply(command) { replies.push(command); return command; },
      },
      now: () => "2026-07-28T00:00:00.000Z",
    });
    const tool = tools.get("plan_attention_reply");
    assert.ok(tool, "plan_attention_reply must be registered for Root sessions");

    const result = await tool.execute("call-1", {
      planId: "plan-one",
      requestId: "request-1",
      expectedProjectionVersion: 6,
      message: "Stop and let me provision the worker prerequisites.",
    }, undefined, undefined, {});

    assert.equal(result.isError, undefined);
    assert.deepEqual(replies, [{
      planId: "plan-one",
      requestId: "request-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      runId: "run-1",
      expectedProjectionVersion: 6,
      message: "Stop and let me provision the worker prerequisites.",
      occurredAt: "2026-07-28T00:00:00.000Z",
    }]);

    const stale = await tool.execute("call-2", {
      planId: "plan-one",
      requestId: "request-1",
      expectedProjectionVersion: 5,
      message: "stale",
    }, undefined, undefined, {});
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /projection version/i);
    assert.equal(replies.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan_run tool remains registered beside management commands", () => {
  const { commands, tools } = setup();
  assert.equal(tools.has("plan_run"), true);
  assert.equal(tools.has("plan_attention_reply"), true);
  for (const command of ["plan-run", "plan-status", "plan-open", "plan-pause", "plan-cancel", "plan-recover"]) {
    assert.equal(commands.has(command), true, command);
  }
});
