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
import { startControlledPty } from "./helpers/controlled-pty.mjs";

import { createRegistryStore, listLiveRecords, prepareLaunch } from "../src/session-owner/registry.ts";
import { installSessionOwnerExtension } from "../src/session-owner/extension.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { loadPiTestRuntime } from './helpers/pi-runtime.mjs';
const { codingAgent: host } = await loadPiTestRuntime(import.meta.url);

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
const repoLocalPi = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const piArgs = ["--offline", "--no-mcp", "--provider", "fake", "--model", "fake/deterministic", "-e", provider, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

async function ptyFixture(t) {
  // 真实 Host 根不能沿用任何结局都 rm 的通用 fixture。
  const root = await realpath(await mkdtemp(join(tmpdir(), "session-owner-controlled-")));
  const fixture = { agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), workspaceDir: join(root, "workspaces"), goalDir: join(root, "goals") };
  const store = createRegistryStore(join(root, "registry"));
  const cwd = join(root, "cwd");
  await Promise.all(["home", "agent", "sessions", "tmp", "registry", "cwd"].map((name) => mkdir(join(root, name), { recursive: true, mode: 0o700 })));
  const piBinary = process.env.T8_PI_REAL_BIN ?? repoLocalPi;
  const piVersion = spawnSync(piBinary, ["--version"], {
    encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
  });
  assert.equal(piVersion.status, 0, `PI_REAL_BIN must be executable: ${piBinary}\n${piVersion.stderr}`);
  const state = { root, store, cwd, piBinary, leases: [], piVersion: piVersion.stdout.trim(), env: {
    PATH: process.env.PATH ?? "", HOME: join(root, "home"), PI_CODING_AGENT_DIR: fixture.agentDir,
    PI_CODING_AGENT_SESSION_DIR: fixture.sessionDir, PI_SESSION_OWNER_REGISTRY: store.root,
    PI_CODING_WORKSPACE_DIR: fixture.workspaceDir, PI_CODING_GOAL_DIR: fixture.goalDir,
    PI_HOST_NODE: process.execPath, PI_HOST_ROOT: dirname(dirname(repoLocalPi)), PI_PACKAGE_DIR: dirname(dirname(repoLocalPi)), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK:"1", PI_TELEMETRY:"0", TMPDIR: join(root, "tmp"), PI_REAL_BIN: piBinary,
    PROVIDER: provider, TERM: "xterm-256color",
  } };
  t.after(async () => {
    for (const lease of state.leases) await stopPty(lease);
    const ledger = state.leases.map((lease) => lease.snapshot());
    const clean = ledger.every((entry) => entry.exit?.status >= 0 && entry.driverExited !== null && entry.residualPaths.length === 0);
    console.log(`[owner-pty-ledger] ${JSON.stringify({ root, clean, leases: ledger.map(({ pid, driverPid, exit, driverExited, residualPaths }) => ({ pid, driverPid, exit, driverExited, residualPaths })) })}`);
    if (clean && t.passed) await rm(root, { recursive: true, force: true });
    else await writeFile(join(root, "retained.json"), JSON.stringify(ledger, null, 2), { mode: 0o600 });
  });
  return state;
}

async function startPty(state, args, _marker = "PI_OWNER_READY", trace = undefined) {
  const child = await startControlledPty({
    command: launcher, args: [...piArgs, "--session-dir", join(state.root, "sessions"), ...args],
    cwd: state.cwd, env: state.env, cols: 100, rows: 30,
    artifactDir: join(state.root, `pty-${state.leases.length}`), deadlineMs: 20_000,
  });
  state.leases.push(child);
  trace?.events.push({ at: new Date().toISOString(), type: "controlled-child-start", pid: child.pid, driverPid: child.driverPid });
  return child;
}

async function startPicker(state, readyPattern) {
  const child = await startPty(state, ["-r"]);
  await child.waitForText(readyPattern, 20_000);
  return child;
}

async function waitForOutput(child, pattern) {
  return (await child.waitForText(pattern, 20_000)).output;
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
  const child = await startPty(state, args, "PI_OWNER_READY", trace);
  await waitForOutput(child, /deterministic/i);
  trace?.events.push({ at: new Date().toISOString(), type: "wrapper-ready-marker", pid: child.pid });
  const record = await waitForRecord(state.store, (candidate) => !previous.has(candidate.ownerId) && candidate.state === "active" && candidate.sessionFile !== null, {
    onSample(records) { trace?.recordSamples.push({ at: new Date().toISOString(), records }); },
  });
  assert.ok(record, "ready Pi must commit a registry record");
  assert.equal(record.pid, child.pid, "registry PID 必须是 driver 的直接 Pi child");
  await child.sampleIdentity();
  // 页脚模型名在响应完成之前就可见；使用本用例合法落盘的 assistant entry 作完成屏障，
  // 避免随后 utimes 与尚未完成的首轮 _persist 竞争，把 old session 意外变成最新。
  if (args.includes('--')) {
    await new Promise((resolveReady, reject) => {
      let settled = false;
      const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolveReady(); };
      const check = async () => {
        try {
          const entries = (await readFile(record.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
          const prompt = args.slice(args.indexOf('--') + 1).join(' ');
          const userIndex = entries.findLastIndex((entry) => entry.type === 'message' && entry.message?.role === 'user' && (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n')) === prompt);
          if (userIndex >= 0 && entries.slice(userIndex + 1).some((entry) => entry.type === 'message' && entry.message?.role === 'assistant' && entry.message?.content?.some((block) => block.type === 'text' && block.text === 'deterministic'))) finish();
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) finish(error); }
      };
      const watcher = watch(dirname(record.sessionFile), () => { void check(); });
      const timer = setTimeout(() => finish(new Error('fixture assistant 尚未真实落盘')), 20_000);
      void check();
    });
  }
  trace?.events.push({ at: new Date().toISOString(), type: "record-ready", ownerId: record.ownerId, pid: record.pid, state: record.state, sessionFile: record.sessionFile });
  return { child, record };
}

async function quitPty(child) {
  if (child.exit === null) await child.write('\x1b\x15');
  const result = await child.close();
  assert.equal(result.exited, true, JSON.stringify(result));
  assert.equal(result.exit.code, 0);
}

async function stopPty(child) {
  if (!child) return;
  if (child.exit === null) await child.write('\x1b\x15').catch(() => {});
  const result = await child.close();
  assert.equal(result.exited, true, `保留未退出现场：${JSON.stringify(result)}`);
}

async function cancelPicker(child) {
  await child.write('\x03');
  await child.waitForExit(20_000);
  await child.close();
}

async function freeSession(state, prompt) {
  const { child, record } = await readyPty(state, ["--", prompt]);
  const sessionFile = record.sessionFile;
  assert.ok(sessionFile, "real Pi must create a session file");
  await quitPty(child);
  return sessionFile;
}

async function assertBlocked(state, args, records, sessions) {
  const child = await startPty(state, args);
  const output = await waitForOutput(child, /Pi session 已阻断/);
  const exit = await child.waitForExit(20_000);
  await child.close();
  assert.equal(exit.code, 1, output);
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
    const cancelBefore = (await listLiveRecords(cancelled.store))[0];
    assert.deepEqual(await cancelled.runtime.switchSession(cancelSource.getSessionFile()), { cancelled: true });
    assert.equal((await listLiveRecords(cancelled.store))[0].state, "active");
    // 更晚 handler 取消：owner 已 reserve，SDK 无结果 hook → 旧 source 不动，target pending 保守保留。
    const lateCancel = (await listLiveRecords(cancelled.store))[0];
    assert.equal(lateCancel.pendingSessionFile, await realpath(cancelSource.getSessionFile()), "晚 cancel 必须保留 pending target");
    assert.equal(lateCancel.switchReservation?.phase, "reserved", "晚 cancel 不得触发自动 abort");
    assert.deepEqual([lateCancel.cwd, lateCancel.sessionId, lateCancel.sessionFile], [cancelBefore.cwd, cancelBefore.sessionId, cancelBefore.sessionFile], "cancel 后顶层仍是他自己的 source");
    assert.deepEqual(lateCancel.switchReservation?.source, { cwd: cancelBefore.cwd, sessionId: cancelBefore.sessionId, sessionFile: cancelBefore.sessionFile }, "reserved receipt 的 source 就是当前顶层身份");

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

// ---- S1v：受控运行期事务的真实 SDK 证据（不依赖 PTY/真实用户 Host）----
// 两个新场景只用公开 runtime API（switchSession/importFromJsonl）+ 自生成的合法 SessionManager 会话文件，
// sessionDir/registry/agentDir 全部在本用例的临时根下，不读用户配置、不访问模型网络。
async function onlyRecord(store, ownerId) {
  const record = (await listLiveRecords(store)).find((candidate) => candidate.ownerId === ownerId);
  assert.ok(record, `missing record for ${ownerId}`);
  return record;
}

function conversationMessage(text) {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "faux", provider: "faux", model: "faux",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

test("真实 SDK：外部 import 的 destination 在 before 时尚无 header → blocked-upstream 取消且不复制", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-import-external-"));
  const ownerId = "owner-import-external-0123456789";
  let fixture;
  try {
    fixture = await createRealRuntime(root, ownerId);
    // 输入在 sessionDir 之外：上游先算出尚未创建的 destination，再把该路径发给 session_before_switch。
    const externalDir = join(root, "external");
    await mkdir(externalDir, { recursive: true, mode: 0o700 });
    const external = host.SessionManager.create(repoRoot, externalDir);
    external.appendMessage(conversationMessage("external import input"));
    const inputPath = external.getSessionFile();
    assert.ok(inputPath, "真实 SessionManager 必须落盘导入源");

    const before = await onlyRecord(fixture.store, ownerId);
    const beforeFiles = await readdir(fixture.sessionDir);

    assert.deepEqual(await fixture.runtime.importFromJsonl(inputPath), { cancelled: true });

    const after = await onlyRecord(fixture.store, ownerId);
    assert.equal(after.state, "active", "取消不得把旧 source 变成 transitioning");
    assert.deepEqual([after.cwd, after.sessionId, after.sessionFile], [before.cwd, before.sessionId, before.sessionFile], "旧 source 身份不得被释放或改写");
    assert.equal(after.pendingSessionFile, null, "身份不可验证的目标不得留下 pending claim");
    assert.equal(after.switchReservation ?? null, null, "身份不可验证的目标不得新增 reservation");
    assert.deepEqual(await readdir(fixture.sessionDir), beforeFiles, "取消后 sessionDir 不得出现被复制的 destination");
  } finally {
    await fixture?.runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("真实 SDK：两个 owner 竞争同一 resume 目标 → 胜者原子提交，败者取消且不动自己记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-dual-resume-"));
  const winnerId = "owner-dual-winner-0123456789";
  const loserId = "owner-dual-loser-0123456789abc";
  let winner;
  let loser;
  try {
    // 同一 registry 根、同一 PID（同进程），只有 ownerId 不同：正是「同 PID 另一 owner 仍冲突」形状。
    winner = await createRealRuntime(root, winnerId);
    loser = await createRealRuntime(root, loserId);
    const shared = host.SessionManager.create(repoRoot, winner.sessionDir);
    shared.appendMessage(conversationMessage("contested target"));
    // macOS 下 mkdtemp 根可能处于符号链（/var -> /private/var）之下：事务记录统一取 canonical 形式。
    const targetFile = await realpath(shared.getSessionFile());
    assert.ok(targetFile, "真实 SessionManager 必须落盘竞争目标");
    const loserBefore = await onlyRecord(loser.store, loserId);

    const winning = winner.runtime.switchSession(targetFile);
    assert.deepEqual(await winning, { cancelled: false }, "先提交者必须完成受控事务");
    const winnerRecord = await onlyRecord(winner.store, winnerId);
    assert.equal(winnerRecord.state, "active");
    assert.equal(winnerRecord.sessionFile, targetFile, "旧 source 释放与目标生效只在那一次原子 publish 同时发生");
    assert.equal(winnerRecord.pendingSessionFile, null, "commit 后 pending 必须清除");
    assert.equal(winnerRecord.switchReservation?.phase, "committed", "commit 后只留幂等 receipt");

    assert.deepEqual(await loser.runtime.switchSession(targetFile), { cancelled: true }, "同目标竞争败者必须被取消");
    assert.deepEqual(await onlyRecord(loser.store, loserId), loserBefore, "败者取消不得改动自己的记录");

    // quit 只释放自身：同一个真实 SDK 进程里另一个仍存活的 owner 记录不得被动。
    await loser.runtime.dispose();
    const survivors = await listLiveRecords(loser.store);
    assert.deepEqual(survivors.map((record) => record.ownerId), [winnerId], "quit 只释放自己，即使 PID 完全相同");
  } finally {
    // 上面已验证过 quit 只自身；重复 dispose 不得把已释放记录当失败。
    await loser?.runtime.dispose().catch(() => {});
    await winner?.runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("真实 Pi Expect PTY 落盘 assistant 响应并在运行中保持 active owner", { timeout: 90_000 }, async (t) => {
  const state = await ptyFixture(t);
  const { child, record } = await readyPty(state, ["--", "real persistent owner"]);
  await child.waitForText("deterministic", 20_000);
  assert.equal(record.state, "active");
  assert.equal(record.cwd, await realpath(state.cwd));
  assert.ok(record.sessionFile?.startsWith(join(state.root, "sessions")));
  const files = await readdir(join(state.root, "sessions"));
  assert.equal(files.length, 1);
  // 仅读取本用例自造的会话文件。
  assert.match(await readFile(join(state.root, "sessions", files[0]), "utf8"), /deterministic/);
  await quitPty(child);
  assert.deepEqual(await listLiveRecords(state.store), []);
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
  }
});

test("真实 Pi PTY: selecting picker blocks -c and --session reuse before either Pi executes", { timeout: 120_000 }, async (t) => {
  const state = await ptyFixture(t);
  let picker;
  try {
    const session = await freeSession(state, "picker free fixture");
    picker = await startPicker(state, "picker free fixture");
    const selecting = await waitForRecord(state.store, (record) => record.state === "selecting");
    assert.equal(selecting.state, "selecting");
    const sessions = await readdir(join(state.root, "sessions"));
    await assertBlocked(state, ["-c", "--", "picker continuation blocked"], 1, sessions);
    await assertBlocked(state, ["--session", session, "--", "picker explicit blocked"], 1, sessions);
    await cancelPicker(picker);
    picker = undefined;
  } finally {
    if (picker) await cancelPicker(picker);
  }
});

test("真实 Pi PTY: SIGKILL owner is cleaned by ESRCH before the next wrapper starts", { timeout: 120_000 }, async (t) => {
  if (process.env.PI_TEST_OWNER_SIGKILL !== "1") { t.skip("fixture-sigkill 尚未授权"); return; }
  const state = await ptyFixture(t);
  const trace = { startedAt: new Date().toISOString(), piBinary: state.piBinary, piVersion: state.piVersion, events: [], recordSamples: [] };
  let first;
  let second;
  try {
    first = await readyPty(state, ["--", "killable owner"], { trace });
    assert.equal(first.record.pid, first.child.pid, "registry PID 必须等于受控直接 Pi child");
    const killedPid = first.record.pid;
    const killAt = new Date().toISOString();
    const recheck = await first.child.sampleIdentity();
    assert.equal(recheck.matches, true);
    const killed = await first.child.signalFixtureKill({ explicitOneTimePermission: true, leaseId: first.child.leaseId, pid: killedPid });
    assert.equal(killed.delivered, true);
    trace.events.push({ at: killAt, type: "owner-sigkill", pid: killedPid });
    await first.child.waitForExit(20_000);
    await first.child.close();
    trace.events.push({ at: new Date().toISOString(), type: "first-wrapper-exit-observed", pid: first.child.pid, code: first.child.exit.code, signal: first.child.exit.signal });
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
    await stopPty(first?.child);
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
