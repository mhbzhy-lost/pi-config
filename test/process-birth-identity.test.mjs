import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const modulePath = "../scripts/lib/subagent-dispatch/process-birth-identity.ts";
const processBirthIdentityModule = await import(modulePath).catch(() => null);

function moduleMissingError() {
  return Object.assign(new Error("process birth identity helper is missing"), {
    code: "PROCESS_BIRTH_IDENTITY_MODULE_MISSING",
  });
}

function captureForTest(t) {
  const capture = processBirthIdentityModule?.captureProcessBirthIdentity;
  if (typeof capture === "function") return capture;
  t.diagnostic("RED: process-birth-identity.ts does not export captureProcessBirthIdentity");
  return async () => { throw moduleMissingError(); };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("rejects every invalid PID before invoking execFile", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t);
  for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    await assert.rejects(
      captureProcessBirthIdentity(pid, { execFile: async () => { calls += 1; return { stdout: Buffer.from("unexpected") }; } }),
      expectCode("PROCESS_BIRTH_IDENTITY_INVALID"),
    );
    assert.equal(calls, 0, `invalid pid ${String(pid)} must not invoke execFile`);
  }
});

test("hashes the complete untrimmed ps stdout bytes and uses exact safe argv", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t);
  const stdout = Buffer.from("Tue Jul 29 12:34:56 2026 node --flag='human fields stay opaque'  \n", "utf8");
  const calls = [];
  const identity = await captureProcessBirthIdentity(123, {
    execFile: async (...args) => { calls.push(args); return { stdout }; },
  });
  assert.deepEqual(calls, [["ps", ["-ww", "-p", "123", "-o", "lstart=", "-o", "command="]]]);
  assert.equal(identity, createHash("sha256").update(stdout).digest("hex"));
  assert.match(identity, /^[a-f0-9]{64}$/);
});

test("fails closed without a hash when ps stdout is empty or whitespace", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t);
  for (const stdout of [Buffer.alloc(0), Buffer.from(" \t\n", "utf8")]) {
    await assert.rejects(
      captureProcessBirthIdentity(123, { execFile: async () => ({ stdout }) }),
      expectCode("PROCESS_BIRTH_IDENTITY_UNAVAILABLE"),
    );
  }
});

test("fails closed without a hash when ps invocation fails", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t);
  await assert.rejects(
    captureProcessBirthIdentity(123, { execFile: async () => { throw new Error("ps unavailable"); } }),
    expectCode("PROCESS_BIRTH_IDENTITY_UNAVAILABLE"),
  );
});

test("captures the current live process as a stable 64-character identity", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t);
  const first = await captureProcessBirthIdentity(process.pid);
  const second = await captureProcessBirthIdentity(process.pid);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
});
