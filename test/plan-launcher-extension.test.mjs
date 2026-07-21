import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPlanLauncherExtension } from "../scripts/lib/plan/plan-launcher-extension.mjs";

async function eventually(read) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await read(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for control artifact");
}

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
  const events = new Map();
  const entries = [];
  const pi = {
    events,
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { events.set(name, handler); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
  };
  createPlanLauncherExtension(pi, options);
  return { commands, tools, events, entries };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plan-launcher-"));
  const planPath = join(root, "approved-plan.md");
  await writeFile(planPath, planSource);
  return { root, planPath };
}

test("plan-run creates a workspace, spawns async runner, and stores only the parent handle", async () => {
  const { root, planPath } = await fixture();
  try {
    const calls = [];
    const { commands, entries } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: join(root, "var", "plan-worktrees", input.planId) }),
      createRpcClient: () => ({ spawn: async (input) => { calls.push(input); return { details: { runId: "run-1", asyncDir: "/async/one" } }; } }),
      readRuntimeStatus: async () => ({ runId: "run-1", state: "running", steps: [{ sessionFile: "/sessions/one.jsonl" }] }),
      id: () => "plan-one",
    });

    const confirmCalls = [];
    const notifications = [];
    await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: {
      confirm: async (...args) => { confirmCalls.push(args); return true; },
      notify: (...args) => notifications.push(args),
    } });

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      customType: "pi-plan-launch-handle-v1",
      data: {
        planId: "plan-one",
        planHash: "bd2a8a435eac4df263a1608ea3145784a916cfdbe070a9574c93d0a58458682c",
        runId: "run-1",
        asyncDir: "/async/one",
        sessionFile: "/sessions/one.jsonl",
        statusPath: join(root, "var", "plan-runs", "plan-one", "status.json"),
        worktree: join(root, "var", "plan-worktrees", "plan-one"),
      },
    });
    assert.deepEqual(Object.keys(entries[0].data).sort(), ["asyncDir", "planHash", "planId", "runId", "sessionFile", "statusPath", "worktree"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent, "plan-runner");
    assert.deepEqual(Object.keys(calls[0]).sort(), ["agent", "context", "cwd", "task"]);
    assert.equal(calls[0].context, "fresh");
    assert.match(calls[0].task, /"allowPlanCommits":true/);
    assert.match(calls[0].task, /first action must be plan_open/i);
    assert.equal(confirmCalls.length, 1);
    assert.equal(typeof confirmCalls[0][0], "string");
    assert.equal(typeof confirmCalls[0][1], "string");
    assert.ok(confirmCalls[0][0]);
    assert.ok(confirmCalls[0][1]);
    assert.match(notifications[0][0], /^PI_PLAN_HANDLE=/);
    assert.deepEqual(JSON.parse(notifications[0][0].slice("PI_PLAN_HANDLE=".length)), entries[0].data);
    assert.equal(notifications[0][1], "info");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-run writes the trusted runtime wrapper before spawning the child", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "plan-one");
  const entry = join(root, "pi", "child-extensions", "plan-runner.ts");
  try {
    await mkdir(join(root, "pi", "child-extensions"), { recursive: true });
    await writeFile(entry, "export default function () {}\n");
    const order = [];
    const { commands } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      planRunnerEntry: entry,
      createWorkspace: async (input) => { order.push("workspace"); return { ...input, workspacePath: worktree }; },
      createParentLease: (input) => ({
        path: join(root, "var", "plan-runs", input.planId, "control", "parent-lease.json"),
        beat: async () => { order.push("heartbeat"); },
        start: () => { order.push("lease-start"); },
        stop: () => { order.push("lease-stop"); },
        remove: async () => { order.push("lease-remove"); },
      }),
      createRpcClient: () => ({
        spawn: async () => {
          order.push("spawn");
          const wrapper = join(worktree, ".pi-subagents", "plan-runner-entry.mjs");
          await access(wrapper);
          const source = await readFile(wrapper, "utf8");
          assert.match(source, new RegExp(new URL(entry, "file:").href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.match(source, /parent-lifecycle\.mjs/);
          assert.match(source, /startParentLeaseWatchdog/);
          assert.match(source, /"leasePath":"[^"]+parent-lease\.json"/);
          assert.match(source, /"planId":"plan-one"/);
          assert.match(source, /"token":"[0-9a-f-]{36}"/);
          assert.match(source, /"timeoutMs":\d+/);
          assert.match(source, /planRunner\(pi\)/);
          return { details: { runId: "run-1", asyncDir: "/async", results: [{ sessionFile: "/session" }] } };
        },
      }),
      id: () => "plan-one",
    });

    await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    assert.deepEqual(order.slice(0, 4), ["workspace", "heartbeat", "lease-start", "spawn"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-run cleans up lease and runtime wrapper before rollback when launch persistence fails", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "plan-one");
  const entry = join(root, "pi", "child-extensions", "plan-runner.ts");
  try {
    await mkdir(join(root, "pi", "child-extensions"), { recursive: true });
    await writeFile(entry, "export default function () {}\n");
    const order = [];
    let rollbackSawWrapper = false;
    let rollbackSawLease = false;
    const { commands } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      planRunnerEntry: entry,
      createWorkspace: async (input) => ({ ...input, workspacePath: worktree }),
      createParentLease: (input) => ({
        path: join(root, "var", "plan-runs", input.planId, "control", "parent-lease.json"),
        beat: async () => {},
        start: () => {},
        stop: async () => {
          order.push("lease-stop");
          await new Promise((resolve) => setImmediate(resolve));
          order.push("lease-stopped");
        },
        remove: async () => { order.push("lease-remove"); },
      }),
      createRpcClient: () => ({ spawn: async () => ({ details: { runId: "run-1", asyncDir: "/async", results: [{ sessionFile: "/session" }] } }) }),
      persistHandle: async () => { throw new Error("persist failed"); },
      rollbackWorkspace: async () => {
        order.push("rollback");
        try { await access(join(worktree, ".pi-subagents", "plan-runner-entry.mjs")); rollbackSawWrapper = true; } catch {}
        try { await access(join(root, "var", "plan-runs", "plan-one", "control", "parent-lease.json")); rollbackSawLease = true; } catch {}
      },
      id: () => "plan-one",
    });

    await assert.rejects(() => commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } }), /persist failed/);
    assert.equal(rollbackSawWrapper, false);
    assert.equal(rollbackSawLease, false);
    assert.deepEqual(order, ["lease-stop", "lease-stopped", "lease-remove", "rollback"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("noninteractive plan-run requires unambiguous JSON authorization", async () => {
  const { root, planPath } = await fixture();
  try {
    const { commands } = setup({ originRoot: root, stateRoot: root });
    await assert.rejects(() => commands.get("plan-run").handler(planPath, { mode: "rpc", hasUI: false }), /JSON.*allowPlanCommits/i);
    await assert.rejects(() => commands.get("plan-run").handler(JSON.stringify({ planPath, allowPlanCommits: false }), { mode: "json", hasUI: false }), /allowPlanCommits/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two plans from one parent get isolated worktrees", async () => {
  const { root, planPath } = await fixture();
  const secondPath = join(root, "second.md");
  await writeFile(secondPath, planSource.replace("Approved plan", "Second plan"));
  try {
    const ids = ["one", "two"];
    const { commands, entries } = setup({
      originRoot: root, stateRoot: root,
      readBaseCommit: async () => "b".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: join(root, "var", "plan-worktrees", input.planId) }),
      createRpcClient: () => ({ spawn: async () => ({ details: { runId: crypto.randomUUID(), asyncDir: "/async", results: [{ sessionFile: "/session" }] } }) }),
      id: () => ids.shift(),
    });
    const ctx = { mode: "tui", hasUI: true, ui: { confirm: async () => true } };
    await commands.get("plan-run").handler(planPath, ctx);
    await commands.get("plan-run").handler(secondPath, ctx);
    assert.notEqual(entries[0].data.worktree, entries[1].data.worktree);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session_shutdown stops every active plan, waits for terminal artifacts, and releases each lease despite failures", async () => {
  const { root, planPath } = await fixture();
  const secondPath = join(root, "second.md");
  await writeFile(secondPath, planSource.replace("Approved plan", "Second plan"));
  try {
    const planIds = ["one", "two"];
    const runIds = ["run-one", "run-two"];
    const stops = [];
    const leases = [];
    const { commands, events } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "b".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: join(root, "var", "plan-worktrees", input.planId) }),
      createParentLease: (input) => {
        const lease = {
          path: join(root, "var", "plan-runs", input.planId, "control", "parent-lease.json"),
          beat: async () => {},
          start() {},
          stop: async () => { stops.push([input.planId, "lease-stop"]); },
          remove: async () => { stops.push([input.planId, "lease-remove"]); },
        };
        leases.push(lease);
        return lease;
      },
      createRpcClient: () => ({
        spawn: async () => {
          const runId = runIds.shift();
          return { details: { runId, asyncDir: `/async/${runId.slice(4)}`, results: [{ sessionFile: "/session" }] } };
        },
        stop: async ({ runId }) => {
          stops.push([runId, "rpc-stop"]);
          if (runId === "run-one") throw new Error("run-one stop failed");
        },
      }),
      readRuntimeStatus: async (asyncDir) => ({ state: "cancelled", asyncDir }),
      id: () => planIds.shift(),
    });
    const ctx = { mode: "tui", hasUI: true, ui: { confirm: async () => true } };
    await commands.get("plan-run").handler(planPath, ctx);
    await commands.get("plan-run").handler(secondPath, ctx);

    await assert.rejects(() => events.get("session_shutdown")(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Plan shutdown cleanup failed/);
      assert.ok(error.errors[0] instanceof AggregateError);
      assert.match(error.errors[0].message, /Plan one stop failed/);
      assert.ok(error.errors[0].errors.some((innerError) => /run-one stop failed/.test(innerError.message)));
      return true;
    });
    assert.deepEqual(stops.filter((entry) => entry[1] === "rpc-stop").sort(), [["run-one", "rpc-stop"], ["run-two", "rpc-stop"]]);
    assert.deepEqual(stops.filter((entry) => entry[1] !== "rpc-stop").sort(), [
      ["one", "lease-remove"], ["one", "lease-stop"], ["two", "lease-remove"], ["two", "lease-stop"],
    ]);
    assert.equal(leases.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recover reports a durable running run outside this parent registry as orphaned without takeover", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "orphan");
  await mkdir(worktree, { recursive: true });
  try {
    const first = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: worktree }),
      createRpcClient: () => ({ spawn: async () => ({ details: { runId: "run-orphan", asyncDir: "/async/orphan", results: [{ sessionFile: "/session" }] } }) }),
      id: () => "orphan",
    });
    await first.commands.get("plan-run").handler(JSON.stringify({ planPath, planId: "orphan", allowPlanCommits: true }), {});

    let spawns = 0;
    let leaseCreated = 0;
    const second = setup({
      stateRoot: root,
      createParentLease: () => { leaseCreated += 1; throw new Error("must not create lease"); },
      createRpcClient: () => ({
        spawn: async () => { spawns += 1; throw new Error("must not spawn"); },
        status: async () => ({ state: "running" }),
      }),
    });
    const recovery = await second.commands.get("plan-recover").handler("orphan", {});
    assert.equal(recovery.ownerState, "orphaned-owner");
    assert.equal(recovery.blocked, true);
    assert.equal(spawns, 0);
    assert.equal(leaseCreated, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recover recognizes a durable terminal stable RPC text status outside this parent registry without takeover", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "terminal");
  await mkdir(worktree, { recursive: true });
  try {
    const first = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: worktree }),
      createRpcClient: () => ({ spawn: async () => ({ details: { runId: "run-terminal", asyncDir: "/async/terminal", results: [{ sessionFile: "/session" }] } }) }),
      id: () => "terminal",
    });
    await first.commands.get("plan-run").handler(JSON.stringify({ planPath, planId: "terminal", allowPlanCommits: true }), {});

    let spawns = 0;
    let leaseCreated = 0;
    const second = setup({
      stateRoot: root,
      createParentLease: () => { leaseCreated += 1; throw new Error("must not create lease"); },
      createRpcClient: () => ({
        spawn: async () => { spawns += 1; throw new Error("must not spawn"); },
        status: async () => ({ text: "Run: run-terminal\nState: failed\nUpdated: now", details: { mode: "single", results: [] } }),
      }),
    });
    const recovery = await second.commands.get("plan-recover").handler("terminal", {});
    assert.equal(recovery.ownerState, undefined);
    assert.equal(recovery.blocked, undefined);
    assert.equal(spawns, 0);
    assert.equal(leaseCreated, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recover marks a durable running stable RPC text status outside this parent registry as orphaned", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "running-text");
  await mkdir(worktree, { recursive: true });
  try {
    const first = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: worktree }),
      createRpcClient: () => ({ spawn: async () => ({ details: { runId: "run-running-text", asyncDir: "/async/running-text", results: [{ sessionFile: "/session" }] } }) }),
      id: () => "running-text",
    });
    await first.commands.get("plan-run").handler(JSON.stringify({ planPath, planId: "running-text", allowPlanCommits: true }), {});

    const second = setup({
      stateRoot: root,
      createRpcClient: () => ({
        status: async () => ({ text: "Run: run-running-text\nState: running\nUpdated: now", details: { mode: "single", results: [] } }),
      }),
    });
    const recovery = await second.commands.get("plan-recover").handler("running-text", {});
    assert.equal(recovery.ownerState, "orphaned-owner");
    assert.equal(recovery.blocked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pause interrupts, cancel records intent before stop and verifies a terminal artifact", async () => {
  const { root } = await fixture();
  try {
    const calls = [];
    const handle = { planId: "one", runId: "run-1", asyncDir: "/async", sessionFile: "/session", planHash: "hash", statusPath: join(root, "var", "plan-runs", "one", "status.json"), worktree: "/worktree" };
    const { commands, entries } = setup({
      originRoot: root,
      findHandle: () => handle,
      createRpcClient: () => ({
        interrupt: async (value) => calls.push(["interrupt", value]),
        stop: async (value) => { calls.push(["stop", value]); return { state: "stopping" }; },
      }),
      recordCancelIntent: async () => { calls.push(["intent"]); },
      readRuntimeStatus: async () => ({ status: { kind: "stable", value: { state: "failed" } } }),
    });
    await commands.get("plan-pause").handler("one", {});
    const cancelled = await commands.get("plan-cancel").handler("one", {});
    assert.deepEqual(calls, [["interrupt", { runId: "run-1" }], ["intent"], ["stop", { runId: "run-1" }]]);
    assert.match(cancelled, /cancelled/i);
    assert.equal(entries.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel waits for a matching child acknowledgement before stop and a terminal runtime artifact after", async () => {
  const { root } = await fixture();
  try {
    const planId = "one";
    const control = join(root, "var", "plan-runs", planId, "control");
    await mkdir(control, { recursive: true });
    const statusPath = join(root, "var", "plan-runs", planId, "status.json");
    await writeFile(statusPath, JSON.stringify({ lifecycle: "running" }));
    const handle = { planId, runId: "run-1", asyncDir: "/async", sessionFile: "/session", planHash: "hash", statusPath, worktree: "/worktree" };
    const calls = [];
    const { commands } = setup({
      originRoot: root,
      stateRoot: root,
      findHandle: () => handle,
      id: () => "request-1",
      pollIntervalMs: 1,
      cancelTimeoutMs: 100,
      createRpcClient: () => ({ stop: async (value) => { calls.push(["stop", value]); return { state: "stopping" }; } }),
      readRuntimeStatus: async () => ({ status: { kind: "stable", value: { state: "cancelled" } } }),
    });
    const cancellation = commands.get("plan-cancel").handler(planId, {});
    const request = JSON.parse(await eventually(() => readFile(join(control, "cancel-request.json"), "utf8")));
    assert.deepEqual(calls, []);
    await writeFile(join(control, "cancel-ack.json"), JSON.stringify({
      schemaVersion: "pi-plan-control.v1",
      requestId: request.requestId,
      planId,
      runId: "run-1",
      type: "cancel",
      lifecycle: "cancelled",
      result: "accepted",
      occurredAt: "2026-07-15T00:00:01.000Z",
    }));
    assert.match(await cancellation, /cancelled/i);
    assert.deepEqual(calls, [["stop", { runId: "run-1" }]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel waits for an asynchronous terminal artifact after stop", async () => {
  const { commands } = setup({
    findHandle: () => ({ planId: "one", runId: "run-1", asyncDir: "/async/one", statusPath: "/state/var/plan-runs/one/status.json" }),
    stateRoot: "/state",
    recordCancelIntent: async () => {},
    createRpcClient: () => ({ stop: async () => ({ state: "stopping" }) }),
    pollIntervalMs: 0,
    cancelTimeoutMs: 100,
    readRuntimeStatus: (() => {
      const states = ["running", "stopping", "failed"];
      return async () => ({ state: states.shift() ?? "failed" });
    })(),
  });

  assert.match(await commands.get("plan-cancel").handler("one", {}), /cancelled.*failed/i);
});

test("cancel refuses forged parent status paths before writing a child request", async () => {
  const { root } = await fixture();
  try {
    const { commands } = setup({
      originRoot: root,
      stateRoot: root,
      findHandle: () => ({ planId: "one", runId: "run-1", asyncDir: "/async", statusPath: join(root, "elsewhere", "status.json") }),
      createRpcClient: () => ({ stop: async () => assert.fail("stop must not be called") }),
    });
    await assert.rejects(() => commands.get("plan-cancel").handler("one", {}), /status path|escapes|trusted/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel fails closed when stop fails or artifact is nonterminal", async () => {
  const { root } = await fixture();
  try {
    const handle = { planId: "one", runId: "run-1", asyncDir: "/async", statusPath: join(root, "var", "plan-runs", "one", "status.json") };
    const { commands } = setup({
      originRoot: root, findHandle: () => handle,
      createRpcClient: () => ({ stop: async () => { throw new Error("stop unavailable"); } }),
      recordCancelIntent: async () => {},
    });
    await assert.rejects(() => commands.get("plan-cancel").handler("one", {}), /stop unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status and recover use child artifacts without spawning or fabricating validation", async () => {
  const { root } = await fixture();
  try {
    const handle = { planId: "one", runId: "run-1", asyncDir: "/async", statusPath: join(root, "status.json") };
    await writeFile(handle.statusPath, JSON.stringify({ lifecycle: "running", validatedHead: null }));
    let spawns = 0;
    const notifications = [];
    const { commands } = setup({
      originRoot: root, findHandle: () => handle,
      createRpcClient: () => ({ spawn: async () => { spawns += 1; }, status: async () => ({ state: "running" }) }),
    });
    const ctx = { ui: { notify: (...args) => notifications.push(args) } };
    assert.deepEqual(await commands.get("plan-status").handler("one", ctx), { lifecycle: "running", validatedHead: null });
    assert.deepEqual(await commands.get("plan-open").handler("one", ctx), { sessionFile: undefined, statusPath: handle.statusPath });
    const recovery = { runId: "run-1", asyncDir: "/async", sessionFile: undefined, worktree: undefined, status: { state: "running" }, ownerState: "orphaned-owner", blocked: true };
    assert.deepEqual(await commands.get("plan-recover").handler("one", ctx), recovery);
    assert.equal(spawns, 0);
    assert.deepEqual(notifications, [
      [JSON.stringify({ lifecycle: "running", validatedHead: null }), "info"],
      [JSON.stringify({ sessionFile: undefined, statusPath: handle.statusPath }), "info"],
      [JSON.stringify(recovery), "info"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restarted parent recovers the same seven-field handle from durable state without spawning", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "restartable");
  await mkdir(worktree, { recursive: true });
  try {
    const first = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: worktree }),
      createRpcClient: () => ({ spawn: async () => ({ details: { runId: "run-restart", asyncDir: "/async/restart", results: [{ sessionFile: "/sessions/restart.jsonl" }] } }) }),
    });
    await first.commands.get("plan-run").handler(JSON.stringify({ planPath, planId: "restartable", allowPlanCommits: true }), {});

    let spawnCalls = 0;
    const second = setup({
      stateRoot: root,
      createRpcClient: () => ({
        spawn: async () => { spawnCalls += 1; throw new Error("must not spawn"); },
        status: async ({ runId }) => ({ details: { runId, state: "running" } }),
      }),
    });
    const recovered = await second.commands.get("plan-recover").handler("restartable", {});
    assert.equal(recovered.runId, "run-restart");
    assert.equal(spawnCalls, 0);
    const persisted = JSON.parse(await readFile(join(root, "var", "plan-runs", "restartable", "parent-handle.json"), "utf8"));
    assert.deepEqual(Object.keys(persisted).sort(), ["asyncDir", "planHash", "planId", "runId", "sessionFile", "statusPath", "worktree"].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan runner entry wires child-persistent capsule dependencies", async () => {
  const source = await readFile(new URL("../pi/child-extensions/plan-runner.ts", import.meta.url), "utf8");
  assert.match(source, /createPlanRunnerDependencies/);
  assert.match(source, /createPlanCapsuleExtension\(pi, createPlanRunnerDependencies/);
  assert.match(source, /externalReview/);
  assert.match(source, /createExternalReviewAdapter/);
});

test("plan runner dispatch skill is allowlisted and constrains parent behavior", async () => {
  const list = await readFile(new URL("../skill-overrides/skills.list", import.meta.url), "utf8");
  const skill = await readFile(new URL("../skill-overrides/plan-runner-dispatch/SKILL.md", import.meta.url), "utf8");
  assert.match(list, /^plan-runner-dispatch$/m);
  assert.match(skill, /^name: plan-runner-dispatch$/m);
  assert.match(skill, /^description: Use when /m);
  assert.match(skill, /writing-plans/);
  assert.match(skill, /plan_run/);
  assert.match(skill, /不得.*执行计划任务|must not execute plan tasks/i);
  assert.match(skill, /validatedHead/);
});

test("plan_run tool is registered alongside the plan-run command", () => {
  const { commands, tools } = setup();
  assert.ok(commands.has("plan-run"), "slash command should be registered");
  assert.ok(tools.has("plan_run"), "tool should be registered");
  const tool = tools.get("plan_run");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.parameters?.properties?.planPath, "tool should accept planPath parameter");
  assert.ok(tool.parameters.required.includes("planPath"), "planPath should be required");
});

test("plan_run tool launches plan with same behavior as the command", async () => {
  const { root, planPath } = await fixture();
  try {
    const calls = [];
    const { tools, entries } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: join(root, "var", "plan-worktrees", input.planId) }),
      createRpcClient: () => ({ spawn: async (input) => { calls.push(input); return { details: { runId: "run-tool", asyncDir: "/async/tool" } }; } }),
      readRuntimeStatus: async () => ({ runId: "run-tool", state: "running", steps: [{ sessionFile: "/sessions/tool.jsonl" }] }),
      id: () => "plan-tool",
    });

    const tool = tools.get("plan_run");
    const result = await tool.execute("call-1", { planPath }, undefined, undefined, {});

    assert.equal(entries.length, 1);
    assert.equal(entries[0].data.planId, "plan-tool");
    assert.equal(entries[0].data.runId, "run-tool");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent, "plan-runner");
    assert.equal(calls[0].context, "fresh");
    assert.match(calls[0].task, /"allowPlanCommits":true/);
    assert.equal(result.isError, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan_run tool skips interactive confirmation", async () => {
  const { root, planPath } = await fixture();
  try {
    const confirmCalls = [];
    const { tools } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      createWorkspace: async (input) => ({ ...input, workspacePath: join(root, "var", "plan-worktrees", input.planId) }),
      createRpcClient: () => ({ spawn: async () => ({ details: { runId: "run-1", asyncDir: "/async" } }) }),
      readRuntimeStatus: async () => ({ runId: "run-1", state: "running", steps: [{ sessionFile: "/sessions/one.jsonl" }] }),
      id: () => "plan-no-confirm",
    });

    const tool = tools.get("plan_run");
    await tool.execute("call-1", { planPath }, undefined, undefined, {
      mode: "tui", hasUI: true,
      ui: { confirm: async (...args) => { confirmCalls.push(args); return true; } },
    });
    assert.equal(confirmCalls.length, 0, "tool should not prompt for confirmation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("plan-run copies plan file into worktree when absent from baseCommit", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "plan-one");
  const entry = join(root, "pi", "child-extensions", "plan-runner.ts");
  try {
    await mkdir(join(root, "pi", "child-extensions"), { recursive: true });
    await writeFile(entry, "export default function () {}\n");
    let spawnedTask = "";
    const { commands } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      planRunnerEntry: entry,
      createWorkspace: async (input) => {
        await mkdir(worktree, { recursive: true });
        return { ...input, workspacePath: worktree };
      },
      createParentLease: (input) => ({
        path: join(root, "var", "plan-runs", input.planId, "control", "parent-lease.json"),
        beat: async () => {},
        start: () => {},
        stop: () => {},
        remove: async () => {},
      }),
      createRpcClient: () => ({
        spawn: async (params) => {
          spawnedTask = params.task;
          const content = await readFile(join(worktree, planPath), "utf8");
          assert.match(content, /pi-plan\.v1/);
          return { details: { runId: "run-1", asyncDir: "/async", results: [{ sessionFile: "/session" }] } };
        },
      }),
      id: () => "plan-one",
    });
    await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    assert.match(spawnedTask, /planHash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
