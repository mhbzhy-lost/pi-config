import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, loadProjection, listGoals, acquireWriterLock, releaseWriterLock, acquireRecoveryGuard, releaseRecoveryGuard, updateRegistry } from "../scripts/lib/goal-engine/store.mjs";

function event(type, data, goalId = "concurrent-goal") {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function root() { return mkdtempSync(join(tmpdir(), "ge-concurrent-")); }
function birthIdentity(pid = process.pid) { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim(); }
function owner(pid, token, birth = birthIdentity(pid)) { return { pid, token, createdAt: new Date().toISOString(), birthIdentity: birth }; }

function createGoal(stateRoot, goalId = "concurrent-goal") {
  appendEvent(stateRoot, event("goal.created", {
    objective: "Exercise one writer", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, goalId), 0);
}

function checkpoint(workerId, goalId = "concurrent-goal") {
  return event("goal.checkpoint", { nextAction: `Worker ${workerId} must wait for the serialized event store writer` }, goalId);
}

async function worker(stateRoot, workerId, goalId = "concurrent-goal") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, "worker", stateRoot, workerId, goalId], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error || output)));
  });
}

async function crashAfterAcquiringLock(stateRoot, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, mode, stateRoot], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 && output === "acquired" ? resolve() : reject(new Error(error || output)));
  });
}

if (process.argv[2] === "guard-owner") {
  acquireRecoveryGuard(process.argv[3], Date.now() + 500);
  process.stdout.write("acquired");
} else if (process.argv[2] === "writer-owner") {
  acquireWriterLock(process.argv[3]);
  process.stdout.write("acquired");
} else if (process.argv[2] === "writer-owner-hold") {
  acquireWriterLock(process.argv[3]);
  process.stdout.write("acquired\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
} else if (process.argv[2] === "worker") {
  const barrier = process.argv[6];
  if (barrier) {
    process.stdout.write("ready\n");
    while (!existsSync(barrier)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  try {
    appendEvent(process.argv[3], checkpoint(process.argv[4], process.argv[5]), 1);
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
  }
} else {
  test("state-root writer lock serializes version check, log, projection, and registry across processes", async () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const results = await Promise.all([...Array(6)].map((_, i) => worker(stateRoot, String(i))));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.code), Array(5).fill("PROJECTION_CONFLICT"));

    const events = readFileSync(join(stateRoot, "goals/concurrent-goal/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 2);
    assert.equal(loadProjection(stateRoot, "concurrent-goal").version, 2);
    assert.deepEqual(listGoals(stateRoot), ["concurrent-goal"]);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(stateRoot, "registry.json"), "utf8")));
    assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:\.tmp|candidate|quarantine)/.test(name)), []);
    assert.deepEqual(readdirSync(join(stateRoot, "goals/concurrent-goal")).filter((name) => /(?:\.tmp|candidate|quarantine)/.test(name)), []);
    assert.equal(existsSync(join(stateRoot, ".writer.lock")), false);
  });

  test("concurrent stale recovery never leaks filesystem conflicts and leaves one writer per round", async () => {
    for (let round = 0; round < 20; round += 1) {
      const stateRoot = root();
      createGoal(stateRoot);
      const lock = join(stateRoot, ".writer.lock");
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner.json"), JSON.stringify(owner(999999, "dead-owner", "already-dead")));

      const results = await Promise.all([...Array(12)].map((_, workerId) => worker(stateRoot, `${round}-${workerId}`)));
      const detail = results.map((result, workerId) => ({ workerId, code: result.code, message: result.message }));
      assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(detail));
      assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.code), Array(11).fill("PROJECTION_CONFLICT"), JSON.stringify(detail));
      assert.equal(results.some((result) => ["ENOTEMPTY", "EEXIST"].includes(result.code)), false, JSON.stringify(detail));
      assert.equal(loadProjection(stateRoot, "concurrent-goal").version, 2, JSON.stringify(detail));
      assert.deepEqual(listGoals(stateRoot), ["concurrent-goal"]);
      assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:\.tmp|candidate|quarantine|recovery)/.test(name)), []);
      assert.equal(existsSync(lock), false);
    }
  });

  test("malformed registry fails before event or projection writes and retries at the same version", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const goalDir = join(stateRoot, "goals/concurrent-goal");
    const eventsPath = join(goalDir, "events.jsonl");
    const projectionPath = join(goalDir, "projection.json");
    const registryPath = join(stateRoot, "registry.json");
    const validRegistry = readFileSync(registryPath, "utf8");
    writeFileSync(registryPath, "{ malformed registry");
    const before = {
      events: readFileSync(eventsPath, "utf8"),
      projection: readFileSync(projectionPath, "utf8"),
      registry: readFileSync(registryPath, "utf8"),
      replayVersion: loadProjection(stateRoot, "concurrent-goal").version,
      projectionFileVersion: JSON.parse(readFileSync(projectionPath, "utf8")).version,
    };

    assert.throws(() => appendEvent(stateRoot, checkpoint("malformed-registry"), 1), SyntaxError);
    assert.equal(readFileSync(eventsPath, "utf8"), before.events);
    assert.equal(readFileSync(projectionPath, "utf8"), before.projection);
    assert.equal(readFileSync(registryPath, "utf8"), before.registry);
    assert.equal(loadProjection(stateRoot, "concurrent-goal").version, before.replayVersion);
    assert.equal(JSON.parse(readFileSync(projectionPath, "utf8")).version, before.projectionFileVersion);
    assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:writer|guard|tmp|candidate|quarantine)/.test(name)), []);
    assert.deepEqual(readdirSync(goalDir).filter((name) => /(?:tmp|candidate|quarantine)/.test(name)), []);

    writeFileSync(registryPath, validRegistry);
    assert.equal(appendEvent(stateRoot, checkpoint("malformed-registry"), 1).version, 2);
    assert.equal(readFileSync(eventsPath, "utf8").trim().split("\n").length, 2);
    assert.equal(loadProjection(stateRoot, "concurrent-goal").version, 2);
    assert.equal(JSON.parse(readFileSync(projectionPath, "utf8")).version, 2);
    assert.deepEqual(listGoals(stateRoot), ["concurrent-goal"]);
  });

  test("stale writer receipt cannot release a replacement writer lock", () => {
    const stateRoot = root();
    const staleReceipt = acquireWriterLock(stateRoot);
    releaseWriterLock(stateRoot, staleReceipt.token);
    const replacementReceipt = acquireWriterLock(stateRoot);

    releaseWriterLock(stateRoot, staleReceipt.token);
    assert.equal(JSON.parse(readFileSync(join(stateRoot, ".writer.lock/owner.json"), "utf8")).token, replacementReceipt.token);
    releaseWriterLock(stateRoot, replacementReceipt.token);
    assert.equal(existsSync(join(stateRoot, ".writer.lock")), false);
  });

  test("50-process different-goal barrier retains every registry entry", async () => {
    const stateRoot = root();
    const goalIds = [...Array(50)].map((_, index) => `concurrent-goal-${index}`);
    for (const goalId of goalIds) createGoal(stateRoot, goalId);
    const barrier = join(stateRoot, ".start-barrier");
    const children = goalIds.map((goalId, index) => {
      const child = spawn(process.execPath, [import.meta.filename, "worker", stateRoot, String(index), goalId, barrier], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; let error = "";
      const ready = new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) resolve(); });
        child.stderr.on("data", (chunk) => { error += chunk; });
        child.on("error", reject);
      });
      const result = new Promise((resolve, reject) => child.on("exit", (code) => {
        const line = output.trim().split("\n").at(-1);
        code === 0 ? resolve(JSON.parse(line)) : reject(new Error(error || output));
      }));
      return { ready, result };
    });
    await Promise.all(children.map(({ ready }) => ready));
    writeFileSync(barrier, "start\n");
    const results = await Promise.all(children.map(({ result }) => result));
    assert.deepEqual(results, Array(50).fill({ ok: true }));
    assert.deepEqual(listGoals(stateRoot).sort(), [...goalIds].sort());
    for (const goalId of goalIds) assert.equal(loadProjection(stateRoot, goalId).version, 2);
    assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:lock|candidate|quarantine|\.tmp)/.test(name)), []);
  });

  test("malformed writer lock owner fails closed without deletion", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), "not json");

    assert.throws(() => appendEvent(stateRoot, checkpoint("malformed-owner"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), "not json");
  });

  test("stale writer lock is quarantined before acquisition", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner(999999, "dead-owner", "already-dead")));
    assert.equal(appendEvent(stateRoot, checkpoint("stale"), 1).version, 2);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(readdirSync(stateRoot).filter((name) => name.includes("quarantine")), []);
  });

  test("crashed recovery guard owner is recovered before append and leaves no guard artifacts", async () => {
    const stateRoot = root();
    createGoal(stateRoot);
    await crashAfterAcquiringLock(stateRoot, "guard-owner");

    assert.equal(appendEvent(stateRoot, checkpoint("recovered-guard"), 1).version, 2);
    assert.equal(existsSync(join(stateRoot, ".writer.recovery.guard")), false);
    assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:\.tmp|candidate|quarantine|recovery)/.test(name)), []);
  });

  test("crashed child writer owner is recovered before append", async () => {
    const stateRoot = root();
    createGoal(stateRoot);
    await crashAfterAcquiringLock(stateRoot, "writer-owner");
    assert.equal(appendEvent(stateRoot, checkpoint("recovered-writer"), 1).version, 2);
    assert.equal(existsSync(join(stateRoot, ".writer.lock")), false);
  });

  test("stale recovery guard receipt cannot release a replacement guard", () => {
    const stateRoot = root();
    const staleReceipt = acquireRecoveryGuard(stateRoot, Date.now() + 500);
    releaseRecoveryGuard(stateRoot, staleReceipt.token);
    const replacementReceipt = acquireRecoveryGuard(stateRoot, Date.now() + 500);

    releaseRecoveryGuard(stateRoot, staleReceipt.token);
    assert.equal(JSON.parse(readFileSync(join(stateRoot, ".writer.recovery.guard"), "utf8")).token, replacementReceipt.token);
    releaseRecoveryGuard(stateRoot, replacementReceipt.token);
    assert.equal(existsSync(join(stateRoot, ".writer.recovery.guard")), false);
  });

  test("recovery guard timeout fails closed without entering the writer action", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    writeFileSync(join(stateRoot, ".writer.recovery.guard"), JSON.stringify(owner(process.pid, "unproven-guard-owner")));

    assert.throws(() => appendEvent(stateRoot, checkpoint("guard-timeout"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(loadProjection(stateRoot, "concurrent-goal").version, 1);
    assert.equal(existsSync(join(stateRoot, ".writer.lock")), false);
    assert.equal(JSON.parse(readFileSync(join(stateRoot, ".writer.recovery.guard"), "utf8")).token, "unproven-guard-owner");
  });

  test("PID-reused writer lock and recovery guard are deterministically recovered", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner(process.pid, "reused-writer", "different-birth")));
    writeFileSync(join(stateRoot, ".writer.recovery.guard"), JSON.stringify(owner(process.pid, "reused-guard", "different-birth")));

    assert.equal(appendEvent(stateRoot, checkpoint("pid-reuse"), 1).version, 2);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(stateRoot, ".writer.recovery.guard")), false);
  });

  test("registry write rejects a receipt after its writer lock has been released", () => {
    const stateRoot = root();
    const receipt = acquireWriterLock(stateRoot);
    releaseWriterLock(stateRoot, receipt.token);

    assert.throws(
      () => updateRegistry(stateRoot, event("goal.created", { objective: "must remain locked" }, "boundary-goal"), { lifecycle: "active", objective: "must remain locked", updatedAt: new Date().toISOString() }, "boundary" , receipt.token),
      (error) => error.code === "GOAL_ENGINE_STORE_LOCK_LOST",
    );
    assert.equal(existsSync(join(stateRoot, "registry.json")), false);
  });

  test("locale and timezone canonical birth identity keeps a live writer owner", async () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const holder = spawn(process.execPath, [import.meta.filename, "writer-owner-hold", stateRoot], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: "Pacific/Auckland", LC_ALL: "C" } });
    let output = "";
    await new Promise((resolve, reject) => {
      holder.stdout.on("data", (chunk) => { output += chunk; if (output.includes("acquired\n")) resolve(); });
      holder.on("error", reject);
      holder.on("exit", (code) => { if (!output.includes("acquired\n")) reject(new Error(`holder exited ${code}`)); });
    });
    const contender = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", `import { appendEvent } from ${JSON.stringify(new URL("../scripts/lib/goal-engine/store.mjs", import.meta.url).href)}; try { appendEvent(${JSON.stringify(stateRoot)}, ${JSON.stringify(checkpoint("locale"))}, 1); console.log("ok"); } catch (error) { console.log(error.code); }`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
      let result = ""; let error = "";
      child.stdout.on("data", (chunk) => { result += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("exit", (code) => code === 0 ? resolve(result.trim()) : reject(new Error(error)));
    });
    assert.equal(contender, "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(JSON.parse(readFileSync(join(stateRoot, ".writer.lock/owner.json"), "utf8")).pid, holder.pid);
    await new Promise((resolve) => holder.on("exit", resolve));
  });

  test("live writer lock times out without deleting another owner lock", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner(process.pid, "live-owner")));
    assert.throws(() => appendEvent(stateRoot, checkpoint("timeout"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "live-owner");
    assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:\.tmp|candidate|quarantine)/.test(name)), []);
  });
}
