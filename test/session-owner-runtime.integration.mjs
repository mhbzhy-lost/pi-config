import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import test from "node:test";
import { createTestRuntime } from "./helpers/test-runtime.mjs";

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
const repoLocalPi = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const piArgs = ["--offline", "--provider", "fake", "--model", "fake/deterministic", "-e", provider, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

async function ptyFixture(t) {
  const fixture = await createTestRuntime(t, "session-owner-pty-matrix-");
  const root = await realpath(fixture.root);
  const store = createRegistryStore(fixture.registryDir);
  const cwd = fixture.cwd;
  await Promise.all(["home", "agent", "sessions", "tmp", "registry", "cwd"].map((name) => mkdir(join(root, name), { recursive: true, mode: 0o700 })));
  const piBinary = process.env.T8_PI_REAL_BIN ?? repoLocalPi;
  const piVersion = spawnSync(piBinary, ["--version"], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: "/tmp", TMPDIR: "/tmp" },
  });
  assert.equal(piVersion.status, 0, `PI_REAL_BIN must be executable: ${piBinary}\n${piVersion.stderr}`);
  return { root, store, cwd, piBinary, piVersion: piVersion.stdout.trim(), env: {
    PATH: process.env.PATH ?? "", HOME: join(root, "home"), PI_CODING_AGENT_DIR: fixture.agentDir,
    PI_CODING_AGENT_SESSION_DIR: fixture.sessionDir, PI_SESSION_OWNER_REGISTRY: store.root,
    PI_CODING_WORKSPACE_DIR: fixture.workspaceDir, PI_CODING_GOAL_DIR: fixture.goalDir,
    TMPDIR: join(root, "tmp"), PI_REAL_BIN: piBinary, T8_PI_VERSION: piVersion.stdout.trim(), LAUNCHER: launcher,
    PROVIDER: provider, TERM: "xterm-256color",
  } };
}

function startPty(state, args, marker = "PI_OWNER_READY", trace = undefined) {
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
  const spawnedAt = Date.now();
  const child = spawn("/usr/bin/expect", ["-c", expect], { cwd: state.cwd, env: state.env });
  if (trace) {
    trace.output = "";
    child.stdout.on("data", (chunk) => { trace.output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { trace.output += chunk.toString(); });
  }
  trace?.events.push({ at: new Date().toISOString(), elapsedMs: Date.now() - spawnedAt, type: "wrapper-spawn", pid: child.pid });
  child.once("exit", (code, signal) => trace?.events.push({ at: new Date().toISOString(), elapsedMs: Date.now() - spawnedAt, type: "wrapper-exit", pid: child.pid, code, signal }));
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

test("waitForRecord 在注册 watch 窗口内变 active 且无后续事件时仍返回记录", { timeout: 250 }, async (t) => {
  const fixture = await createTestRuntime(t, "session-owner-watch-race-");
  const store = createRegistryStore(fixture.registryDir);
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

test("waitForRecord 在 watch 不发事件且二次读取过早时周期重读 active record", { timeout: 250 }, async (t) => {
  const fixture = await createTestRuntime(t, "session-owner-watch-unreachable-");
  const store = createRegistryStore(fixture.registryDir);
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
  // 记录每次观察到的完整 live-record 集合；ready 只由权威 registry 状态判定。
  readRecords = () => listLiveRecords(store), watchDirectory = watch, pollIntervalMs = 25, timeoutMs = 60_000,
  onSample = undefined,
} = {}) {
  const ready = async () => {
    const records = await readRecords();
    onSample?.(records);
    return records.find(predicate);
  };
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

async function readyPty(state, args, { trace = undefined } = {}) {
  const previous = new Set((await listLiveRecords(state.store)).map((record) => record.ownerId));
  const child = startPty(state, args, "PI_OWNER_READY", trace);
  await waitForOutput(child, /PI_OWNER_READY/);
  trace?.events.push({ at: new Date().toISOString(), type: "wrapper-ready-marker", pid: child.pid });
  const record = await waitForRecord(state.store, (candidate) => !previous.has(candidate.ownerId) && candidate.state === "active" && candidate.sessionFile !== null, {
    onSample(records) { trace?.recordSamples.push({ at: new Date().toISOString(), records }); },
  });
  assert.ok(record, "ready Pi must commit a registry record");
  trace?.events.push({ at: new Date().toISOString(), type: "record-ready", ownerId: record.ownerId, pid: record.pid, state: record.state, sessionFile: record.sessionFile });
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
        TMPDIR: join(root, "tmp"), PI_REAL_BIN: process.env.T8_PI_REAL_BIN ?? repoLocalPi,
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

test("真实 Pi PTY: active recent blocks a second -c before real Pi exec", { timeout: 120_000 }, async (t) => {
  const state = await ptyFixture(t);
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

test("真实 Pi PTY: -c pins the exact free recent session while another old session is active", { timeout: 120_000 }, async (t) => {
  const state = await ptyFixture(t);
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

test("真实 Pi PTY: --no-extensions cannot bypass an active owner", { timeout: 120_000 }, async (t) => {
  const state = await ptyFixture(t);
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

test("真实 Pi PTY: selecting picker blocks -c and --session reuse before either Pi executes", { timeout: 120_000 }, async (t) => {
  const state = await ptyFixture(t);
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

test("真实 Pi PTY: SIGKILL owner is cleaned by ESRCH before the next wrapper starts", { timeout: 120_000 }, async (t) => {
  const state = await ptyFixture(t);
  const trace = { startedAt: new Date().toISOString(), piBinary: state.piBinary, piVersion: state.piVersion, events: [], recordSamples: [] };
  let first;
  let second;
  try {
    first = await readyPty(state, ["--", "killable owner"], { trace });
    assert.notEqual(first.record.pid, first.child.pid, "registry PID must be the real spawned Pi process");
    const killedPid = first.record.pid;
    const killAt = new Date().toISOString();
    process.kill(killedPid, "SIGKILL");
    trace.events.push({ at: killAt, type: "owner-sigkill", pid: killedPid });
    await new Promise((resolveExit) => first.child.once("exit", resolveExit));
    trace.events.push({ at: new Date().toISOString(), type: "first-wrapper-exit-observed", pid: first.child.pid, code: first.child.exitCode, signal: first.child.signalCode });
    // ESRCH 探针必须在 wrapper 退出之后：被 SIGKILL 的 pi 是 expect wrapper 的子进程，
    // wrapper 未退出前它是 zombie，而 kill(pid, 0) 对 zombie 会成功（PID 仍存在），
    // 因此在 wrapper 存活期间探针永远拿不到 ESRCH。生产语义也是「下一个 wrapper
    // 启动前」做 ESRCH 清理，此时前一个 wrapper 已退出并 reap 掉 zombie。
    const esrchDeadline = Date.now() + 10_000;
    let esrch = false;
    while (Date.now() < esrchDeadline) {
      try { process.kill(killedPid, 0); } catch (error) { if (error?.code === "ESRCH") { esrch = true; break; } }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    trace.events.push({ at: new Date().toISOString(), type: "owner-esrch-probe", pid: killedPid, esrch });
    assert.equal(esrch, true, "SIGKILL owner must be reaped and gone before replacement launch");
    const afterKillRecords = await listLiveRecords(state.store);
    trace.events.push({ at: new Date().toISOString(), type: "esrch-cleanup-observation", pid: killedPid, records: afterKillRecords });
    second = await readyPty(state, ["--", "ESRCH replacement owner"], { trace });
    const records = await listLiveRecords(state.store);
    assert.equal(records.length, 1);
    assert.equal(records[0].ownerId, second.record.ownerId);
    assert.notEqual(records[0].ownerId, first.record.ownerId);
    await quitPty(second.child);
    second = undefined;
  } finally {
    trace.finishedAt = new Date().toISOString();
    const traceFile = process.env.T8_TRACE_FILE;
    if (traceFile) await writeFile(traceFile, `${JSON.stringify(trace, null, 2)}\n`);
    await stopPty(second?.child);
    await killPty(first?.child);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("session_start 内层失败仍取消并记录原始异常及 cause", async () => {
  const handlers = new Map();
  const error = new Error("startup registry failure", { cause: new Error("guard acquisition failure") });
  const output = [];
  const original = console.error;
  let shutdowns = 0;
  let notices = 0;
  console.error = (...args) => output.push(format(...args));
  try {
    installSessionOwnerExtension({ on(event, handler) { handlers.set(event, handler); } }, {
      env: { PI_SESSION_OWNER_ID: "owner-observe-start", PI_SESSION_OWNER_REGISTRY: "/tmp/owner-observe-start" },
      store: createRegistryStore("/tmp/owner-observe-start"),
      async listLiveRecords() { throw error; },
    });
    const ctx = {
      sessionManager: { getCwd: () => process.cwd(), getSessionId: () => null, getSessionFile: () => null },
      ui: { notify() { notices += 1; } },
      async shutdown() { shutdowns += 1; },
    };
    assert.deepEqual(await handlers.get("session_start")({}, ctx), { cancel: true });
    assert.equal(notices, 1);
    assert.equal(shutdowns, 1);
    assert.match(output.join("\n"), /startup registry failure/);
    assert.match(output.join("\n"), /guard acquisition failure/);
  } finally { console.error = original; }
});

test("session_before_switch 内层失败仍取消并记录原始异常及 cause", async () => {
  const handlers = new Map();
  const error = new Error("switch identity failure", { cause: new Error("session manager unavailable") });
  const output = [];
  const original = console.error;
  let notices = 0;
  console.error = (...args) => output.push(format(...args));
  try {
    installSessionOwnerExtension({ on(event, handler) { handlers.set(event, handler); } }, {
      env: { PI_SESSION_OWNER_ID: "owner-observe-switch", PI_SESSION_OWNER_REGISTRY: "/tmp/owner-observe-switch" },
    });
    const ctx = {
      sessionManager: { getCwd() { throw error; }, getSessionId: () => null, getSessionFile: () => null },
      ui: { notify() { notices += 1; } },
    };
    assert.deepEqual(await handlers.get("session_before_switch")({ reason: "resume", targetSessionFile: "/tmp/next.jsonl" }, ctx), { cancel: true });
    assert.equal(notices, 1);
    assert.match(output.join("\n"), /switch identity failure/);
    assert.match(output.join("\n"), /session manager unavailable/);
  } finally { console.error = original; }
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
