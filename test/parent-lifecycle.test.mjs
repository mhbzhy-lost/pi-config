import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createParentLease, startParentLeaseWatchdog } from "../scripts/lib/plan/parent-lifecycle.mjs";

test("parent lease atomically refreshes the constrained control artifact", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "pi-parent-lease-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let tick = 0;
  const lease = createParentLease({
    stateRoot,
    planId: "plan-1",
    token: "token-1",
    parentPid: 123,
    now: () => tick += 1,
  });

  await lease.beat();
  const expectedPath = path.join(stateRoot, "var", "plan-runs", "plan-1", "control", "parent-lease.json");
  assert.equal(lease.path, expectedPath);
  assert.deepEqual(JSON.parse(await readFile(expectedPath, "utf8")), {
    schemaVersion: "pi-plan-parent-lease.v1",
    planId: "plan-1",
    token: "token-1",
    parentPid: 123,
    updatedAt: 1,
  });
  assert.equal((await stat(expectedPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.dirname(expectedPath)), ["parent-lease.json"]);

  await lease.beat();
  assert.equal(JSON.parse(await readFile(expectedPath, "utf8")).updatedAt, 2);
});

test("parent lease rejects invalid identities and escaping paths", () => {
  for (const planId of ["../escape", "plan/escape", "..", ""]) {
    assert.throws(() => createParentLease({ stateRoot: "/tmp/state", planId, token: "token", parentPid: 1 }), /planId|escape/i);
  }
  assert.throws(() => createParentLease({ stateRoot: "/tmp/state", planId: "plan-1", token: "", parentPid: 1 }), /token/i);
  assert.throws(() => createParentLease({ stateRoot: "", planId: "plan-1", token: "token", parentPid: 1 }), /stateRoot/i);
});

test("parent lease stop drains an in-flight timer heartbeat before removal", async () => {
  let tick;
  let releaseWrite;
  const writes = [];
  const lease = createParentLease({
    stateRoot: "/tmp/state",
    planId: "plan-1",
    token: "token-1",
    parentPid: 123,
    intervalMs: 1,
    writeLease: async (file, value) => {
      writes.push([file, value]);
      if (writes.length === 1) await new Promise((resolve) => { releaseWrite = resolve; });
    },
    setInterval: (callback) => {
      tick = { unref() {}, callback };
      return tick;
    },
    clearInterval() {},
  });

  lease.start();
  tick.callback();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = lease.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseWrite();
  await stopping;
  await lease.remove();
  tick.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
});

test("watchdog accepts a fresh lease written by createParentLease", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "pi-parent-lease-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const lease = createParentLease({
    stateRoot,
    planId: "plan-1",
    token: "token-1",
    parentPid: 123,
  });
  await lease.beat();
  const persisted = await readFile(lease.path, "utf8");
  let check;
  let expired = 0;
  let expire;
  const expiredSignal = new Promise((resolve) => { expire = resolve; });
  const watchdog = startParentLeaseWatchdog({
    leasePath: lease.path,
    planId: "plan-1",
    token: "token-1",
    timeoutMs: 60_000,
    now: () => Date.now(),
    readFile: async () => persisted,
    setInterval: (fn) => {
      check = fn;
      return { unref() {} };
    },
    clearInterval() {},
    onExpired: () => {
      expired += 1;
      expire();
    },
  });

  check();
  await Promise.race([expiredSignal, new Promise((resolve) => setTimeout(resolve, 20))]);
  watchdog.stop();
  assert.equal(expired, 0);
});

function lease({ planId = "plan-1", token = "token-1", updatedAt = 0 } = {}) {
  return JSON.stringify({ schemaVersion: "pi-plan-parent-lease.v1", planId, token, parentPid: 123, updatedAt });
}

function watchdogHarness({ content, now = 0, timeoutMs = 10, startupGraceMs = 10 } = {}) {
  let clock = now;
  let check;
  let stopped = false;
  let expired = 0;
  const watchdog = startParentLeaseWatchdog({
    leasePath: "/tmp/parent-lease.json",
    planId: "plan-1",
    token: "token-1",
    timeoutMs,
    startupGraceMs,
    checkIntervalMs: 1,
    readFile: async () => {
      if (content === undefined) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    now: () => clock,
    setInterval: (fn) => {
      check = fn;
      return { unref() {}, close() { stopped = true; } };
    },
    clearInterval: (timer) => timer.close(),
    onExpired: () => { expired += 1; },
  });
  return {
    run: async () => check(),
    set now(value) { clock = value; },
    get expired() { return expired; },
    get stopped() { return stopped; },
    watchdog,
  };
}

test("watchdog keeps a fresh matching lease alive", async () => {
  const harness = watchdogHarness({ content: lease({ updatedAt: 95 }), now: 100 });
  await harness.run();
  assert.equal(harness.expired, 0);
  harness.watchdog.stop();
  assert.equal(harness.stopped, true);
});

test("watchdog fails closed for mismatched lease identity", async () => {
  const harness = watchdogHarness({ content: lease({ token: "other", updatedAt: 100 }), now: 100 });
  await harness.run();
  assert.equal(harness.expired, 1);
});

test("watchdog expires a missing lease after startup grace", async () => {
  const harness = watchdogHarness({ content: undefined, now: 0, startupGraceMs: 10 });
  await harness.run();
  assert.equal(harness.expired, 0);
  harness.now = 11;
  await harness.run();
  assert.equal(harness.expired, 1);
});

test("watchdog expires stale leases once and does not check after stop", async () => {
  const harness = watchdogHarness({ content: lease({ updatedAt: 0 }), now: 11 });
  await harness.run();
  await harness.run();
  assert.equal(harness.expired, 1);
  harness.watchdog.stop();
  assert.equal(harness.stopped, true);
  await harness.run();
  assert.equal(harness.expired, 1);
});
