import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const api = await import("../src/session-owner/index.ts").catch(() => ({}));
const registry = await import("../src/session-owner/registry.ts");
import { loadPiTestRuntime } from './helpers/pi-runtime.mjs';
const {codingAgent:{createAgentSession,DefaultResourceLoader,SessionManager}}=await loadPiTestRuntime(import.meta.url);

// 本文件的 ctx 身份一律来自真实 public SessionManager（数据来源门禁类别 2：修 fixture，不加 production fallback），
// 目标文件一律是真实临时目录中自生成的合法 Pi header；不使用 /sessions/... 这类手拼缺文件路径。
const repoCwd = await realpath(process.cwd());
const OWNER = "owner-extension-0123456789abcdef";
const OTHER = "owner-other-extension-0123456789";
const STARTED_AT = "2026-09-08T00:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MARKER = "BODY_MUST_NOT_BE_READ";
const NOTICE = {
  owned: "该会话正由另一个 Pi 窗口使用，已取消切换",
  target: "无法验证目标会话身份，已取消本次切换",
  source: "无法验证当前会话身份，已取消本次操作",
  transitioning: "当前会话存在未完成的切换，已取消本次操作；请重试同一目标或退出后重新启动",
  registry: "会话归属登记不可用，已取消本次操作",
  unsupported: "收到不受支持的会话事件，已按保守策略取消本次操作",
  internal: "会话归属保护出现内部异常，已按保守策略取消本次操作",
};

function runner() {
  const handlers = new Map();
  const errors = [];
  return {
    handlers,
    errors,
    on(type, handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
    // 复刻 dist/core/extensions/runner.js:807-840：按注册顺序快照、逐个 await；
    // before handler 返回 cancel 立即停止后续 handler；throw 只报告并继续，throw 不取消。
    async emit(type, event, ctx) {
      for (const handler of [...(handlers.get(type) ?? [])]) {
        let result;
        try { result = await handler(event, ctx); }
        catch (error) { errors.push(error); continue; }
        if (result?.cancel === true) return { cancelled: true };
      }
      return { cancelled: false };
    },
  };
}

function harness() { return { notices: [], shutdowns: 0 }; }

function sessionContext(manager, h) {
  return {
    cwd: manager.getCwd(),
    hasUI: true,
    ui: { notify(message, level) { h.notices.push({ message, level }); } },
    sessionManager: manager,
    async shutdown() { h.shutdowns += 1; },
  };
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "session-owner-extension-")));
  const root = join(base, "registry");
  const sessions = join(base, "sessions");
  const otherCwd = join(base, "other-cwd");
  const otherSessions = join(base, "other-sessions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(otherCwd, { recursive: true, mode: 0o755 });
  await mkdir(otherSessions, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, otherCwd, sessions, otherSessions, store: { root, guardTimeoutMs: 150 } };
}

// 真实 SessionManager 生成会话文件与身份：header 由 Pi 自己写入，file/id/cwd 都是运行期会公开的值。
function createSession(cwd, sessionDir, text) {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({ role: "user", content: text, timestamp: new Date().toISOString() });
  const file = manager.getSessionFile();
  assert.ok(file, "real SessionManager must expose its session file");
  return { manager, file, id: manager.getSessionId(), cwd: manager.getCwd(), identity: { cwd: manager.getCwd(), sessionId: manager.getSessionId(), sessionFile: file } };
}

async function launch(f, ownerId, reservation, pid = process.pid) {
  const result = await registry.prepareLaunch({ store: f.store, pid, ownerId, startedAt: STARTED_AT, reservation });
  assert.equal(result.decision, "allow", JSON.stringify(result));
  return result;
}

function install(f, { ownerId = OWNER, env, deps = {} } = {}) {
  const pi = runner();
  api.installSessionOwnerExtension(pi, {
    env: env ?? { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: f.root },
    store: f.store, ...deps,
  });
  return pi;
}

const start = (pi, event, ctx) => pi.handlers.get("session_start")[0](event, ctx);
const beforeSwitch = (pi, event, ctx) => pi.handlers.get("session_before_switch")[0](event, ctx);
const beforeFork = (pi, event, ctx) => pi.handlers.get("session_before_fork")[0](event, ctx);
const shutdown = (pi, event, ctx) => pi.handlers.get("session_shutdown")[0](event, ctx);

async function recordOf(f, ownerId = OWNER) {
  const record = (await registry.listLiveRecords(f.store)).find((value) => value.ownerId === ownerId);
  assert.ok(record, `missing record for ${ownerId}`);
  return record;
}

const identityOf = (record) => ({ cwd: record.cwd, sessionId: record.sessionId, sessionFile: record.sessionFile });

// 启动一个已经 active 的 owner，并返回其 extension runner / ctx / harness。
async function activeOwner(f, source, { ownerId = OWNER, deps = {} } = {}) {
  await launch(f, ownerId, { kind: "new" });
  const pi = install(f, { ownerId, deps });
  const h = harness();
  const ctx = sessionContext(source.manager, h);
  assert.equal(await start(pi, { reason: "startup" }, ctx), undefined);
  assert.equal((await recordOf(f, ownerId)).state, "active");
  return { pi, h, ctx };
}

test("loads an installable lifecycle extension candidate", () => {
  assert.equal(typeof api.installSessionOwnerExtension, "function");
  assert.equal(typeof api.createSessionOwnerLifecycle, "function");
});

test("child markers and hosts without wrapper ownership install no hooks", () => {
  const pi = runner();
  api.installSessionOwnerExtension(pi, { env: { PI_SUBAGENT_CHILD: "1" } });
  assert.equal(pi.handlers.size, 0);
  api.installSessionOwnerExtension(pi, { env: {} });
  assert.equal(pi.handlers.size, 0);
});

test("startup 用真实 SessionManager 身份原子提交，reload 保留 owner，quit 只释放自身", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "startup fixture");
  await launch(f, OWNER, { kind: "new" });
  const pi = install(f);
  const h = harness();
  const ctx = sessionContext(source.manager, h);
  try {
    assert.equal(await start(pi, { reason: "startup" }, ctx), undefined);
    assert.deepEqual(await registry.listLiveRecords(f.store), [
      {
        protocol: "pi-session-owner.v1", ownerId: OWNER, pid: process.pid, cwd: repoCwd,
        sessionId: source.id, sessionFile: source.file, state: "active", pendingSessionFile: null,
        forkSource: null, switchReservation: null, startedAt: STARTED_AT,
      },
    ]);
    // reload：旧 ctx 先失效，但 owner 记录仍由本进程持有，不释放、不清 pending、不改 source。
    assert.equal(await shutdown(pi, { reason: "reload" }, ctx), undefined);
    assert.equal((await recordOf(f)).state, "active");
    assert.equal(await start(pi, { reason: "reload" }, ctx), undefined);
    assert.equal((await recordOf(f)).state, "active");
    assert.deepEqual(identityOf(await recordOf(f)), source.identity);
    // 另一个 owner 的记录不因本进程 quit 被释放。
    const other = createSession(f.otherCwd, f.otherSessions, "other owner session");
    await launch(f, OTHER, { kind: "session", cwd: f.otherCwd, sessionFile: other.file, sessionId: other.id });
    assert.equal(await shutdown(pi, { reason: "quit" }, ctx), undefined);
    assert.deepEqual((await registry.listLiveRecords(f.store)).map((record) => record.ownerId), [OTHER]);
    assert.deepEqual(h.notices, []);
    assert.equal(h.shutdowns, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("quit 只释放自身，即使旧 ctx 身份已不可读", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "quit identity failure");
  const other = createSession(f.otherCwd, f.otherSessions, "other owner session");
  await launch(f, OWNER, { kind: "new" });
  await launch(f, OTHER, { kind: "session", cwd: f.otherCwd, sessionFile: other.file, sessionId: other.id });
  const pi = install(f);
  const h = harness();
  const ctx = sessionContext(source.manager, h);
  try {
    assert.equal(await start(pi, { reason: "startup" }, ctx), undefined);
    const broken = {
      ...ctx,
      sessionManager: { getCwd() { throw new Error("session manager already disposed"); }, getSessionId: () => null, getSessionFile: () => null },
    };
    assert.equal(await shutdown(pi, { reason: "quit" }, broken), undefined);
    assert.deepEqual((await registry.listLiveRecords(f.store)).map((record) => record.ownerId), [OTHER]);
    assert.deepEqual(h.notices, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("resume 事务：before 在 open 之前有界 reserve，shutdown 保留 source+pending，session_start 同 guard commit", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "resume source");
  const target = createSession(repoCwd, f.sessions, "resume target");
  await writeFile(target.file, `${await readFile(target.file, "utf8")}${BODY_MARKER.repeat(4000)}\n`);
  const reads = [];
  const aborts = [];
  const opened = [];
  const { pi, h, ctx } = await activeOwner(f, source, {
    deps: {
      readHeaderBytes(path) {
        const bytes = api.readSessionHeaderBytes(path);
        reads.push({ path, length: bytes.length, sawBody: bytes.includes(Buffer.from(BODY_MARKER)) });
        return bytes;
      },
      async abortSwitchTarget(input) { aborts.push(input); return registry.abortSwitchTarget(input); },
    },
  });
  try {
    const event = { reason: "resume", targetSessionFile: target.file };
    const pristine = structuredClone(event);
    assert.equal(await beforeSwitch(pi, event, ctx), undefined);
    assert.deepEqual(event, pristine, "raw event 不得被改写");
    // reserve 必须发生在任何 SessionManager.open 之前，并且只读有界首行。
    assert.deepEqual(opened, []);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].path, target.file);
    assert.equal(reads[0].sawBody, false);
    assert.ok(reads[0].length <= api.MAX_SESSION_HEADER_BYTES);
    const reserved = await recordOf(f);
    const reservationId = reserved.switchReservation.reservationId;
    assert.equal(reserved.state, "active");
    assert.deepEqual(identityOf(reserved), source.identity, "reserve 后顶层身份必须仍是 source");
    assert.equal(reserved.pendingSessionFile, target.file);
    assert.match(reservationId, UUID);
    assert.deepEqual(reserved.switchReservation, { reservationId, source: source.identity, target: target.identity, phase: "reserved" });

    // 运行期在 before 之后才 open 目标，并把新 manager 的文件作为 shutdown destination。
    const openedManager = SessionManager.open(target.file);
    opened.push(openedManager);
    assert.deepEqual(
      { cwd: openedManager.getCwd(), sessionId: openedManager.getSessionId(), sessionFile: openedManager.getSessionFile() },
      target.identity,
    );
    assert.equal(await shutdown(pi, { reason: "resume", targetSessionFile: openedManager.getSessionFile() }, ctx), undefined);
    const transitional = await recordOf(f);
    assert.equal(transitional.state, "transitioning");
    assert.deepEqual(identityOf(transitional), source.identity, "transitioning 期间仍保留 source");
    assert.equal(transitional.pendingSessionFile, target.file);
    assert.deepEqual(transitional.switchReservation, { reservationId, source: source.identity, target: target.identity, phase: "reserved" });

    // 新 extension 只用持久 receipt 重建 plain token：session_start 事件本身不携带 nonce。
    const targetCtx = sessionContext(openedManager, h);
    assert.equal(await start(pi, { reason: "resume", previousSessionFile: source.manager.getSessionFile() }, targetCtx), undefined);
    const committed = await recordOf(f);
    assert.equal(committed.state, "active");
    assert.deepEqual(identityOf(committed), target.identity);
    assert.equal(committed.pendingSessionFile, null);
    assert.equal(committed.forkSource, null);
    assert.deepEqual(committed.switchReservation, { reservationId, source: source.identity, target: target.identity, phase: "committed" });
    assert.deepEqual(aborts, [], "没有公开结果 hook，不得自动 abort");
    assert.deepEqual(h.notices, []);
    assert.equal(h.shutdowns, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("更早 handler 取消时不产生 reservation，更晚 handler 取消时保留 source+pending 且不自动 abort", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "early cancel source");
  const target = createSession(repoCwd, f.sessions, "early cancel target");
  const aborts = [];
  await launch(f, OWNER, { kind: "new" });
  const early = runner();
  early.on("session_before_switch", async () => ({ cancel: true }));
  api.installSessionOwnerExtension(early, {
    env: { PI_SESSION_OWNER_ID: OWNER, PI_SESSION_OWNER_REGISTRY: f.root }, store: f.store,
    async abortSwitchTarget(input) { aborts.push(input); return registry.abortSwitchTarget(input); },
  });
  const h = harness();
  const ctx = sessionContext(source.manager, h);
  try {
    assert.equal(await start(early, { reason: "startup" }, ctx), undefined);
    // 更早的 before handler 取消：runner 立即停止，owner handler 根本没执行。
    assert.deepEqual(await early.emit("session_before_switch", { reason: "resume", targetSessionFile: target.file }, ctx), { cancelled: true });
    let record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.equal(record.pendingSessionFile, null);
    assert.equal(record.switchReservation, null, "startup commit 之后 receipt 为 null，且不得新增 live reservation");
    assert.deepEqual(identityOf(record), source.identity);

    // 更晚的 handler 取消：owner 已经 reserve，SDK 没有结果 hook，因此保留 active source + pending target。
    const late = runner();
    api.installSessionOwnerExtension(late, {
      env: { PI_SESSION_OWNER_ID: OWNER, PI_SESSION_OWNER_REGISTRY: f.root }, store: f.store,
      async abortSwitchTarget(input) { aborts.push(input); return registry.abortSwitchTarget(input); },
    });
    late.on("session_before_switch", async () => ({ cancel: true }));
    assert.deepEqual(await late.emit("session_before_switch", { reason: "resume", targetSessionFile: target.file }, ctx), { cancelled: true });
    record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.deepEqual(identityOf(record), source.identity, "旧 source 不得被释放");
    assert.equal(record.pendingSessionFile, target.file);
    assert.equal(record.switchReservation.phase, "reserved");
    assert.deepEqual(aborts, [], "晚 cancel 不得触发自动 rollback");
    assert.deepEqual(h.notices, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("before handler throw 不取消切换，且 owner reservation 保守保留", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "throwing handler source");
  const target = createSession(repoCwd, f.sessions, "throwing handler target");
  await launch(f, OWNER, { kind: "new" });
  const pi = runner();
  api.installSessionOwnerExtension(pi, { env: { PI_SESSION_OWNER_ID: OWNER, PI_SESSION_OWNER_REGISTRY: f.root }, store: f.store });
  pi.on("session_before_switch", async () => { throw new Error("later handler exploded"); });
  const h = harness();
  const ctx = sessionContext(source.manager, h);
  try {
    assert.equal(await start(pi, { reason: "startup" }, ctx), undefined);
    assert.deepEqual(await pi.emit("session_before_switch", { reason: "resume", targetSessionFile: target.file }, ctx), { cancelled: false });
    assert.equal(pi.errors.length, 1);
    const record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.equal(record.pendingSessionFile, target.file);
    assert.equal(record.switchReservation.phase, "reserved");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("open 失败保留 active source+pending，create/bind 失败保留 transitioning+pending，均不伪造 rollback", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "failure source");
  const target = createSession(repoCwd, f.sessions, "failure target");
  const aborts = [];
  const { pi, h, ctx } = await activeOwner(f, source, {
    deps: { async abortSwitchTarget(input) { aborts.push(input); return registry.abortSwitchTarget(input); } },
  });
  try {
    // SessionManager.open / cwd 校验失败：没有 session_shutdown，也没有 session_start。
    assert.equal(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    let record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.deepEqual(identityOf(record), source.identity);
    assert.equal(record.pendingSessionFile, target.file);
    assert.equal(record.switchReservation.phase, "reserved");

    // teardown 之后 createRuntime/rebind/bindExtensions 失败：记录停在 transitioning + pending。
    assert.equal(await shutdown(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    record = await recordOf(f);
    assert.equal(record.state, "transitioning");
    assert.deepEqual(identityOf(record), source.identity);
    assert.equal(record.pendingSessionFile, target.file);
    assert.equal(record.switchReservation.phase, "reserved");
    assert.deepEqual(aborts, []);
    assert.deepEqual(h.notices, []);
    assert.equal(h.shutdowns, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("commit 被拒（cwdOverride 身份不匹配）时请求有序 shutdown，不靠 session_start return cancel 伪称取消", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "override source");
  const target = createSession(repoCwd, f.sessions, "override target");
  const { pi, h, ctx } = await activeOwner(f, source);
  try {
    assert.equal(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    const reservationId = (await recordOf(f)).switchReservation.reservationId;
    assert.equal(await shutdown(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    // 合法 cwdOverride 让真实 ctx 的 cwd 与保留 target 不同：commit 必须 mismatch fail closed。
    const overridden = SessionManager.open(target.file, undefined, f.otherCwd);
    assert.equal(overridden.getCwd(), f.otherCwd);
    assert.deepEqual(await start(pi, { reason: "resume", previousSessionFile: source.manager.getSessionFile() }, sessionContext(overridden, h)), { cancel: true });
    assert.equal(h.shutdowns, 1, "必须请求有序 shutdown，而不是假装取消了全局初始化");
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.transitioning]);
    const record = await recordOf(f);
    assert.equal(record.state, "transitioning");
    assert.deepEqual(identityOf(record), source.identity, "不得清 source");
    assert.equal(record.pendingSessionFile, target.file);
    assert.deepEqual(record.switchReservation, { reservationId, source: source.identity, target: target.identity, phase: "reserved" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("reload 只验证 source，并保留 pending 与 live reservation", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "reload source");
  const target = createSession(repoCwd, f.sessions, "reload target");
  const { pi, h, ctx } = await activeOwner(f, source);
  try {
    assert.equal(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    const reservation = (await recordOf(f)).switchReservation;
    assert.equal(await shutdown(pi, { reason: "reload" }, ctx), undefined);
    assert.equal(await start(pi, { reason: "reload" }, ctx), undefined);
    const record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.deepEqual(identityOf(record), source.identity);
    assert.equal(record.pendingSessionFile, target.file);
    assert.deepEqual(record.switchReservation, reservation);
    assert.deepEqual(h.notices, []);
    assert.equal(h.shutdowns, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("new：before 不 claim 目标，shutdown 保留真实 source，新身份由 session_start 后置提交", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "new source");
  const { pi, h, ctx } = await activeOwner(f, source);
  try {
    const event = { reason: "new" };
    const pristine = structuredClone(event);
    assert.equal(await beforeSwitch(pi, event, ctx), undefined);
    assert.deepEqual(event, pristine);
    let record = await recordOf(f);
    assert.equal(record.pendingSessionFile, null, "new 的 before 阶段没有目标身份，不得预先 claim");
    assert.equal(record.switchReservation, null, "startup commit 之后 receipt 为 null，且不得新增 live reservation");

    const replacement = SessionManager.create(repoCwd, f.sessions);
    const replacementIdentity = { cwd: replacement.getCwd(), sessionId: replacement.getSessionId(), sessionFile: replacement.getSessionFile() };
    assert.notEqual(replacementIdentity.sessionId, source.id);
    assert.equal(await shutdown(pi, { reason: "new", targetSessionFile: replacement.getSessionFile() }, ctx), undefined);
    record = await recordOf(f);
    assert.equal(record.state, "transitioning");
    assert.deepEqual(identityOf(record), source.identity, "shutdown 只保留真实 source");
    assert.equal(record.pendingSessionFile, null);

    assert.equal(await start(pi, { reason: "new", previousSessionFile: source.manager.getSessionFile() }, sessionContext(replacement, h)), undefined);
    record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.deepEqual(identityOf(record), replacementIdentity);
    assert.equal(record.switchReservation, null);
    assert.deepEqual(h.notices, []);
    assert.equal(h.shutdowns, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("fork：before_fork 只核验 source，新 ID 由 session_start 后置提交", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "fork source");
  const { pi, h, ctx } = await activeOwner(f, source);
  try {
    const event = { entryId: "entry", position: "at" };
    const pristine = structuredClone(event);
    assert.equal(await beforeFork(pi, event, ctx), undefined);
    assert.deepEqual(event, pristine);
    let record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.equal(record.pendingSessionFile, null);
    assert.equal(record.switchReservation, null, "startup commit 之后 receipt 为 null，且不得新增 live reservation");

    const branched = SessionManager.create(repoCwd, f.sessions);
    const branchedIdentity = { cwd: branched.getCwd(), sessionId: branched.getSessionId(), sessionFile: branched.getSessionFile() };
    assert.equal(await shutdown(pi, { reason: "fork", targetSessionFile: branched.getSessionFile() }, ctx), undefined);
    record = await recordOf(f);
    assert.equal(record.state, "transitioning");
    assert.deepEqual(identityOf(record), source.identity);
    assert.equal(await start(pi, { reason: "fork", previousSessionFile: source.manager.getSessionFile() }, sessionContext(branched, h)), undefined);
    record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.deepEqual(identityOf(record), branchedIdentity);
    assert.equal(record.switchReservation, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("外部 import 的 destination 尚无 header：显式 cancel 并按 blocked-upstream 记录，不误称别人占用", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "import source");
  const { pi, h, ctx } = await activeOwner(f, source);
  // 类别 2 fixture：复现上游 importFromJsonl 的真实形状——before 事件只给 destination 路径，
  // 此时 copy 尚未发生，输入路径/header/ID 都没有公开给 extension。不是手工伪造的 record 数据。
  const destination = join(f.sessions, "external-import.jsonl");
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.map((value) => (value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value))).join(" ")); };
  try {
    assert.deepEqual(await beforeSwitch(pi, { reason: "resume", targetSessionFile: destination }, ctx), { cancel: true });
    const record = await recordOf(f);
    assert.equal(record.state, "active");
    assert.deepEqual(identityOf(record), source.identity, "旧 source 不得被释放");
    assert.equal(record.pendingSessionFile, null);
    assert.equal(record.switchReservation, null, "startup commit 之后 receipt 为 null，且不得新增 live reservation");
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.target]);
    assert.ok(!h.notices.some((notice) => notice.message.includes("另一个 Pi 窗口")));
    assert.ok(logs.some((line) => line.includes("blocked-upstream")), logs.join("\n"));
  } finally {
    console.error = original;
    await rm(f.root, { recursive: true, force: true });
  }
});

test("目标 header 不可验证的全部形状都 cancel，且不 reserve、不 open", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "unverifiable source");
  const reads = [];
  const { pi, ctx } = await activeOwner(f, source, {
    deps: { readHeaderBytes(path) { const bytes = api.readSessionHeaderBytes(path); reads.push(path); return bytes; } },
  });
  const cases = [];
  const write = async (name, content) => { const path = join(f.sessions, name); await writeFile(path, content); return path; };
  try {
    cases.push(["empty", await write("empty.jsonl", "")]);
    cases.push(["malformed", await write("malformed.jsonl", "not json\n")]);
    cases.push(["wrong-type", await write("wrong-type.jsonl", `${JSON.stringify({ type: "message", id: "x", cwd: repoCwd })}\n`)]);
    cases.push(["missing-id", await write("missing-id.jsonl", `${JSON.stringify({ type: "session", cwd: repoCwd })}\n`)]);
    cases.push(["empty-id", await write("empty-id.jsonl", `${JSON.stringify({ type: "session", id: "", cwd: repoCwd })}\n`)]);
    cases.push(["missing-cwd", await write("missing-cwd.jsonl", `${JSON.stringify({ type: "session", id: "x" })}\n`)]);
    cases.push(["unknown-cwd", await write("unknown-cwd.jsonl", `${JSON.stringify({ type: "session", id: "x", cwd: join(f.base, "missing-cwd") })}\n`)]);
    cases.push(["oversize", await write("oversize.jsonl", "x".repeat(api.MAX_SESSION_HEADER_BYTES))]);
    cases.push(["directory", f.otherCwd]);
    cases.push(["missing", join(f.sessions, "does-not-exist.jsonl")]);
    cases.push(["missing-relative", "does-not-exist-relative.jsonl"]);
    cases.push(["empty-string", ""]);
    for (const [label, target] of cases) {
      const h = harness();
      const result = await beforeSwitch(pi, { reason: "resume", targetSessionFile: target }, { ...ctx, ui: { notify(message, level) { h.notices.push({ message, level }); } } });
      assert.deepEqual(result, { cancel: true }, `${label} must cancel`);
      assert.equal(result.cancel, true);
      assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.target], `${label} must report an unverifiable target`);
      const record = await recordOf(f);
      assert.equal(record.state, "active", `${label} must not transition`);
      assert.equal(record.pendingSessionFile, null, `${label} must not reserve`);
      assert.equal(record.switchReservation, null, `${label} must not create a reservation`);
    }
    // 目录与不存在的路径不得进入 header 读取；读取只发生在既存 regular file 上。
    assert.ok(reads.every((path) => !path.endsWith("does-not-exist.jsonl")));
    assert.ok(!reads.includes(f.otherCwd));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("合法 header 变体：CRLF、无 LF 短首行、跨 cwd、file:// URL 都能 reserve 出精确目标身份", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "variant source");
  const { pi, ctx } = await activeOwner(f, source);
  const header = (id, cwd) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-13T00:00:00.000Z", cwd });
  const write = async (name, content) => { const path = join(f.sessions, name); await writeFile(path, content); return path; };
  try {
    const crlf = await write("crlf.jsonl", `${header("crlf-id", repoCwd)}\r\n`);
    const noLf = await write("no-lf.jsonl", header("no-lf-id", repoCwd));
    const crossCwd = await write("cross-cwd.jsonl", `${header("cross-cwd-id", f.otherCwd)}\n`);
    const expected = [
      [crlf, { cwd: repoCwd, sessionId: "crlf-id", sessionFile: crlf }],
      [noLf, { cwd: repoCwd, sessionId: "no-lf-id", sessionFile: noLf }],
      [crossCwd, { cwd: f.otherCwd, sessionId: "cross-cwd-id", sessionFile: crossCwd }],
      [pathToFileURL(crlf).href, { cwd: repoCwd, sessionId: "crlf-id", sessionFile: crlf }],
    ];
    for (const [requested, target] of expected) {
      // 每次 reserve 前先清掉上一条 pending：用同一 target 的幂等重入无法覆盖不同目标。
      const record = await recordOf(f);
      if (record.switchReservation?.phase === "reserved") {
        await registry.abortSwitchTarget({
          store: f.store, ownerId: OWNER, pid: process.pid,
          source: source.identity, target: record.switchReservation.target, reservationId: record.switchReservation.reservationId,
        });
      }
      assert.equal(await beforeSwitch(pi, { reason: "resume", targetSessionFile: requested }, ctx), undefined, `${requested} must be allowed`);
      const reserved = await recordOf(f);
      assert.deepEqual(reserved.switchReservation.target, target);
      assert.equal(reserved.pendingSessionFile, target.sessionFile);
      assert.deepEqual(identityOf(reserved), source.identity);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("同 owner 同 target 重试返回同一 nonce，pending 存在时改选另一 target 被拒", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "retry source");
  const target = createSession(repoCwd, f.sessions, "retry target");
  const other = createSession(repoCwd, f.sessions, "retry other target");
  const { pi, h, ctx } = await activeOwner(f, source);
  try {
    assert.equal(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    const first = (await recordOf(f)).switchReservation;
    assert.equal(first.phase, "reserved");
    // 同 source+target 重试：原 nonce 幂等返回，不产生重复 claim。
    assert.equal(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    const repeated = await recordOf(f);
    assert.deepEqual(repeated.switchReservation, first);
    assert.equal(repeated.pendingSessionFile, target.file);
    // 改选另一 target：拒绝，且原 pending 保留。
    assert.deepEqual(await beforeSwitch(pi, { reason: "resume", targetSessionFile: other.file }, ctx), { cancel: true });
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.transitioning]);
    assert.equal((await recordOf(f)).pendingSessionFile, target.file);
    // pending 存在时 new/fork 同样被拒。
    assert.deepEqual(await beforeSwitch(pi, { reason: "new" }, ctx), { cancel: true });
    assert.deepEqual(await beforeFork(pi, { entryId: "entry", position: "before" }, ctx), { cancel: true });
    const unchanged = await recordOf(f);
    assert.equal(unchanged.state, "active");
    assert.deepEqual(identityOf(unchanged), source.identity);
    assert.deepEqual(unchanged.switchReservation, first);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("另一 owner 占用目标或复用同一 PID 时取消，且不覆盖对方 record", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "conflict source");
  const target = createSession(repoCwd, f.sessions, "conflict target");
  const { pi, h, ctx } = await activeOwner(f, source);
  try {
    // 另一 owner 复用同一 PID（例如 PID 回收）仍必须是冲突方。
    await launch(f, OTHER, { kind: "session", cwd: repoCwd, sessionFile: target.file, sessionId: target.id }, process.pid);
    const foreign = await recordOf(f, OTHER);
    assert.deepEqual(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, ctx), { cancel: true });
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.owned]);
    const own = await recordOf(f);
    assert.equal(own.state, "active");
    assert.deepEqual(identityOf(own), source.identity, "冲突取消时旧 source 不动");
    assert.equal(own.pendingSessionFile, null);
    assert.equal(own.switchReservation, null);
    assert.deepEqual(await recordOf(f, OTHER), foreign, "不得覆盖另一 owner 的 record");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup 身份不匹配时保留 pending，不替换为事务 receipt", async (t) => {
  const f = await fixture(t);
  const pinned = createSession(repoCwd, f.sessions, "pinned startup target");
  const actual = createSession(repoCwd, f.sessions, "actual startup session");
  await launch(f, OWNER, { kind: "session", cwd: repoCwd, sessionFile: pinned.file, sessionId: pinned.id });
  const pi = install(f);
  const h = harness();
  try {
    assert.deepEqual(await start(pi, { reason: "startup" }, sessionContext(actual.manager, h)), { cancel: true });
    assert.equal(h.shutdowns, 1);
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.transitioning]);
    const record = await recordOf(f);
    assert.equal(record.state, "pending");
    assert.equal(record.pendingSessionFile, pinned.file);
    assert.equal(record.switchReservation, undefined);
    // fork-source reservation 仍接受 Pi 的新目的地，但不接受它的 source。
    assert.equal(await start(pi, { reason: "startup" }, sessionContext(pinned.manager, harness())), undefined);
    assert.equal((await recordOf(f)).state, "active");
    assert.deepEqual(identityOf(await recordOf(f)), pinned.identity);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("fork-source reservation accepts Pi's new destination but not its source", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "fork-source reservation source");
  const destination = createSession(repoCwd, f.sessions, "fork-source reservation destination");
  await launch(f, OWNER, { kind: "fork-source", cwd: repoCwd, source: { cwd: repoCwd, sessionFile: source.file, sessionId: source.id } });
  const pi = install(f);
  const h = harness();
  try {
    // fork-source reservation 只接受 Pi 的新目的地；把 source 自己当目的地必须 fail closed。
    assert.deepEqual(await start(pi, { reason: "startup" }, sessionContext(source.manager, h)), { cancel: true });
    assert.equal(h.shutdowns, 1);
    assert.deepEqual(await registry.listLiveRecords(f.store), [
      {
        protocol: "pi-session-owner.v1", ownerId: OWNER, pid: process.pid, cwd: repoCwd, sessionId: null,
        sessionFile: null, state: "pending", pendingSessionFile: null,
        forkSource: { cwd: repoCwd, sessionFile: source.file, sessionId: source.id }, startedAt: STARTED_AT,
      },
    ]);
    const second = harness();
    assert.equal(await start(pi, { reason: "startup" }, sessionContext(destination.manager, second)), undefined);
    assert.equal(second.shutdowns, 0);
    assert.deepEqual(await registry.listLiveRecords(f.store), [
      {
        protocol: "pi-session-owner.v1", ownerId: OWNER, pid: process.pid, cwd: repoCwd,
        sessionId: destination.id, sessionFile: destination.file, state: "active",
        pendingSessionFile: null, forkSource: null, switchReservation: null, startedAt: STARTED_AT,
      },
    ]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("未知事件与不可读身份 fail closed，通知分类互不混淆", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "unknown event source");
  const target = createSession(repoCwd, f.sessions, "unknown event target");
  const { pi, ctx } = await activeOwner(f, source);
  try {
    const unknown = harness();
    assert.deepEqual(await beforeSwitch(pi, { reason: "branch" }, ctx), { cancel: true });
    assert.deepEqual(await beforeSwitch(pi, { reason: "resume" }, ctx), { cancel: true }, "resume 缺目标必须拒绝");
    assert.equal((await recordOf(f)).switchReservation, null);

    const broken = {
      ...ctx,
      sessionManager: { getCwd() { throw new Error("session manager unavailable"); }, getSessionId: () => null, getSessionFile: () => null },
      ui: { notify(message, level) { unknown.notices.push({ message, level }); } },
    };
    assert.deepEqual(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, broken), { cancel: true });
    assert.deepEqual(unknown.notices.map((notice) => notice.message), [NOTICE.source]);
    assert.equal((await recordOf(f)).switchReservation, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("registry 故障与事务 API 异常都 fail closed，且不误称另一窗口占用", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "registry failure source");
  const target = createSession(repoCwd, f.sessions, "registry failure target");
  const { ctx: activated } = await activeOwner(f, source);
  assert.equal(activated.hasUI, true);
  const unreadable = install(f, { deps: { async listLiveRecords() { throw new Error("registry unavailable"); } } });
  const exploding = install(f, { deps: { async reserveSwitchTarget() { throw new Error("reserve exploded"); } } });
  const h = harness();
  const ctx = sessionContext(source.manager, h);
  try {
    assert.deepEqual(await beforeSwitch(unreadable, { reason: "resume", targetSessionFile: target.file }, ctx), { cancel: true });
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.registry]);
    // reserve 自身抛异常不是 SessionOwnerTransitionError：仍必须显式 cancel，但分类为内部异常。
    assert.deepEqual(await beforeSwitch(exploding, { reason: "resume", targetSessionFile: target.file }, ctx), { cancel: true });
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.registry, NOTICE.internal]);
    assert.deepEqual(await start(unreadable, { reason: "resume", previousSessionFile: source.manager.getSessionFile() }, ctx), { cancel: true });
    assert.equal(h.shutdowns, 1);
    const record = await recordOf(f);
    assert.equal(record.state, "active", "registry 故障不得改写记录");
    assert.deepEqual(identityOf(record), source.identity);
    assert.equal(record.pendingSessionFile, null);
    assert.equal(record.switchReservation, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("显式 abortReservedTarget 只在隔离调用下清 pending，事件路径从不自动触发", async (t) => {
  const f = await fixture(t);
  const source = createSession(repoCwd, f.sessions, "abort source");
  const target = createSession(repoCwd, f.sessions, "abort target");
  const aborts = [];
  const spy = async (input) => { aborts.push(input); return registry.abortSwitchTarget(input); };
  const { pi, ctx } = await activeOwner(f, source, { deps: { abortSwitchTarget: spy } });
  // 隔离调用方：只有明确知道 teardown 尚未发生时才能用，没有任何事件路径会自动调它。
  const lifecycle = api.createSessionOwnerLifecycle({ store: f.store, ownerId: OWNER, pid: process.pid, abortSwitchTarget: spy });
  try {
    assert.equal(await beforeSwitch(pi, { reason: "resume", targetSessionFile: target.file }, ctx), undefined);
    const reserved = await recordOf(f);
    assert.equal(reserved.switchReservation.phase, "reserved");
    assert.deepEqual(aborts, [], "reserve 之后不得自动 abort");
    await lifecycle.abortReservedTarget(source.identity);
    assert.equal(aborts.length, 1);
    const aborted = await recordOf(f);
    assert.equal(aborted.state, "active");
    assert.deepEqual(identityOf(aborted), source.identity, "abort 不动 source");
    assert.equal(aborted.pendingSessionFile, null);
    assert.equal(aborted.switchReservation.phase, "aborted");
    assert.equal(aborted.switchReservation.reservationId, reserved.switchReservation.reservationId);
    // aborted receipt 不是可用的 resume token：后续 session_start 必须 stale-reservation fail closed。
    const h = harness();
    assert.deepEqual(await start(pi, { reason: "resume", previousSessionFile: source.manager.getSessionFile() }, sessionContext(source.manager, h)), { cancel: true });
    assert.equal(h.shutdowns, 1);
    assert.deepEqual(h.notices.map((notice) => notice.message), [NOTICE.transitioning]);
    assert.deepEqual(identityOf(await recordOf(f)), source.identity);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("real Pi ExtensionRunner commits startup and preserves ownership through reload", async (t) => {
  const root = await temporaryRegistry();
  const agentDir = await mkdtemp(join(tmpdir(), "session-owner-extension-agent-"));
  const ownerId = "owner-runtime-extension-0123456789";
  const store = { root, guardTimeoutMs: 150 };
  let result;
  try {
    await registry.prepareLaunch({ store, pid: process.pid, ownerId, startedAt: STARTED_AT, reservation: { kind: "new" } });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir,
      extensionFactories: [(pi) => api.installSessionOwnerExtension(pi, {
        env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store,
      })],
    });
    await loader.reload();
    result = await createAgentSession({ cwd: process.cwd(), agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()) });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error.error; } });
    const [active] = await registry.listLiveRecords(store);
    assert.equal(active.state, "active");
    assert.equal(active.switchReservation, null);
    await result.session.reload();
    const [reloaded] = await registry.listLiveRecords(store);
    assert.equal(reloaded.state, "active");
    assert.deepEqual(identityOf(reloaded), identityOf(active), "reload 不改变 owner 身份");
  } finally {
    if (result) {
      await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      result.session.dispose();
    }
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await assert.rejects(lstat(join(process.cwd(), "auth.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(process.cwd(), "models-store.json")), { code: "ENOENT" });
  }
});

test("real Pi ExtensionRunner reload normalizes a legacy v1 active record without shutdown", async (t) => {
  const root = await temporaryRegistry();
  const agentDir = await mkdtemp(join(tmpdir(), "session-owner-reload-agent-"));
  const ownerId = "owner-legacy-reload-0123456789";
  const store = { root, guardTimeoutMs: 150 };
  let result;
  try {
    await registry.prepareLaunch({ store, pid: process.pid, ownerId, startedAt: STARTED_AT, reservation: { kind: "new" } });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir,
      extensionFactories: [(pi) => api.installSessionOwnerExtension(pi, {
        env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store,
      })],
    });
    await loader.reload();
    result = await createAgentSession({ cwd: process.cwd(), agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()) });
    let shutdowns = 0;
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() { shutdowns += 1; }, onError(error) { throw error.error; } });
    const recordPath = join(root, `${ownerId}.json`);
    const legacy = JSON.parse(await readFile(recordPath, "utf8"));
    delete legacy.forkSource;
    delete legacy.switchReservation;
    await writeFile(recordPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    await chmod(recordPath, 0o600);

    await result.session.reload();

    const [record] = await registry.listLiveRecords(store);
    assert.equal(record.state, "active");
    assert.equal(record.forkSource, null);
    assert.equal(shutdowns, 0);
  } finally {
    result?.session.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("real Pi ExtensionRunner reload fails closed for malformed nonempty legacy forkSource", async (t) => {
  const root = await temporaryRegistry();
  const agentDir = await mkdtemp(join(tmpdir(), "session-owner-malformed-reload-agent-"));
  const ownerId = "owner-malformed-reload-012345";
  const store = { root, guardTimeoutMs: 150 };
  let result;
  try {
    await registry.prepareLaunch({ store, pid: process.pid, ownerId, startedAt: STARTED_AT, reservation: { kind: "new" } });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir,
      extensionFactories: [(pi) => api.installSessionOwnerExtension(pi, {
        env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store,
      })],
    });
    await loader.reload();
    result = await createAgentSession({ cwd: process.cwd(), agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()) });
    let shutdowns = 0;
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() { shutdowns += 1; }, onError(error) { throw error.error; } });
    const recordPath = join(root, `${ownerId}.json`);
    const malformed = JSON.parse(await readFile(recordPath, "utf8"));
    malformed.forkSource = { sessionFile: "/sessions/source.jsonl" };
    await writeFile(recordPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    await chmod(recordPath, 0o600);

    await result.session.reload();

    assert.equal(shutdowns, 1);
  } finally {
    result?.session.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

async function temporaryRegistry() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "session-owner-extension-registry-")));
  return root;
}
