import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createRegistryStore, listLiveRecords, prepareLaunch } from "../src/session-owner/registry.ts";
import { installSessionOwnerExtension } from "../src/session-owner/extension.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
assert.equal(npmRoot.status, 0, npmRoot.stderr);
const host = await import(join(npmRoot.stdout.trim(), "@earendil-works", "pi-coding-agent", "dist", "index.js"));

async function reserve(store, ownerId, reservation = { kind: "new" }) {
  const result = await prepareLaunch({
    store, ownerId, pid: process.pid, startedAt: new Date().toISOString(), reservation,
  });
  assert.equal(result.decision, "allow");
}

async function createRealRuntime(root, ownerId, { failReplacement = false, cancelResume = false } = {}) {
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const store = createRegistryStore(join(root, "registry"));
  await Promise.all([mkdir(agentDir, { recursive: true, mode: 0o700 }), mkdir(sessionDir, { recursive: true, mode: 0o700 })]);
  await reserve(store, ownerId);
  let factoryCalls = 0;
  const factory = async ({ cwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    factoryCalls += 1;
    if (failReplacement && factoryCalls > 1) throw new Error("replacement factory failed");
    const services = await host.createAgentSessionServices({
      cwd, agentDir: runtimeAgentDir,
      resourceLoaderOptions: {
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          (pi) => installSessionOwnerExtension(pi, {
            env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: store.root }, store,
          }),
          ...(cancelResume ? [(pi) => pi.on("session_before_switch", async (event) => event.reason === "resume" ? { cancel: true } : undefined)] : []),
        ],
      },
    });
    const created = await host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    await created.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error.error; } });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const initialSession = host.SessionManager.create(repoRoot, sessionDir);
  initialSession.newSession();
  const runtime = await host.createAgentSessionRuntime(factory, {
    cwd: repoRoot, agentDir, sessionManager: initialSession,
  });
  return { runtime, store, agentDir, sessionDir };
}

const launcher = join(repoRoot, "scripts", "pi-launcher.zsh");
const provider = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
const piArgs = ["--offline", "--provider", "fake", "--model", "fake/deterministic", "-e", provider, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

async function ptyFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "session-owner-pty-matrix-")));
  const store = createRegistryStore(join(root, "registry"));
  const cwd = join(root, "cwd");
  await Promise.all(["home", "agent", "sessions", "tmp", "registry", "cwd"].map((name) => mkdir(join(root, name), { recursive: true, mode: 0o700 })));
  return { root, store, cwd, env: {
    PATH: process.env.PATH ?? "", HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_SESSION_OWNER_REGISTRY: store.root,
    TMPDIR: join(root, "tmp"), PI_REAL_BIN: "/opt/homebrew/bin/pi", LAUNCHER: launcher,
    PROVIDER: provider, TERM: "xterm-256color",
  } };
}

function startPty(state, args, marker = "PI_OWNER_READY") {
  const command = [...piArgs, "--session-dir", join(state.root, "sessions"), ...args].map((value) => JSON.stringify(value)).join(" ");
  const expect = `set timeout 20
spawn -noecho $env(LAUNCHER) ${command}
expect {
  -re {deterministic} { send_user "${marker}\\n" }
  eof { exit 1 }
  timeout { exit 1 }
}
expect_user -re {PI_OWNER_QUIT}
send -- "\\004"
expect {
  eof { exit 0 }
  timeout { exit 1 }
}
`;
  const child = spawn("/usr/bin/expect", ["-c", expect], { cwd: state.cwd, env: state.env });
  return child;
}

function startPicker(state, readyPattern) {
  const command = [...piArgs, "--session-dir", join(state.root, "sessions"), "-r"].map((value) => JSON.stringify(value)).join(" ");
  const expect = `set timeout 20
spawn -noecho $env(LAUNCHER) ${command}
expect {
  -re {${readyPattern}} { send_user "PI_PICKER_READY\\n" }
  eof { exit 1 }
  timeout { exit 1 }
}
expect_user -re {PI_PICKER_CANCEL}
send -- "\\003"
expect {
  eof { exit 0 }
  timeout { exit 1 }
}
`;
  return spawn("/usr/bin/expect", ["-c", expect], { cwd: state.cwd, env: state.env });
}

function waitForOutput(child, pattern) {
  return new Promise((resolveOutput, reject) => {
    let captured = "";
    child.stdout.on("data", (chunk) => {
      captured += chunk;
      if (pattern.test(captured)) resolveOutput(captured);
    });
    child.stderr.on("data", (chunk) => { captured += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Pi exited before ${pattern} (${code}): ${captured}`)));
  });
}

test("waitForRecord 在注册 watch 窗口内变 active 且无后续事件时仍返回记录", { timeout: 250 }, async () => {
  const store = createRegistryStore(join(tmpdir(), `session-owner-watch-race-${process.pid}`));
  const ownerId = "owner-watch-race-0123456789";
  const activeRecord = {
    ownerId, pid: process.pid, state: "active", sessionFile: "/tmp/selected.jsonl",
  };
  let records = [];
  let closeCount = 0;

  const record = await waitForRecord(store, (candidate) => candidate.state === "active", {
    readRecords: async () => records,
    watchDirectory() {
      // 真实注册表在 watch 注册完成前发布 active，且不会再产生事件。
      records = [activeRecord];
      return { close() { closeCount += 1; } };
    },
    timeoutMs: 50,
  });

  assert.equal(record, activeRecord);
  assert.equal(closeCount, 1, "成功读取必须只关闭一次 watcher");
});

test("waitForRecord 在 watch 不发事件且二次读取过早时周期重读 active record", { timeout: 250 }, async () => {
  const store = createRegistryStore(join(tmpdir(), `session-owner-watch-unreachable-${process.pid}`));
  const activeRecord = { ownerId: "owner-watch-unreachable-012345", state: "active" };
  let reads = 0;
  let closeCount = 0;

  const record = await waitForRecord(store, (candidate) => candidate.state === "active", {
    readRecords: async () => (++reads < 3 ? [] : [activeRecord]),
    watchDirectory() { return { close() { closeCount += 1; } }; },
    pollIntervalMs: 1,
    timeoutMs: 50,
  });

  assert.equal(record, activeRecord);
  assert.equal(reads, 3, "首次、二次与周期重读依次观察 registry");
  assert.equal(closeCount, 1, "周期重读成功必须只关闭一次 watcher");
});

async function waitForRecord(store, predicate, {
  readRecords = () => listLiveRecords(store), watchDirectory = watch, pollIntervalMs = 25, timeoutMs = 20_000,
} = {}) {
  const ready = async () => (await readRecords()).find(predicate);
  const initial = await ready();
  if (initial) return initial;
  return new Promise((resolveRecord, reject) => {
    let settled = false;
    let watcher;
    let timer;
    let poller;
    let observing = false;
    function finish(done, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      watcher?.close();
      done(value);
    }
    const observe = async () => {
      if (settled || observing) return;
      observing = true;
      try {
        const record = await ready();
        if (record) finish(resolveRecord, record);
      } catch (error) {
        if (error?.code !== "REGISTRY_UNAVAILABLE") finish(reject, error);
      } finally {
        observing = false;
      }
    };
    try {
      watcher = watchDirectory(store.root, observe);
      if (settled) watcher.close();
      timer = setTimeout(() => finish(reject, new Error("registry record did not reach its ready state")), timeoutMs);
      poller = setInterval(() => void observe(), pollIntervalMs);
      void observe();
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function readyPty(state, args) {
  const previous = new Set((await listLiveRecords(state.store)).map((record) => record.ownerId));
  const child = startPty(state, args);
  await waitForOutput(child, /PI_OWNER_READY/);
  const record = await waitForRecord(state.store, (candidate) => !previous.has(candidate.ownerId) && candidate.state === "active" && candidate.sessionFile !== null);
  assert.ok(record, "ready Pi must commit a registry record");
  return { child, record };
}

async function quitPty(child) {
  child.stdin.end("PI_OWNER_QUIT\n");
  const code = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("exit", resolveStatus);
  });
  assert.equal(code, 0);
}

async function killPty(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function stopPty(child) {
  if (!child || child.exitCode !== null) return;
  try { await quitPty(child); }
  catch { await killPty(child); }
}

async function cancelPicker(child) {
  child.stdin.end("PI_PICKER_CANCEL\n");
  await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
}

async function freeSession(state, prompt) {
  const { child, record } = await readyPty(state, ["--", prompt]);
  const sessionFile = record.sessionFile;
  assert.ok(sessionFile, "real Pi must create a session file");
  await quitPty(child);
  return sessionFile;
}

async function assertBlocked(state, args, records, sessions) {
  const child = startPty(state, args);
  const output = await waitForOutput(child, /Pi session 已阻断/);
  const code = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("exit", resolveStatus);
  });
  assert.equal(code, 1, output);
  assert.equal((await listLiveRecords(state.store)).length, records, "blocked wrapper must not create a record");
  assert.deepEqual(await readdir(join(state.root, "sessions")), sessions, "blocked wrapper must not execute real Pi");
}

test("real AgentSessionRuntime invokes new, resume, fork, import, reload, and factory failure lifecycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-runtime-"));
  const ownerId = "owner-runtime-lifecycle-0123456789";
  let fixture;
  let failing;
  let cancelled;
  try {
    fixture = await createRealRuntime(root, ownerId);
    assert.equal((await listLiveRecords(fixture.store))[0].state, "active");

    const source = host.SessionManager.create(repoRoot, fixture.sessionDir);
    source.appendMessage({
      role: "assistant", content: [{ type: "text", text: "import source" }], api: "faux", provider: "faux", model: "faux",
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    });
    const sourceFile = source.getSessionFile();
    assert.ok(sourceFile);
    assert.deepEqual(await fixture.runtime.switchSession(sourceFile), { cancelled: false });
    assert.equal((await listLiveRecords(fixture.store))[0].state, "active");

    const entryId = fixture.runtime.session.sessionManager.appendMessage({ role: "user", content: "fork source", timestamp: new Date().toISOString() });
    fixture.runtime.session.sessionManager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "fork reply" }], api: "faux", provider: "faux", model: "faux",
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    });
    assert.deepEqual(await fixture.runtime.fork(entryId), { cancelled: false, selectedText: "fork source" });
    assert.equal((await listLiveRecords(fixture.store))[0].state, "active");
    assert.deepEqual(await fixture.runtime.newSession(), { cancelled: false });
    assert.equal((await listLiveRecords(fixture.store))[0].state, "active");
    await fixture.runtime.importFromJsonl(sourceFile);
    assert.equal((await listLiveRecords(fixture.store))[0].state, "active");
    await fixture.runtime.session.reload();
    assert.equal((await listLiveRecords(fixture.store))[0].state, "active");

    cancelled = await createRealRuntime(join(root, "cancelled"), "owner-runtime-cancelled-012345", { cancelResume: true });
    const cancelSource = host.SessionManager.create(repoRoot, cancelled.sessionDir);
    cancelSource.appendMessage({
      role: "assistant", content: [{ type: "text", text: "cancel source" }], api: "faux", provider: "faux", model: "faux",
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    });
    assert.deepEqual(await cancelled.runtime.switchSession(cancelSource.getSessionFile()), { cancelled: true });
    assert.equal((await listLiveRecords(cancelled.store))[0].state, "active");

    failing = await createRealRuntime(join(root, "failing"), "owner-runtime-failure-012345678", { failReplacement: true });
    await assert.rejects(failing.runtime.newSession(), /replacement factory failed/);
    assert.equal((await listLiveRecords(failing.store))[0].state, "transitioning");
  } finally {
    await fixture?.runtime.dispose();
    await cancelled?.runtime.dispose();
    await failing?.runtime.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("真实 Pi Expect PTY 落盘 assistant 响应并在运行中保持 active owner", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-pty-"));
  const store = createRegistryStore(join(root, "registry"));
  const cwd = join(root, "cwd");
  let child;
  try {
    await Promise.all(["home", "agent", "sessions", "tmp", "registry", "cwd"].map((name) => mkdir(join(root, name), { recursive: true, mode: 0o700 })));
    const expect = `set timeout 20
spawn -noecho $env(LAUNCHER) --offline --provider fake --model fake/deterministic -e $env(PROVIDER) --no-skills --no-prompt-templates --no-themes --no-context-files -- "real persistent owner"
expect {
  -re {real persistent owner} {}
  eof { exit 1 }
  timeout { exit 1 }
}
expect {
  -re {deterministic} { send_user "PI_OWNER_READY\\n" }
  eof { exit 1 }
  timeout { exit 1 }
}
expect_user -re {PI_OWNER_QUIT}
send -- "\\004"
expect {
  eof { exit 0 }
  timeout { exit 1 }
}
`;
    child = spawn("/usr/bin/expect", ["-c", expect], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_SESSION_OWNER_REGISTRY: store.root,
        TMPDIR: join(root, "tmp"), PI_REAL_BIN: "/opt/homebrew/bin/pi",
        LAUNCHER: join(repoRoot, "scripts", "pi-launcher.zsh"),
        PROVIDER: join(repoRoot, "test", "fixtures", "deterministic-provider.mjs"), TERM: "xterm-256color",
      },
    });
    const output = await new Promise((resolveOutput, reject) => {
      let captured = "";
      child.stdout.on("data", (chunk) => {
        captured += chunk;
        if (captured.includes("PI_OWNER_READY")) resolveOutput(captured);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Pi exited before ready (${code}): ${captured}`)));
    });
    assert.match(output, /PI_OWNER_READY/);
    const [record] = await listLiveRecords(store);
    assert.equal(record.state, "active");
    assert.equal(record.cwd, await realpath(cwd));
    assert.ok(record.sessionFile?.startsWith(join(root, "sessions")));
    const files = await readdir(join(root, "sessions"));
    assert.equal(files.length, 1);
    assert.match(await readFile(join(root, "sessions", files[0]), "utf8"), /deterministic/);
    child.stdin.end("PI_OWNER_QUIT\n");
    const status = await new Promise((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolveStatus(code));
    });
    assert.equal(status, 0);
    assert.deepEqual(await listLiveRecords(store), []);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("真实 Pi PTY: active recent blocks a second -c before real Pi exec", { timeout: 120_000 }, async () => {
  const state = await ptyFixture();
  let first;
  try {
    const session = await freeSession(state, "active recent fixture");
    first = await readyPty(state, ["--session", session, "--", "active recent owner"]);
    const sessions = await readdir(join(state.root, "sessions"));
    await assertBlocked(state, ["-c", "--", "blocked continuation"], 1, sessions);
  } finally {
    await stopPty(first?.child);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("真实 Pi PTY: -c pins the exact free recent session while another old session is active", { timeout: 120_000 }, async () => {
  const state = await ptyFixture();
  let owner;
  let continued;
  try {
    const oldSession = await freeSession(state, "old free session");
    const recentSession = await freeSession(state, "recent free session");
    owner = await readyPty(state, ["--session", oldSession, "--", "active old owner"]);
    const oldTime = new Date(Date.now() - 60_000);
    const recentTime = new Date();
    await utimes(oldSession, oldTime, oldTime);
    await utimes(recentSession, recentTime, recentTime);
    continued = await readyPty(state, ["-c", "--", "exact free continuation"]);
    assert.equal(continued.record.sessionFile, recentSession);
    assert.notEqual(continued.record.sessionFile, owner.record.sessionFile);
    await quitPty(continued.child);
    continued = undefined;
  } finally {
    await stopPty(continued?.child);
    await stopPty(owner?.child);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("真实 Pi PTY: --no-extensions cannot bypass an active owner", { timeout: 120_000 }, async () => {
  const state = await ptyFixture();
  let first;
  try {
    const session = await freeSession(state, "no extension fixture");
    first = await readyPty(state, ["--no-extensions", "--session", session, "--", "forced extension owner"]);
    assert.equal(first.record.state, "active");
    const sessions = await readdir(join(state.root, "sessions"));
    await assertBlocked(state, ["-c", "--", "no extension bypass blocked"], 1, sessions);
  } finally {
    await stopPty(first?.child);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("真实 Pi PTY: selecting picker blocks -c and --session reuse before either Pi executes", { timeout: 120_000 }, async () => {
  const state = await ptyFixture();
  let picker;
  try {
    const session = await freeSession(state, "picker free fixture");
    picker = startPicker(state, "picker free fixture");
    await waitForOutput(picker, /PI_PICKER_READY/);
    const selecting = await waitForRecord(state.store, (record) => record.state === "selecting");
    assert.equal(selecting.state, "selecting");
    const sessions = await readdir(join(state.root, "sessions"));
    await assertBlocked(state, ["-c", "--", "picker continuation blocked"], 1, sessions);
    await assertBlocked(state, ["--session", session, "--", "picker explicit blocked"], 1, sessions);
    await cancelPicker(picker);
    picker = undefined;
  } finally {
    await killPty(picker);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("真实 Pi PTY: SIGKILL owner is cleaned by ESRCH before the next wrapper starts", { timeout: 120_000 }, async () => {
  const state = await ptyFixture();
  let first;
  let second;
  try {
    first = await readyPty(state, ["--", "killable owner"]);
    assert.notEqual(first.record.pid, first.child.pid, "registry PID must be the real spawned Pi process");
    process.kill(first.record.pid, "SIGKILL");
    await new Promise((resolveExit) => first.child.once("exit", resolveExit));
    second = await readyPty(state, ["--", "ESRCH replacement owner"]);
    const records = await listLiveRecords(state.store);
    assert.equal(records.length, 1);
    assert.equal(records[0].ownerId, second.record.ownerId);
    assert.notEqual(records[0].ownerId, first.record.ownerId);
    await quitPty(second.child);
    second = undefined;
  } finally {
    await stopPty(second?.child);
    await killPty(first?.child);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("owner-less RPC/direct runtime is explicitly unsupported and writes no record", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-no-owner-"));
  const store = createRegistryStore(join(root, "registry"));
  try {
    const handlers = [];
    installSessionOwnerExtension({ on(...args) { handlers.push(args); } }, { env: {}, store });
    assert.deepEqual(handlers, []);
    assert.deepEqual(await listLiveRecords(store), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
