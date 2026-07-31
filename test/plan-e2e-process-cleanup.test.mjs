import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import * as cleanup from "./support/plan-e2e-process-cleanup.mjs";

const execFile = promisify(execFileCallback);

const { terminateDetachedRun } = cleanup;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function killGroup(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} did not exit`);
}

test("terminateDetachedRun reaps the recorded runner and its child before fixture deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-"));
  const asyncDir = join(root, "async-run");
  await mkdir(asyncDir);
  const runner = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(() => {}, 1000);
  `, root, "run-1"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => {
    if (groupAlive(runner.pid)) killGroup(runner.pid);
    await rm(root, { recursive: true, force: true });
  });
  const childPid = Number(await new Promise((resolve, reject) => {
    runner.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    runner.once("error", reject);
  }));
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "run-1", state: "running", pid: runner.pid, startedAt: Date.now() }));

  await terminateDetachedRun({ runId: "run-1", asyncDir }, { expectedCommandPath: root });
  await Promise.all([waitForExit(childPid), waitForExit(runner.pid)]);

  assert.equal(alive(childPid), false);
  assert.equal(alive(runner.pid), false);
});

test("terminateDetachedRunsUnder reaps every persisted async run below an isolated runtime root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-all-"));
  const asyncRoot = join(root, "pi-subagents-uid-501", "async-subagent-runs");
  const processes = [];
  const spawnRun = async (runId) => {
    const asyncDir = join(asyncRoot, runId);
    await mkdir(asyncDir, { recursive: true });
    const runner = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stdout.write(String(child.pid) + "\\n");
      setInterval(() => {}, 1000);
    `, root, runId], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const childPid = Number(await new Promise((resolve, reject) => {
      runner.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
      runner.once("error", reject);
    }));
    processes.push(runner.pid, childPid);
    await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId, state: "running", pid: runner.pid, startedAt: Date.now() }));
  };
  t.after(async () => {
    for (const pid of processes) {
      if (groupAlive(pid)) killGroup(pid);
    }
    await rm(root, { recursive: true, force: true });
  });
  await spawnRun("run-a");
  await spawnRun("run-b");

  const terminateAll = cleanup.terminateDetachedRunsUnder ?? (async () => assert.fail("terminateDetachedRunsUnder is required"));
  await terminateAll(root);
  await Promise.all(processes.map((pid) => waitForExit(pid)));
  assert.ok(processes.every((pid) => !alive(pid)));
});

test("terminateDetachedRunsUnder treats an exited recorded PID as already clean", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-exited-"));
  const asyncDir = join(root, "pi-subagents-uid-501", "async-subagent-runs", "exited-run");
  await mkdir(asyncDir, { recursive: true });
  const finished = spawn(process.execPath, ["-e", "process.exit(0)", root, "exited-run"], { detached: true, stdio: "ignore" });
  const startedAt = Date.now();
  const pid = finished.pid;
  await new Promise((resolve, reject) => {
    finished.once("close", resolve);
    finished.once("error", reject);
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "exited-run", state: "complete", pid, startedAt }));

  await cleanup.terminateDetachedRunsUnder(root, { timeoutMs: 100 });
});

test("terminateDetachedRunsUnder refuses a stale status PID owned by an unrelated process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-stale-"));
  const asyncDir = join(root, "pi-subagents-uid-501", "async-subagent-runs", "stale-run");
  await mkdir(asyncDir, { recursive: true });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  t.after(async () => {
    if (groupAlive(unrelated.pid)) killGroup(unrelated.pid);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "stale-run", state: "running", pid: unrelated.pid, startedAt: Date.now() }));

  await assert.rejects(cleanup.terminateDetachedRunsUnder(root, { timeoutMs: 100 }), /identity|command|runtime/i);
  assert.equal(alive(unrelated.pid), true, "stale PID owner must not be signalled");
});

test("terminateDetachedRunsUnder reaps a same-group child created by the runner TERM handler", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-term-race-"));
  const asyncDir = join(root, "pi-subagents-uid-501", "async-subagent-runs", "term-race");
  const childPidFile = join(root, "term-child.pid");
  await mkdir(asyncDir, { recursive: true });
  const runner = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.argv[1], String(child.pid));
    });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `, childPidFile, root, "term-race"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => {
    if (groupAlive(runner.pid)) killGroup(runner.pid);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    runner.stdout.once("data", resolve);
    runner.once("error", reject);
  });
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "term-race", state: "running", pid: runner.pid, startedAt: Date.now() }));

  await cleanup.terminateDetachedRunsUnder(root, { timeoutMs: 100 });
  const childPid = Number(await readFile(childPidFile, "utf8"));
  await waitForExit(childPid);
  assert.equal(groupAlive(runner.pid), false);
});

test("terminateDetachedRun rechecks the group leader identity before SIGKILL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-recapture-"));
  const asyncDir = join(root, "async-subagent-runs", "recapture-run");
  const pid = 424_242;
  const startedAt = Date.now();
  await mkdir(asyncDir, { recursive: true });
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "recapture-run", state: "running", pid, startedAt }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = { pid, pgid: pid, startedAt, command: `${root}/async-cfg-recapture-run.json` };
  const reused = { ...initial, startedAt: startedAt + 60_000, command: "/usr/bin/unrelated" };
  let inspections = 0;
  const signals = [];

  await assert.rejects(
    cleanup.terminateDetachedRun(
      { runId: "recapture-run", asyncDir },
      {
        expectedCommandPath: root,
        timeoutMs: 1,
        inspectProcess: async () => inspections++ === 0 ? initial : reused,
        isGroupAlive: async () => true,
        signalProcessGroup: (pgid, signal) => signals.push({ pgid, signal }),
      },
    ),
    /identity|changed|reused/i,
  );
  assert.deepEqual(signals, [{ pgid: pid, signal: "SIGTERM" }]);
});

test("terminateDetachedRun refuses SIGKILL when the verified group leader disappeared", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-missing-leader-"));
  const asyncDir = join(root, "async-subagent-runs", "missing-leader-run");
  const pid = 434_343;
  const startedAt = Date.now();
  await mkdir(asyncDir, { recursive: true });
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "missing-leader-run", state: "running", pid, startedAt }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = { pid, pgid: pid, startedAt, command: `${root}/async-cfg-missing-leader-run.json` };
  let inspections = 0;
  const signals = [];

  await assert.rejects(
    cleanup.terminateDetachedRun(
      { runId: "missing-leader-run", asyncDir },
      {
        expectedCommandPath: root,
        timeoutMs: 1,
        inspectProcess: async () => inspections++ === 0 ? initial : undefined,
        isGroupAlive: async () => true,
        signalProcessGroup: (pgid, signal) => signals.push({ pgid, signal }),
      },
    ),
    /leader.*unavailable|identity.*before SIGKILL/i,
  );
  assert.deepEqual(signals, [{ pgid: pid, signal: "SIGTERM" }]);
});

test("removeFixtureWithEvidence retains a complete archive after partial recursive deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-evidence-"));
  const fixture = join(root, "fixture");
  const evidenceFile = join(fixture, "evidence.txt");
  await mkdir(fixture);
  await writeFile(evidenceFile, "durable evidence\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const removeWithEvidence = cleanup.removeFixtureWithEvidence ?? (async () => assert.fail("removeFixtureWithEvidence is required"));
  let failure;

  try {
    await removeWithEvidence(fixture, {
      removeFixture: async () => {
        await rm(evidenceFile, { force: true });
        throw new Error("recursive removal failed after partial deletion");
      },
    });
    assert.fail("removeFixtureWithEvidence must reject a partial deletion");
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /recursive removal failed/);
  assert.equal(typeof failure.preservedFixture, "string");
  const { stdout } = await execFile("tar", ["-xOf", failure.preservedFixture, "fixture/evidence.txt"]);
  assert.equal(stdout, "durable evidence\n");
});

test("finalizeHarnessCleanup reports the preserved archive when fixture removal fails", async () => {
  const preservedFixture = "/tmp/fixture-evidence.cleanup-evidence.tar";
  const removalFailure = Object.assign(new Error("fixture removal failed"), { preservedFixture });
  const diagnostics = [];

  await assert.rejects(
    cleanup.finalizeHarnessCleanup({
      fixture: "/tmp/fixture-evidence",
      passed: true,
      preserve: false,
      primaryError: undefined,
      cleanupErrors: [],
      removeFixture: async () => { throw removalFailure; },
      diagnostic: (message) => diagnostics.push(message),
    }),
    (error) => error instanceof AggregateError && error.errors[0] === removalFailure,
  );
  assert.deepEqual(diagnostics, [`preserved=${preservedFixture}`]);
});

test("finalizeHarnessCleanup preserves primary and cleanup errors in order", async () => {
  const primaryError = new Error("body failed");
  const cleanupError = new Error("cleanup failed");

  await assert.rejects(
    cleanup.finalizeHarnessCleanup({
      fixture: "/tmp/fixture-evidence",
      passed: false,
      preserve: false,
      primaryError,
      cleanupErrors: [cleanupError],
      removeFixture: async () => assert.fail("failed Harness must not remove fixture"),
      diagnostic: () => {},
    }),
    (error) => error instanceof AggregateError && error.errors[0] === primaryError && error.errors[1] === cleanupError,
  );
});

test("finalizeHarnessCleanup preserves a successful fixture when cleanup failed", async () => {
  const cleanupFailure = new Error("runner group remained alive");
  let removed = false;
  const diagnostics = [];
  const finalize = cleanup.finalizeHarnessCleanup ?? (async () => assert.fail("finalizeHarnessCleanup is required"));

  await assert.rejects(
    finalize({
      fixture: "/tmp/fixture-evidence",
      passed: true,
      preserve: false,
      primaryError: undefined,
      cleanupErrors: [cleanupFailure],
      removeFixture: async () => { removed = true; },
      diagnostic: (message) => diagnostics.push(message),
    }),
    (error) => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === cleanupFailure,
  );
  assert.equal(removed, false);
  assert.ok(diagnostics.some((message) => message.includes("/tmp/fixture-evidence")));
});
