import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanHostRuntime, spawnStandaloneHost, stopStandaloneHost } from "../scripts/lib/plan/plan-host-runtime.mjs";

function input(root, overrides = {}) {
  return {
    planId: "plan-1",
    planPath: "/repo/docs/plan.md",
    planHash: "a".repeat(64),
    baseCommit: "b".repeat(40),
    originRoot: "/repo",
    stateRoot: "/repo",
    cwd: "/repo/worktree",
    extension: "/config/plan-runner.ts",
    runDir: path.join(root, "var", "plan-runs", "plan-1", "host"),
    statusPath: path.join(root, "var", "plan-runs", "plan-1", "status.json"),
    ...overrides,
  };
}

test("Standalone Host artifacts are private independent of the caller umask", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-private-"));
  const fakePi = path.join(root, "fake-pi");
  const runDir = path.join(root, "run");
  const sessionDir = path.join(runDir, "sessions");
  await writeFile(fakePi, "#!/bin/sh\nsleep 5\n");
  await chmod(fakePi, 0o755);
  let processHandle;
  try {
    processHandle = await spawnStandaloneHost({
      task: "test",
      cwd: root,
      extensions: [],
      noExtensions: true,
      noSkills: true,
      sessionDir,
      runDir,
      command: fakePi,
      environment: process.env,
      hostRunId: "host-private",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await stat(runDir)).mode & 0o777, 0o700);
    for (const file of ["stdout.jsonl", "stderr.log", "status.json"]) {
      assert.equal((await stat(path.join(runDir, file))).mode & 0o777, 0o600, file);
    }
  } finally {
    if (processHandle?.pid) {
      try { process.kill(processHandle.pid, "SIGTERM"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Standalone Host uses a persistent RPC session and sends bootstrap over stdin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-rpc-"));
  const fakePi = path.join(root, "fake-pi");
  const argsFile = path.join(root, "args.txt");
  const promptFile = path.join(root, "prompt.json");
  await writeFile(fakePi, `#!/bin/sh
printf '%s\\n' "$@" > "$PLAN_TEST_ARGS"
IFS= read -r bootstrap
printf '%s' "$bootstrap" > "$PLAN_TEST_PROMPT"
printf '{"type":"session","version":3,"id":"rpc-session-id","timestamp":"2026-07-28T00:00:00.000Z","cwd":"%s"}\\n' "$PWD"
exec sleep 30
`);
  await chmod(fakePi, 0o755);
  let handle;
  try {
    handle = await spawnStandaloneHost({
      task: "persistent bootstrap",
      cwd: root,
      extensions: [],
      noExtensions: true,
      noSkills: true,
      sessionDir: path.join(root, "run", "sessions"),
      runDir: path.join(root, "run"),
      command: fakePi,
      environment: { ...process.env, PLAN_TEST_ARGS: argsFile, PLAN_TEST_PROMPT: promptFile },
      hostRunId: "host-rpc",
    });
    await handle.ready;
    const args = (await readFile(argsFile, "utf8")).trim().split("\n");
    assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
    assert.equal(args.includes("-p"), false);
    assert.deepEqual(JSON.parse(await readFile(promptFile, "utf8")), {
      id: "host-rpc.bootstrap",
      type: "prompt",
      message: "persistent bootstrap",
    });
    assert.doesNotThrow(() => process.kill(handle.pid, 0));
  } finally {
    if (handle?.pid) await stopStandaloneHost(handle.pid, { graceMs: 100 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Host startup binds to the Pi session event before first assistant persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-session-event-"));
  const fakePi = path.join(root, "fake-pi");
  const marker = path.join(root, "session-event-emitted");
  await writeFile(fakePi, `#!/bin/sh
sleep 0.2
printf ready > "$PLAN_TEST_MARKER"
printf '{"type":"session","version":3,"id":"session-event-id","timestamp":"2026-07-27T00:00:00.000Z","cwd":"%s"}\\n' "$PWD"
exec sleep 30
`);
  await chmod(fakePi, 0o755);
  let handle;
  try {
    const host = createPlanHostRuntime({
      spawnHost: (options) => spawnStandaloneHost({ ...options, command: fakePi }),
      captureHostIdentity: async () => "process-owned",
      verifyHostIdentity: async () => true,
      env: { ...process.env, PLAN_TEST_MARKER: marker },
      id: () => "host-session-event",
    });
    const startedAt = Date.now();
    handle = await host.spawnPlanRunner(input(root, {
      cwd: root,
      runDir: path.join(root, "run"),
      statusPath: path.join(root, "status.json"),
    }));

    assert.ok(Date.now() - startedAt < 2_000, "Host must not wait for first assistant persistence");
    assert.equal(await readFile(marker, "utf8"), "ready");
    assert.equal(path.dirname(handle.sessionFile), path.join(root, "run", "sessions"));
    await assert.rejects(stat(handle.sessionFile), (error) => error?.code === "ENOENT");
    await host.stop(handle);
  } finally {
    if (handle?.pid) {
      try { process.kill(handle.pid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("default Host identity fencing recognizes only the spawned process token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-identity-"));
  const fakePi = path.join(root, "fake-pi");
  await writeFile(fakePi, `#!/bin/sh
session_dir=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--session-dir" ]; then session_dir="$2"; shift 2; else shift; fi
done
printf '{"type":"session","version":3,"id":"identity-session-id","timestamp":"2026-07-27T00:00:00.000Z","cwd":"%s"}\\n' "$PWD"
sleep 5
`);
  await chmod(fakePi, 0o755);
  let handle;
  try {
    const host = createPlanHostRuntime({
      spawnHost: (options) => spawnStandaloneHost({ ...options, command: fakePi }),
      id: () => "host-identity",
    });
    handle = await host.spawnPlanRunner(input(root, {
      cwd: root,
      runDir: path.join(root, "run"),
      statusPath: path.join(root, "status.json"),
    }));
    assert.equal((await host.reconcile(handle)).attached, true);
    await host.interrupt(handle);
  } finally {
    if (handle?.pid) {
      try { process.kill(handle.pid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("stops a spawned Host when process identity capture fails", async () => {
  const stopped = [];
  const host = createPlanHostRuntime({
    spawnHost: async () => ({ pid: 4242, sessionFile: "/session.jsonl" }),
    captureHostIdentity: async () => { throw new Error("identity unavailable"); },
    stopHost: async (pid) => stopped.push(pid),
  });
  await assert.rejects(host.spawnPlanRunner(input("/tmp")), /identity unavailable/);
  assert.deepEqual(stopped, [4242]);
});

test("spawns only a Standalone Plan Runner and returns the exact v3 handle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-"));
  try {
    const calls = [];
    const host = createPlanHostRuntime({
      spawnHost: async (options) => {
        calls.push(options);
        return {
          pid: 4242,
          processIdentity: "process-4242",
          runDir: options.runDir,
          sessionFile: path.join(options.runDir, "sessions", "plan.jsonl"),
        };
      },
      id: () => "host-run-1",
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const handle = await host.spawnPlanRunner(input(root));

    assert.deepEqual(handle, {
      schemaVersion: "pi-plan-handle.v3",
      planId: "plan-1",
      planHash: "a".repeat(64),
      hostRunId: "host-run-1",
      processIdentity: "process-4242",
      pid: 4242,
      runDir: path.join(root, "var", "plan-runs", "plan-1", "host"),
      sessionFile: path.join(root, "var", "plan-runs", "plan-1", "host", "sessions", "plan.jsonl"),
      statusPath: path.join(root, "var", "plan-runs", "plan-1", "status.json"),
      worktree: "/repo/worktree",
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), [
      "cwd", "environment", "extensions", "hostRunId", "noExtensions", "noSkills", "runDir", "sessionDir", "task",
    ]);
    assert.equal(calls[0].hostRunId, "host-run-1");
    assert.equal(calls[0].cwd, "/repo/worktree");
    assert.equal(calls[0].environment.PI_PLAN_ORIGIN_ROOT, "/repo");
    assert.equal(calls[0].environment.PI_PLAN_STATE_ROOT, "/repo");
    assert.deepEqual(calls[0].extensions, ["/config/plan-runner.ts"]);
    assert.match(calls[0].task, /first action must be plan_open/i);
    assert.match(calls[0].task, /"allowPlanCommits":true/);
    assert.doesNotMatch(calls[0].task, /originRoot|stateRoot/);
    assert.deepEqual(Object.keys(host).sort(), ["interrupt", "reconcile", "spawnPlanRunner", "status", "stop"]);
    assert.equal("spawnExecutor" in host, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("can isolate the Host to an explicit official RPC extension set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-isolated-"));
  try {
    const calls = [];
    const host = createPlanHostRuntime({
      noExtensions: true,
      extraExtensions: ["/config/pi-subagents"],
      spawnHost: async (options) => {
        calls.push(options);
        const sessionFile = path.join(options.sessionDir, "plan.jsonl");
        await mkdir(options.sessionDir, { recursive: true });
        await writeFile(sessionFile, "{}\n");
        return { pid: 4242, processIdentity: "process-4242", sessionFile };
      },
    });
    await host.spawnPlanRunner(input(root));
    assert.equal(calls[0].noExtensions, true);
    assert.deepEqual(calls[0].extensions, ["/config/pi-subagents", "/config/plan-runner.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects child mode and every Executor-shaped launch field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-"));
  try {
    for (const env of [{ PI_SUBAGENT_CHILD: "1" }, { PI_SUBAGENT_FANOUT_CHILD: "1" }]) {
      const host = createPlanHostRuntime({ env, spawnHost: async () => assert.fail("must not spawn") });
      await assert.rejects(host.spawnPlanRunner(input(root)), /child|fanout/i);
    }
    const host = createPlanHostRuntime({ spawnHost: async () => assert.fail("must not spawn") });
    for (const extra of [{ task: "executor task" }, { agent: "executor" }, { attemptId: "attempt-1" }, { executorCwd: "/attempt" }]) {
      await assert.rejects(host.spawnPlanRunner({ ...input(root), ...extra }), /unsupported.*field|Plan Runner input/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status and reconcile keep Host process state separate from Plan domain state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-"));
  try {
    const planStatus = input(root).statusPath;
    await mkdir(path.dirname(planStatus), { recursive: true });
    await writeFile(planStatus, JSON.stringify({ lifecycle: "waiting-attention", validatedHead: null }));
    let spawns = 0;
    const host = createPlanHostRuntime({
      spawnHost: async () => { spawns++; return { pid: 1 }; },
      readHostStatus: async () => ({ state: "running", pid: 4242 }),
      verifyHostIdentity: async () => true,
    });
    const handle = {
      schemaVersion: "pi-plan-handle.v3", planId: "plan-1", planHash: "a".repeat(64), hostRunId: "host-1",
      processIdentity: "process-4242", pid: 4242, runDir: input(root).runDir, sessionFile: "/sessions/plan.jsonl", statusPath: planStatus,
      worktree: "/repo/worktree", startedAt: "now",
    };

    assert.deepEqual(await host.status(handle), {
      host: { state: "running", pid: 4242 },
      plan: { lifecycle: "waiting-attention", validatedHead: null },
    });
    assert.deepEqual(await host.reconcile(handle), {
      attached: true,
      host: { state: "running", pid: 4242 },
      plan: { lifecycle: "waiting-attention", validatedHead: null },
    });
    assert.equal(spawns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile fails closed when a running status belongs to a reused pid", async () => {
  const host = createPlanHostRuntime({
    readHostStatus: async () => ({ state: "running", pid: 4242 }),
    verifyHostIdentity: async () => false,
  });
  const handle = {
    schemaVersion: "pi-plan-handle.v3", planId: "plan-1", planHash: "hash", hostRunId: "host-1", processIdentity: "process-4242", pid: 4242,
    runDir: "/run", sessionFile: "/session", statusPath: "/status", worktree: "/worktree", startedAt: "now",
  };
  await assert.rejects(host.reconcile(handle), /identity|fencing/i);
});

test("forwards only typed Attention references and deduplicates within one Host lifetime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-"));
  try {
    const planStatus = input(root).statusPath;
    await mkdir(path.dirname(planStatus), { recursive: true });
    await writeFile(planStatus, JSON.stringify({
      lifecycle: "running",
      projectionVersion: 9,
      tasks: [{ taskId: "task-1", attempts: [{
        attemptId: "attempt-1",
        attention: {
          requestId: "request-1",
          status: "pending",
          projectionVersion: 9,
          evidence: { bodyPath: "attention/request-1.md", bodySha256: "c".repeat(64) },
        },
      }] }],
    }));
    const messages = [];
    const host = createPlanHostRuntime({
      readHostStatus: async () => ({ state: "running" }),
      emitAttention: (message) => messages.push(message),
    });
    const handle = {
      schemaVersion: "pi-plan-handle.v3", planId: "plan-1", planHash: "a".repeat(64), hostRunId: "host-1",
      processIdentity: "process-4242", pid: 4242, runDir: input(root).runDir, sessionFile: "/sessions/plan.jsonl", statusPath: planStatus,
      worktree: "/repo/worktree", startedAt: "now",
    };
    await host.status(handle);
    await host.status(handle);
    assert.deepEqual(messages, [{
      customType: "pi-plan-attention-v1",
      content: [
        "Plan plan-1 requires user input for Attention request-1.",
        `Read the private Attention body with the read tool at ${path.join(path.dirname(planStatus), "attention", "request-1.md")}, summarize it to the user, and wait for an explicit decision.`,
        "After the user decides, call plan_attention_reply with planId=plan-1, requestId=request-1, and expectedProjectionVersion=9.",
        "Do not infer or submit a decision on the user's behalf.",
      ].join("\n"),
      details: {
        planId: "plan-1",
        requestId: "request-1",
        expectedProjectionVersion: 9,
        bodyPath: "attention/request-1.md",
        bodySha256: "c".repeat(64),
      },
    }]);
    assert.equal(JSON.stringify(messages).includes("prompt"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retries typed Attention after a transient emitter failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-host-attention-retry-"));
  try {
    const planStatus = input(root).statusPath;
    await mkdir(path.dirname(planStatus), { recursive: true });
    await writeFile(planStatus, JSON.stringify({
      tasks: [{ attempts: [{
        attention: {
          requestId: "request-retry",
          status: "pending",
          projectionVersion: 4,
          evidence: { bodyPath: "attention/request-retry.md", bodySha256: "d".repeat(64) },
        },
      }] }],
    }));
    let emissions = 0;
    const host = createPlanHostRuntime({
      readHostStatus: async () => ({ state: "running" }),
      emitAttention: async () => {
        emissions++;
        if (emissions === 1) throw new Error("transient send failure");
      },
    });
    const handle = {
      schemaVersion: "pi-plan-handle.v3", planId: "plan-1", planHash: "hash", hostRunId: "host-retry",
      processIdentity: "process-retry", pid: 42, runDir: input(root).runDir, sessionFile: "/session",
      statusPath: planStatus, worktree: "/worktree", startedAt: "now",
    };

    await assert.rejects(host.status(handle), /transient send failure/);
    await host.status(handle);
    assert.equal(emissions, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop revalidates process identity during the grace period before SIGKILL", async () => {
  const signals = [];
  const identities = [true, false];
  await stopStandaloneHost(42, {
    graceMs: 1,
    handle: { pid: 42, processIdentity: "owned" },
    verifyHostIdentity: async () => identities.shift() ?? false,
    isProcessAlive: () => true,
    signal: (_pid, value) => signals.push(value),
    sleep: async () => {},
  });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("interrupt and stop require the live process identity to match the v3 handle", async () => {
  const calls = [];
  const handle = {
    schemaVersion: "pi-plan-handle.v3", planId: "plan-1", planHash: "hash", hostRunId: "host-1", processIdentity: "process-42", pid: 42,
    runDir: "/run", sessionFile: "/session", statusPath: "/status", worktree: "/worktree", startedAt: "now",
  };
  const host = createPlanHostRuntime({
    verifyHostIdentity: async (value) => value.hostRunId === "host-1",
    interruptHost: async (pid) => calls.push(["interrupt", pid]),
    stopHost: async (pid) => calls.push(["stop", pid]),
  });
  await host.interrupt(handle);
  await host.stop(handle);
  assert.deepEqual(calls, [["interrupt", 42], ["stop", 42]]);

  const stale = createPlanHostRuntime({
    verifyHostIdentity: async () => false,
    interruptHost: async () => assert.fail("must not signal a reused pid"),
    stopHost: async () => assert.fail("must not signal a reused pid"),
  });
  await assert.rejects(stale.interrupt(handle), /identity|fencing/i);
  await assert.rejects(stale.stop(handle), /identity|fencing/i);
  await assert.rejects(host.stop({ ...handle, schemaVersion: "pi-plan-handle.v2" }), /migration|v3/i);
});
