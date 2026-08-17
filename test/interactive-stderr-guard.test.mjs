import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);
let guardModule = {};
try {
  guardModule = await jiti.import("../pi/extensions/lib/interactive-stderr-guard.ts");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Cannot find module") && !message.includes("Failed to resolve import")) throw error;
}
let extensionModule = {};
try {
  extensionModule = await jiti.import("../pi/extensions/interactive-stderr-guard.ts");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Cannot find module") && !message.includes("Failed to resolve import")) throw error;
}

const { createRotatingStderrSink, installInteractiveStderrGuard } = guardModule;
const { registerInteractiveStderrGuard, resolveInteractiveStderrLogPath } = extensionModule;

function callbackFromArgs(encodingOrCallback, callback) {
  return typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
}

function createHost() {
  const host = new EventEmitter();
  const originalWrites = [];
  const originalWrite = function write(chunk, encodingOrCallback, callback) {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    originalWrites.push(Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk));
    const done = callbackFromArgs(encodingOrCallback, callback);
    if (done) queueMicrotask(() => done());
    return true;
  };
  host.stderr = { write: originalWrite };
  host.originalWrite = originalWrite;
  host.originalWrites = originalWrites;
  return host;
}

function requireGuard() {
  assert.equal(
    typeof installInteractiveStderrGuard,
    "function",
    "installInteractiveStderrGuard must be implemented",
  );
  return installInteractiveStderrGuard;
}

test("guard captures raw stderr and restores the original writer", async () => {
  const install = requireGuard();
  const host = createHost();
  const captured = [];
  const release = install({
    host,
    writeLog(chunk) {
      captured.push(chunk.toString("utf8"));
    },
  });

  let callbackCalled = false;
  const accepted = host.stderr.write("hidden", "utf8", () => { callbackCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(accepted, true);
  assert.deepEqual(host.originalWrites, []);
  assert.deepEqual(captured, ["hidden"]);
  assert.equal(callbackCalled, true);

  release();
  assert.equal(host.stderr.write, host.originalWrite);
  host.stderr.write("visible");
  assert.deepEqual(host.originalWrites, ["visible"]);
});

test("new reload owner cannot be restored by stale cleanup", () => {
  const install = requireGuard();
  const host = createHost();
  const firstCapture = [];
  const secondCapture = [];

  const releaseFirst = install({
    host,
    writeLog(chunk) { firstCapture.push(chunk.toString("utf8")); },
  });
  const guardedWrite = host.stderr.write;
  const releaseSecond = install({
    host,
    writeLog(chunk) { secondCapture.push(chunk.toString("utf8")); },
  });

  assert.equal(host.stderr.write, guardedWrite, "reload must reuse one process-level wrapper");
  releaseFirst();
  host.stderr.write("latest");

  assert.deepEqual(firstCapture, []);
  assert.deepEqual(secondCapture, ["latest"]);
  assert.deepEqual(host.originalWrites, []);

  releaseSecond();
  assert.equal(host.stderr.write, host.originalWrite);
});

test("guard restores stderr before the existing uncaught exception handler prints", () => {
  const install = requireGuard();
  const host = createHost();
  const captured = [];
  host.on("uncaughtException", () => {
    host.stderr.write("fatal diagnostic");
  });

  install({
    host,
    writeLog(chunk) { captured.push(chunk.toString("utf8")); },
  });
  host.emit("uncaughtException", new Error("boom"));

  assert.deepEqual(captured, []);
  assert.deepEqual(host.originalWrites, ["fatal diagnostic"]);
  assert.equal(host.stderr.write, host.originalWrite);
});

test("logging failure never falls back to the terminal", async () => {
  const install = requireGuard();
  const host = createHost();
  const failure = new Error("disk unavailable");
  install({
    host,
    writeLog() { throw failure; },
  });

  let callbackError;
  assert.doesNotThrow(() => {
    host.stderr.write("still hidden", (error) => { callbackError = error; });
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callbackError, failure);
  assert.deepEqual(host.originalWrites, []);
});

test("rotating sink retains the latest diagnostics without terminal output", () => {
  assert.equal(
    typeof createRotatingStderrSink,
    "function",
    "createRotatingStderrSink must be implemented",
  );
  const directory = mkdtempSync(join(tmpdir(), "pi-stderr-guard-"));
  const logPath = join(directory, "interactive-stderr.log");
  const fixedDate = new Date("2026-07-30T12:00:00.000Z");

  try {
    const sink = createRotatingStderrSink({
      logPath,
      maxBytes: 64,
      now: () => fixedDate,
    });
    sink(Buffer.from("first diagnostic\n"));
    sink(Buffer.from("second diagnostic\n"));

    assert.match(readFileSync(logPath, "utf8"), /second diagnostic/);
    assert.match(readFileSync(`${logPath}.1`, "utf8"), /first diagnostic/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rotating sink bounds a single oversized diagnostic", () => {
  assert.equal(
    typeof createRotatingStderrSink,
    "function",
    "createRotatingStderrSink must be implemented",
  );
  const directory = mkdtempSync(join(tmpdir(), "pi-stderr-guard-oversized-"));
  const logPath = join(directory, "interactive-stderr.log");

  try {
    const sink = createRotatingStderrSink({ logPath, maxBytes: 64 });
    sink(Buffer.alloc(512, "x"));
    assert.ok(statSync(logPath).size <= 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rotating sink creates owner-only diagnostic files", () => {
  assert.equal(
    typeof createRotatingStderrSink,
    "function",
    "createRotatingStderrSink must be implemented",
  );
  const directory = mkdtempSync(join(tmpdir(), "pi-stderr-guard-mode-"));
  const logPath = join(directory, "logs", "interactive-stderr.log");

  try {
    const sink = createRotatingStderrSink({ logPath });
    sink(Buffer.from("private diagnostic"));
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, "logs")).mode & 0o777, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rotating sink suppresses its own filesystem failures", () => {
  assert.equal(
    typeof createRotatingStderrSink,
    "function",
    "createRotatingStderrSink must be implemented",
  );
  const directory = mkdtempSync(join(tmpdir(), "pi-stderr-guard-failure-"));
  const blockingFile = join(directory, "not-a-directory");
  const logPath = join(blockingFile, "interactive-stderr.log");
  writeFileSync(blockingFile, "blocks mkdir");

  try {
    const sink = createRotatingStderrSink({ logPath });
    assert.doesNotThrow(() => sink(Buffer.from("must stay hidden")));
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extension resolves its log under the configured Pi agent directory", () => {
  assert.equal(
    typeof resolveInteractiveStderrLogPath,
    "function",
    "resolveInteractiveStderrLogPath must be implemented",
  );
  assert.equal(
    resolveInteractiveStderrLogPath({ PI_CODING_AGENT_DIR: "/custom/pi" }, "/home/tester"),
    "/custom/pi/logs/interactive-stderr.log",
  );
  assert.equal(
    resolveInteractiveStderrLogPath({}, "/home/tester"),
    "/home/tester/.pi/agent/logs/interactive-stderr.log",
  );
});

test("extension installs only in TUI mode and releases across lifecycle changes", () => {
  assert.equal(
    typeof registerInteractiveStderrGuard,
    "function",
    "registerInteractiveStderrGuard must be implemented",
  );
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
  };
  let installs = 0;
  let releases = 0;
  let scheduledRelease;
  let sinkPath;
  const dependencies = {
    resolveLogPath() { return "/tmp/pi-test/interactive-stderr.log"; },
    createSink(options) {
      sinkPath = options.logPath;
      return () => {};
    },
    install() {
      installs++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releases++;
      };
    },
    scheduleRelease(release) { scheduledRelease = release; },
  };

  registerInteractiveStderrGuard(pi, dependencies);
  handlers.get("session_start")({ reason: "startup" }, { mode: "rpc" });
  assert.equal(installs, 0);

  handlers.get("session_start")({ reason: "startup" }, { mode: "tui" });
  assert.equal(installs, 1);
  assert.equal(sinkPath, "/tmp/pi-test/interactive-stderr.log");

  handlers.get("session_start")({ reason: "reload" }, { mode: "tui" });
  assert.equal(installs, 2);
  assert.equal(releases, 1);

  handlers.get("session_shutdown")({ reason: "quit" }, { mode: "tui" });
  assert.equal(releases, 1, "shutdown must keep the guard through remaining teardown handlers");
  assert.equal(typeof scheduledRelease, "function");
  scheduledRelease();
  assert.equal(releases, 2);
});
