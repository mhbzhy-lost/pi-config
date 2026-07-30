import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const modulePath = "../scripts/lib/subagent-dispatch/process-birth-identity.ts";
const processBirthIdentityModule = await import(modulePath).catch(() => null);

function captureForTest(t, fallback) {
  const capture = processBirthIdentityModule?.captureProcessBirthIdentity;
  if (typeof capture === "function") return capture;
  t.diagnostic("RED: process-birth-identity.ts does not export captureProcessBirthIdentity");
  return fallback;
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

test("rejects every invalid PID with PROCESS_BIRTH_IDENTITY_INVALID", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t, async () => {
    throw new Error("invalid PID rejected without contract code");
  });
  for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(captureProcessBirthIdentity(pid), expectCode("PROCESS_BIRTH_IDENTITY_INVALID"));
  }
});

test("rejects invalid PID before invoking execFile", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t, async (_pid, { execFile }) => {
    await execFile("ps", []);
    throw errorWithCode("PROCESS_BIRTH_IDENTITY_INVALID");
  });
  for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    await assert.rejects(
      captureProcessBirthIdentity(pid, {
        execFile: async () => {
          calls += 1;
          return { stdout: Buffer.from("unexpected") };
        },
      }),
      expectCode("PROCESS_BIRTH_IDENTITY_INVALID"),
    );
    assert.equal(calls, 0, `invalid pid ${String(pid)} must not invoke execFile`);
  }
});

test("uses exact safe argv without shell options", async (t) => {
  const stdout = Buffer.from("Tue Jul 29 12:34:56 2026 node --flag='human fields stay opaque'  \n", "utf8");
  const captureProcessBirthIdentity = captureForTest(t, async (pid, { execFile }) => {
    await execFile("ps", ["-p", String(pid)]);
    return createHash("sha256").update(stdout).digest("hex");
  });
  const calls = [];
  await captureProcessBirthIdentity(123, {
    execFile: async (...args) => {
      calls.push(args);
      return { stdout };
    },
  });
  assert.deepEqual(calls, [["ps", ["-ww", "-p", "123", "-o", "lstart=", "-o", "command="]]]);
});

test("hashes complete untrimmed ps stdout bytes", async (t) => {
  const stdout = Buffer.from("Tue Jul 29 12:34:56 2026 node --flag='human fields stay opaque'  \n", "utf8");
  const captureProcessBirthIdentity = captureForTest(t, async (_pid, { execFile }) => {
    const { stdout: actualStdout } = await execFile("ps", ["-ww", "-p", "123", "-o", "lstart=", "-o", "command="]);
    return createHash("sha256").update(actualStdout.toString("utf8").trim()).digest("hex");
  });
  const identity = await captureProcessBirthIdentity(123, {
    execFile: async () => ({ stdout }),
  });
  assert.equal(identity, createHash("sha256").update(stdout).digest("hex"));
});

test("fails closed without a hash when ps stdout is empty or whitespace", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t, async () => "0".repeat(64));
  for (const stdout of [Buffer.alloc(0), Buffer.from(" \t\n", "utf8")]) {
    await assert.rejects(
      captureProcessBirthIdentity(123, { execFile: async () => ({ stdout }) }),
      expectCode("PROCESS_BIRTH_IDENTITY_UNAVAILABLE"),
    );
  }
});

test("fails closed without a hash when ps invocation fails", async (t) => {
  const captureProcessBirthIdentity = captureForTest(t, async () => "0".repeat(64));
  await assert.rejects(
    captureProcessBirthIdentity(123, { execFile: async () => { throw new Error("ps unavailable"); } }),
    expectCode("PROCESS_BIRTH_IDENTITY_UNAVAILABLE"),
  );
});

test("captures the current live process as a stable 64-character identity", async (t) => {
  let sequence = 0;
  const captureProcessBirthIdentity = captureForTest(t, async () => {
    sequence += 1;
    return createHash("sha256").update(String(sequence)).digest("hex");
  });
  const first = await captureProcessBirthIdentity(process.pid);
  const second = await captureProcessBirthIdentity(process.pid);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
});
