import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, loadProjection, listGoals } from "../scripts/lib/goal-engine/store.mjs";

function event(type, data, goalId = "concurrent-goal") {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function root() { return mkdtempSync(join(tmpdir(), "ge-concurrent-")); }

function createGoal(stateRoot, goalId = "concurrent-goal") {
  appendEvent(stateRoot, event("goal.created", {
    objective: "Exercise one writer", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, goalId), 0);
}

function checkpoint(workerId, goalId = "concurrent-goal") {
  return event("goal.checkpoint", { nextAction: `Worker ${workerId} must wait for the serialized event store writer` }, goalId);
}

async function worker(stateRoot, workerId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, "worker", stateRoot, workerId], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error || output)));
  });
}

if (process.argv[2] === "worker") {
  try {
    appendEvent(process.argv[3], checkpoint(process.argv[4]), 1);
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
    assert.deepEqual(readdirSync(join(stateRoot, "goals/concurrent-goal")).filter((name) => name.includes(".tmp")), []);
    assert.equal(existsSync(join(stateRoot, ".writer.lock")), false);
  });

  test("stale writer lock is quarantined before acquisition", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999999, token: "dead-owner", createdAt: new Date().toISOString() }));
    assert.equal(appendEvent(stateRoot, checkpoint("stale"), 1).version, 2);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(readdirSync(stateRoot).filter((name) => name.includes("quarantine")), []);
  });

  test("live writer lock times out without deleting another owner lock", () => {
    const stateRoot = root();
    createGoal(stateRoot);
    const lock = join(stateRoot, ".writer.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: new Date().toISOString() }));
    assert.throws(() => appendEvent(stateRoot, checkpoint("timeout"), 1), (error) => error.code === "GOAL_ENGINE_STORE_LOCK_TIMEOUT");
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "live-owner");
  });
}
