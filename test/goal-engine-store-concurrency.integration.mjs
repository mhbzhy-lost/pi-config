import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, appendEventBatch, loadProjection, listGoals, acquireWriterLock, releaseWriterLock, acquireRecoveryGuard, releaseRecoveryGuard, updateRegistry } from "../scripts/lib/goal-engine/store.mjs";

function event(type, data, goalId = "concurrent-goal") {
  return { schemaVersion: "planned.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function root() { return mkdtempSync(join(tmpdir(), "ge-concurrent-")); }
function birthIdentity(pid = process.pid) { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim(); }
function owner(pid, token, birth = birthIdentity(pid)) { return { protocol: "goal-engine.writer-owner.v2", identityKind: "ps-lstart-utc", pid, token, createdAt: new Date().toISOString(), birthIdentity: birth }; }
function legacyOwner(pid, token, birth) { return { pid, token, createdAt: new Date().toISOString(), ...(birth ? { birthIdentity: birth } : {}) }; }
function writeLegacyLock(lock, value) { mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "owner.json"), typeof value === "string" ? value : JSON.stringify(value)); }
function readWriterOwner(stateRoot) { return JSON.parse(readFileSync(join(stateRoot, ".writer.lock"), "utf8")); }

function faultInjectedBatchStore(stateRoot, marker, fault) {
  const storePath = new URL("../scripts/lib/goal-engine/store.mjs", import.meta.url);
  const eventsUrl = new URL("../scripts/lib/goal-engine/events.mjs", import.meta.url).href;
  const taskDefinitionUrl = new URL("../scripts/lib/goal-engine/task-definition.mjs", import.meta.url).href;
  const source = readFileSync(storePath, "utf8");
  assert.equal(source.split(marker).length - 1, 1, "batch fault boundary must be unique");
  const path = join(stateRoot, `fault-store-${crypto.randomUUID()}.mjs`);
  writeFileSync(path, source.replace('from "./events.mjs"', `from ${JSON.stringify(eventsUrl)}`)
    .replace('from "./task-definition.mjs"', `from ${JSON.stringify(taskDefinitionUrl)}`)
    .replace(marker, `    throw new Error(${JSON.stringify(fault)});`));
  return path;
}

function createGoal(stateRoot, goalId = "concurrent-goal") {
  appendEvent(stateRoot, event("goal.created", {
    objective: "Exercise one writer", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: [{ id: "criterion-1", statement: "x", evidenceKinds: ["tests"] }] }, workflow: "tdd" } },
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
} else if (process.argv[2] === "legacy-writer-owner-hold") {
  const lock = join(process.argv[3], ".writer.lock");
  writeLegacyLock(lock, legacyOwner(process.pid, "legacy-holder", birthIdentity()));
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
  test("appendEventBatch validates and publishes all inner events at one CAS version", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const goalDir = join(stateRoot, "goals/concurrent-goal");
    const before = [readFileSync(join(goalDir, "events.jsonl"), "utf8"), readFileSync(join(goalDir, "projection.json"), "utf8"), readFileSync(join(stateRoot, "registry.json"), "utf8")];
    const valid = checkpoint("batch-valid");
    const invalid = checkpoint("batch-invalid"); invalid.data.nextAction = "short";

    assert.throws(() => appendEventBatch(stateRoot, [valid, invalid], 1));
    assert.deepEqual([readFileSync(join(goalDir, "events.jsonl"), "utf8"), readFileSync(join(goalDir, "projection.json"), "utf8"), readFileSync(join(stateRoot, "registry.json"), "utf8")], before);
    const next = appendEventBatch(stateRoot, [checkpoint("batch-one"), checkpoint("batch-two")], 1);
    assert.equal(next.version, 3);
    assert.equal(loadProjection(stateRoot, "concurrent-goal").version, 3);
    assert.equal(readFileSync(join(goalDir, "events.jsonl"), "utf8").trim().split("\n").length, 3);
  });

  test("appendEventBatch makes the full batch durable before projection or registry publish", async () => {
    for (const marker of [
      "    publishBatchProjectionWithWriterReceipt(stateRoot, projectionTmp, projectionPath, next, lock.token);",
      "    registryTmp = publishBatchRegistry(stateRoot, registry, identity, lock.token);",
    ]) {
      const stateRoot = root();
      createGoal(stateRoot);
      const eventsPath = join(stateRoot, "goals/concurrent-goal/events.jsonl");
      const before = readFileSync(eventsPath, "utf8");
      const path = faultInjectedBatchStore(stateRoot, marker, "after-batch-rename");
      const store = await import(new URL(`file://${path}`).href);
      try {
        assert.throws(() => store.appendEventBatch(stateRoot, [checkpoint("rename-one"), checkpoint("rename-two")], 1), (error) => error.code === "GOAL_ENGINE_STORE_BATCH_DURABLE");
        assert.notEqual(readFileSync(eventsPath, "utf8"), before);
        assert.equal(loadProjection(stateRoot, "concurrent-goal").version, 3);
      } finally { rmSync(path, { force: true }); }
    }
  });

  test("appendEventBatch rename failure keeps the old complete log", async () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const goalDir = join(stateRoot, "goals/concurrent-goal");
    const eventsPath = join(goalDir, "events.jsonl");
    const before = readFileSync(eventsPath, "utf8");
    const path = faultInjectedBatchStore(stateRoot, "  renameSync(eventsTmp, eventsPath);", "before-batch-rename");
    const store = await import(new URL(`file://${path}`).href);
    try {
      assert.throws(() => store.appendEventBatch(stateRoot, [checkpoint("rename-one"), checkpoint("rename-two")], 1), /before-batch-rename/);
      assert.equal(readFileSync(eventsPath, "utf8"), before);
      assert.equal(loadProjection(stateRoot, "concurrent-goal").version, 1);
    } finally { rmSync(path, { force: true }); }
  });

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
      writeLegacyLock(lock, legacyOwner(999999, "dead-owner", "already-dead"));

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

  test("registry goal entry shape corruption fails before every write and retries at the same version", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const goalDir = join(stateRoot, "goals/concurrent-goal");
    const eventsPath = join(goalDir, "events.jsonl");
    const projectionPath = join(goalDir, "projection.json");
    const registryPath = join(stateRoot, "registry.json");
    const valid = readFileSync(registryPath, "utf8");
    const cases = [
      (registry) => { registry.goals["concurrent-goal"] = []; },
      (registry) => { registry.active_goal_ids = ["concurrent-goal", "concurrent-goal"]; },
      (registry) => { registry.active_goal_ids = ["concurrent-goal", "phantom"]; },
      (registry) => { registry.goals["concurrent-goal"].updatedAt = "not-a-time"; },
      (registry) => { registry.active_goal_ids = []; },
    ];
    for (const corrupt of cases) {
      const registry = JSON.parse(valid); corrupt(registry); writeFileSync(registryPath, JSON.stringify(registry));
      const before = [readFileSync(eventsPath, "utf8"), readFileSync(projectionPath, "utf8"), readFileSync(registryPath, "utf8")];
      assert.throws(() => appendEvent(stateRoot, checkpoint("bad-entry"), 1), TypeError);
      assert.deepEqual([readFileSync(eventsPath, "utf8"), readFileSync(projectionPath, "utf8"), readFileSync(registryPath, "utf8")], before);
      assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:writer|guard|tmp|candidate|quarantine)/.test(name)), []);
    }
    writeFileSync(registryPath, valid);
    assert.equal(appendEvent(stateRoot, checkpoint("repaired-entry"), 1).version, 2);
    assert.equal(readFileSync(eventsPath, "utf8").trim().split("\n").length, 2);
  });

  test("mutation oracle kills every release-before-stage mutant", () => {
    const storePath = new URL("../scripts/lib/goal-engine/store.mjs", import.meta.url);
    const eventsUrl = new URL("../scripts/lib/goal-engine/events.mjs", import.meta.url).href;
    const taskDefinitionUrl = new URL("../scripts/lib/goal-engine/task-definition.mjs", import.meta.url).href;
    const source = readFileSync(storePath, "utf8");
    const jsonlCall = "    appendJsonlWithWriterReceipt(stateRoot, eventsPath, event, lock.token);";
    const projectionCall = "    publishProjectionWithWriterReceipt(stateRoot, projectionTmp, projectionPath, next, lock.token);";
    const mutations = [
      ["replay version", "    const current = replayAndCheckVersion(stateRoot, eventsPath, expectedVersion, lock.token);", []],
      ["registry prepare", "    const registry = prepareRegistryUpdate(stateRoot, event, next, lock.token);", []],
      ["JSONL append", jsonlCall, []],
      // Skipping earlier stages isolates this boundary only; it does not claim
      // WAL or power-loss atomicity across the events, projection, and registry files.
      ["projection publish", projectionCall, [jsonlCall]],
      ["registry publish", "    registryTmp = publishRegistry(stateRoot, registry, identity, lock.token);", [jsonlCall, projectionCall]],
    ];
    for (const [name, boundaryCall, skippedCalls] of mutations) {
      assert.equal(source.split(boundaryCall).length - 1, 1, `${name} boundary replacement must be exact once`);
      for (const skippedCall of skippedCalls) assert.equal(source.split(skippedCall).length - 1, 1, `${name} isolation replacement must be exact once`);
      const replacement = `    releaseWriterLock(stateRoot, lock.token);\n${boundaryCall}\n    console.log("stage-marker");`;
      const stateRoot = root(); createGoal(stateRoot);
      const mutantPath = join(stateRoot, `store-${name.replaceAll(" ", "-")}.mjs`);
      let mutantSource = source.replace('from "./events.mjs"', `from ${JSON.stringify(eventsUrl)}`).replace('from "./task-definition.mjs"', `from ${JSON.stringify(taskDefinitionUrl)}`).replace(boundaryCall, replacement);
      for (const skippedCall of skippedCalls) mutantSource = mutantSource.replace(skippedCall, "    void 0;");
      writeFileSync(mutantPath, mutantSource);
      const goalDir = join(stateRoot, "goals/concurrent-goal");
      const before = [readFileSync(join(goalDir, "events.jsonl"), "utf8"), readFileSync(join(goalDir, "projection.json"), "utf8"), readFileSync(join(stateRoot, "registry.json"), "utf8")];
      const program = `import { appendEvent } from ${JSON.stringify(new URL(`file://${mutantPath}`).href)}; const event = ${JSON.stringify(checkpoint(`mutant-${name}`))}; try { appendEvent(${JSON.stringify(stateRoot)}, event, 1); console.log('success'); } catch (error) { console.log(error.code); }`;
      const output = execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8" }).trim();
      assert.equal(output, "GOAL_ENGINE_STORE_LOCK_LOST", name);
      const after = [readFileSync(join(goalDir, "events.jsonl"), "utf8"), readFileSync(join(goalDir, "projection.json"), "utf8"), readFileSync(join(stateRoot, "registry.json"), "utf8")];
      assert.deepEqual(after, before, name);
      assert.equal(output.includes("stage-marker"), false, `${name} must not return from its boundary`);
      rmSync(mutantPath, { force: true });
    }
  });

  test("stale writer receipt cannot release a replacement writer lock", () => {
    const stateRoot = root();
    const staleReceipt = acquireWriterLock(stateRoot);
    releaseWriterLock(stateRoot, staleReceipt.token);
    const replacementReceipt = acquireWriterLock(stateRoot);

    releaseWriterLock(stateRoot, staleReceipt.token);
    assert.equal(readWriterOwner(stateRoot).token, replacementReceipt.token);
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

  test("empty legacy lock times out and is never rename-clobbered", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    mkdirSync(lock);
    const started = Date.now();
    assert.throws(() => appendEvent(stateRoot, checkpoint("empty-lock"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.ok(Date.now() - started >= 1400);
    assert.equal(statSync(lock).isDirectory(), true);
    assert.deepEqual(readdirSync(lock), []);
  });

  test("new writer lock is a private complete regular file", () => {
    const stateRoot = root();
    const receipt = acquireWriterLock(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    const metadata = statSync(lock);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(readWriterOwner(stateRoot)).sort(), ["birthIdentity", "createdAt", "identityKind", "pid", "protocol", "token"].sort());
    releaseWriterLock(stateRoot, receipt.token);
  });

  test("live legacy directory owner without protocol remains fail closed", () => {
    const stateRoot = root(); createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    writeLegacyLock(lock, legacyOwner(process.pid, "legacy-live", "different-birth"));
    assert.throws(() => appendEvent(stateRoot, checkpoint("legacy-live"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8").includes("legacy-live"), true);
  });

  test("dead pre-birth recovery guard is recovered", () => {
    const stateRoot = root(); createGoal(stateRoot);
    writeFileSync(join(stateRoot, ".writer.recovery.guard"), JSON.stringify(legacyOwner(999999, "dead-pre-birth")));
    assert.equal(appendEvent(stateRoot, checkpoint("pre-birth"), 1).version, 2);
    assert.equal(existsSync(join(stateRoot, ".writer.recovery.guard")), false);
  });

  test("malformed writer lock owner fails closed without deletion", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    writeLegacyLock(lock, "not json");

    assert.throws(() => appendEvent(stateRoot, checkpoint("malformed-owner"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), "not json");
  });

  test("stale writer lock is quarantined before acquisition", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    writeLegacyLock(lock, legacyOwner(999999, "dead-owner", "already-dead"));
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
    writeLegacyLock(lock, owner(process.pid, "reused-writer", "different-birth"));
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

  test("locale and timezone legacy owner without protocol remains fail closed", async () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const holder = spawn(process.execPath, [import.meta.filename, "legacy-writer-owner-hold", stateRoot], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: "Pacific/Auckland", LC_ALL: "C" } });
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
    writeLegacyLock(lock, owner(process.pid, "live-owner"));
    assert.throws(() => appendEvent(stateRoot, checkpoint("timeout"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "live-owner");
    assert.deepEqual(readdirSync(stateRoot).filter((name) => /(?:\.tmp|candidate|quarantine)/.test(name)), []);
  });
}
