import assert from "node:assert/strict";
import test from "node:test";
import { installRootSessionOwner } from "../packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts";

function fixture() {
  let now = 100;
  const timers = [];
  const pushes = [];
  let close;
  const subscription = {
    closed: new Promise((resolve, reject) => { close = () => reject(new Error("EOF")); }),
    dispose() { this.disposed = true; },
    push(value) { pushes.push(value); callback(value); },
  };
  let callback;
  const client = { subscribe(fn) { callback = fn; return Promise.resolve(subscription); }, dispose() { this.disposed = true; } };
  const kills = [];
  const messages = [];
  const pi = {
    sendMessage(...args) { messages.push(["sendMessage", args]); },
    sendUserMessage(...args) { messages.push(["sendUserMessage", args]); },
    triggerTurn(...args) { messages.push(["triggerTurn", args]); },
    followUp(...args) { messages.push(["followUp", args]); },
    steer(...args) { messages.push(["steer", args]); },
    reply(...args) { messages.push(["reply", args]); },
    resume(...args) { messages.push(["resume", args]); },
    spawn(...args) { messages.push(["spawn", args]); },
  };
  const ownerPromise = installRootSessionOwner(pi, {
    env: { PI_ROOT_SUBAGENT_BROKER_ENABLED: "1", PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: "root", PI_SUBAGENT_RUN_ID: "run" },
    createClient: () => client,
    clock: () => now,
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearInterval(id) { timers[id - 1].cleared = true; },
    kill(pid, signal) { kills.push({ pid, signal }); },
    pid: 77,
  });
  return { ownerPromise, subscription, close, timers, kills, messages, client, setNow(value) { now = value; }, pushes };
}
const lease = (expiresAt, extra = {}) => ({ type: "lease.updated", data: { runId: "run", ownerGeneration: 1, lastRenewedAt: 100, expiresAt, leaseId: "lease", renewalSequence: 0, ...extra } });

test("child lease expiry is deterministic, fenced, and has no Pi side effects", async () => {
  const f = fixture(); const owner = await f.ownerPromise;
  f.subscription.push(lease(200));
  assert.equal(owner.expiresAt, 200);
  f.setNow(199); f.timers[0].fn(); assert.deepEqual(f.kills, []);
  f.setNow(200); f.timers[0].fn(); f.timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.kills, [{ pid: 77, signal: "SIGTERM" }]);
  assert.equal(owner.terminationReason, "authority_lease_expired");
  assert.deepEqual(f.messages, []);
});

test("root closing, EOF, invalid leases, and dispose fail closed", async () => {
  const f = fixture(); const owner = await f.ownerPromise;
  f.subscription.push(lease(300, { runId: "foreign" }));
  f.subscription.push(lease(300, { ownerGeneration: 0 }));
  f.subscription.push(lease(300, { expiresAt: NaN }));
  assert.equal(owner.expiresAt, undefined);
  f.subscription.push(lease(300));
  f.subscription.push(lease(900, { ownerGeneration: 0 }));
  f.close(); await Promise.resolve(); assert.deepEqual(f.kills, []);
  f.setNow(300); f.timers[0].fn(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.kills.length, 1); assert.equal(owner.terminationReason, "authority_lease_expired");

  const d = fixture(); const disposed = await d.ownerPromise; disposed.dispose();
  assert.equal(d.timers[0].cleared, true); assert.equal(d.subscription.disposed, true); assert.equal(d.client.disposed, true);
  d.subscription.push(lease(100)); d.close(); d.timers[0].fn(); await Promise.resolve();
  assert.deepEqual(d.kills, []);

  const eof = fixture(); const eofOwner = await eof.ownerPromise; eof.close(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(eof.kills, [{ pid: 77, signal: "SIGTERM" }]);
  assert.equal(eofOwner.terminationReason, "subscription_eof");
});

test("root closing terminates once with explicit reason", async () => {
  const f = fixture(); const owner = await f.ownerPromise;
  f.subscription.push({ type: "root.closing" }); f.subscription.push({ type: "root.closing" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.kills, [{ pid: 77, signal: "SIGTERM" }]);
  assert.equal(owner.terminationReason, "explicit_stop");
});
