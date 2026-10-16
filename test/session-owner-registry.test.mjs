import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const api = await import("../src/session-owner/registry.ts").catch(() => ({}));

function store(root, timeout = 150) {
  return { root, guardTimeoutMs: timeout };
}

function launch(root, ownerId, reservation, pid = process.pid) {
  return api.prepareLaunch({
    store: store(root),
    pid,
    ownerId,
    startedAt: "2026-09-08T00:00:00.000Z",
    reservation,
  });
}

async function temporaryStore() {
  return mkdtemp(join(tmpdir(), "session-owner-registry-"));
}

test("exports a loadable registry candidate", () => {
  assert.equal(typeof api.prepareLaunch, "function");
  assert.equal(typeof api.listLiveRecords, "function");
  assert.equal(typeof api.updateOwnRecord, "function");
  assert.equal(typeof api.releaseOwnRecord, "function");
});

test("publishes exact pending records before another owner can reuse their target", async () => {
  const root = await temporaryStore();
  try {
    const target = { kind: "session", cwd: process.cwd(), sessionFile: "/sessions/a.jsonl", sessionId: "a" };
    const first = await launch(root, "owner-a-0123456789abcdef", target);
    assert.equal(first.decision, "allow");
    assert.equal(first.record.state, "pending");
    assert.equal(first.record.cwd, await realpath(process.cwd()));
    assert.equal(first.record.pendingSessionFile, "/sessions/a.jsonl");
    const second = await launch(root, "owner-b-0123456789abcdef", target);
    assert.deepEqual(second, { decision: "blocked", reason: "session-owned", conflictingOwnerId: "owner-a-0123456789abcdef" });
    const different = await launch(root, "owner-c-0123456789abcdef", { ...target, sessionFile: "/sessions/b.jsonl", sessionId: "b" });
    assert.equal(different.decision, "allow");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selecting blocks all reuse while concurrent new reservations remain independent", async () => {
  const root = await temporaryStore();
  try {
    const selecting = await launch(root, "owner-a-0123456789abcdef", { kind: "selecting" });
    assert.equal(selecting.decision, "allow");
    const reuse = await launch(root, "owner-b-0123456789abcdef", { kind: "session-id", cwd: process.cwd(), sessionId: "x" });
    assert.deepEqual(reuse, { decision: "blocked", reason: "selector-active", conflictingOwnerId: "owner-a-0123456789abcdef" });
    const newA = await launch(root, "owner-c-0123456789abcdef", { kind: "new" });
    const newB = await launch(root, "owner-d-0123456789abcdef", { kind: "new" });
    assert.equal(newA.decision, "allow");
    assert.equal(newB.decision, "allow");
    assert.notEqual(newA.recordPath, newB.recordPath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a real child process holds its exact pending reservation before exec", async () => {
  const root = await temporaryStore();
  const ownerId = "owner-child-0123456789abcdef";
  const registryUrl = new URL("../src/session-owner/registry.ts", import.meta.url).href;
  const source = `import(${JSON.stringify(registryUrl)}).then(async (api) => {
    const result = await api.prepareLaunch({ store: { root: process.env.ROOT, guardTimeoutMs: 150 }, pid: process.pid, ownerId: process.env.OWNER, startedAt: new Date().toISOString(), reservation: { kind: 'session', cwd: process.cwd(), sessionFile: '/sessions/exact.jsonl', sessionId: 'exact' } });
    process.stdout.write(JSON.stringify(result) + '\\n'); setInterval(() => {}, 1000);
  });`;
  const child = spawn(process.execPath, ["-e", source], { env: { ...process.env, ROOT: root, OWNER: ownerId }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const line = await new Promise((resolve, reject) => {
      let value = "";
      child.stdout.on("data", (chunk) => { value += chunk; if (value.includes("\n")) resolve(value.trim()); });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`child exited before barrier: ${code}`)));
    });
    assert.equal(JSON.parse(line).decision, "allow");
    assert.deepEqual(await launch(root, "owner-parent-0123456789abcdef", { kind: "session", cwd: process.cwd(), sessionFile: "/sessions/exact.jsonl", sessionId: "exact" }), {
      decision: "blocked", reason: "session-owned", conflictingOwnerId: ownerId,
    });
    assert.equal((await launch(root, "owner-different-0123456789abcdef", { kind: "session", cwd: process.cwd(), sessionFile: "/sessions/different.jsonl", sessionId: "different" })).decision, "allow");
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("uses private regular files, removes only ESRCH records, and prevents old owners releasing successors", async () => {
  const root = await temporaryStore();
  try {
    const first = await launch(root, "owner-a-0123456789abcdef", { kind: "new" });
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(first.recordPath)).mode & 0o777, 0o600);
    await api.releaseOwnRecord({ store: store(root), ownerId: "owner-a-0123456789abcdef", pid: process.pid + 1 });
    assert.equal((await api.listLiveRecords(store(root))).length, 1);
    await writeFile(join(root, "owner-dead-0123456789abcdef.json"), `${JSON.stringify({ ...first.record, ownerId: "owner-dead-0123456789abcdef", pid: 99999999 })}\n`, { mode: 0o600 });
    assert.equal((await api.listLiveRecords(store(root))).length, 1);
    await api.releaseOwnRecord({ store: store(root), ownerId: "owner-a-0123456789abcdef", pid: process.pid });
    assert.equal((await api.listLiveRecords(store(root))).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fails closed for unsafe paths and stale or unverifiable guards without ABA recovery", async () => {
  const root = await temporaryStore();
  try {
    await writeFile(join(root, ".guard"), `${JSON.stringify({ protocol: "pi-session-owner.guard.v1", pid: 99999999, token: "dead" })}\n`, { mode: 0o600 });
    assert.deepEqual(await launch(root, "owner-a-0123456789abcdef", { kind: "new" }), { decision: "blocked", reason: "registry-busy" });
    await chmod(root, 0o755);
    assert.deepEqual(await launch(root, "owner-b-0123456789abcdef", { kind: "new" }), { decision: "blocked", reason: "registry-unavailable" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compares resolved file and ID targets across intents and resolves inside the guard", async () => {
  const root = await temporaryStore();
  try {
    const first = await api.prepareLaunch({
      store: store(root), pid: process.pid, ownerId: "owner-a-0123456789abcdef", startedAt: new Date().toISOString(),
      resolveReservation: async () => ({ kind: "session", cwd: process.cwd(), sessionFile: "/sessions/a.jsonl", sessionId: "same" }),
    });
    assert.equal(first.decision, "allow");
    const second = await launch(root, "owner-b-0123456789abcdef", { kind: "session-id", cwd: process.cwd(), sessionId: "same" });
    assert.equal(second.decision, "blocked");
    const absentContinue = await api.prepareLaunch({
      store: store(root), pid: process.pid, ownerId: "owner-c-0123456789abcdef", startedAt: new Date().toISOString(),
      resolveReservation: async () => ({ kind: "new", rejectSelecting: true }),
    });
    assert.equal(absentContinue.decision, "allow");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a path reservation with the same header ID as an existing owner", async () => {
  const root = await temporaryStore();
  try {
    assert.equal((await launch(root, "owner-a-0123456789abcdef", { kind: "session", cwd: process.cwd(), sessionFile: "/sessions/a.jsonl", sessionId: "shared-id" })).decision, "allow");
    assert.deepEqual(await launch(root, "owner-b-0123456789abcdef", { kind: "session", cwd: process.cwd(), sessionFile: "/sessions/b.jsonl", sessionId: "shared-id" }), {
      decision: "blocked", reason: "session-owned", conflictingOwnerId: "owner-a-0123456789abcdef",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fails closed when injected ownership verification reports foreign root, guard, or record", async () => {
  const root = await temporaryStore();
  const caller = process.getuid?.();
  if (caller === undefined) return;
  const foreign = caller + 1;
  const owned = (path) => path.endsWith(".guard") || path.endsWith("owner-a-0123456789abcdef.json") ? foreign : caller;
  try {
    assert.deepEqual(await api.prepareLaunch({ store: { ...store(root), uid: () => caller, ownershipUid: () => foreign }, pid: process.pid, ownerId: "owner-root-0123456789abcdef", startedAt: new Date().toISOString(), reservation: { kind: "new" } }), { decision: "blocked", reason: "registry-unavailable" });
    assert.equal((await launch(root, "owner-a-0123456789abcdef", { kind: "new" })).decision, "allow");
    assert.deepEqual(await api.prepareLaunch({ store: { ...store(root), uid: () => caller, ownershipUid: owned }, pid: process.pid, ownerId: "owner-guard-0123456789abcdef", startedAt: new Date().toISOString(), reservation: { kind: "new" } }), { decision: "blocked", reason: "registry-unavailable" });
    await unlink(join(root, ".guard"));
    assert.deepEqual(await api.prepareLaunch({ store: { ...store(root), uid: () => caller, ownershipUid: (path) => path.endsWith("owner-a-0123456789abcdef.json") ? foreign : caller }, pid: process.pid, ownerId: "owner-record-0123456789abcdef", startedAt: new Date().toISOString(), reservation: { kind: "new" } }), { decision: "blocked", reason: "registry-unavailable" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps the prior owner record when atomic replacement cannot be published", async () => {
  const root = await temporaryStore();
  try {
    const first = await launch(root, "owner-a-0123456789abcdef", { kind: "new" });
    const before = await readFile(first.recordPath, "utf8");
    await chmod(root, 0o500);
    await assert.rejects(api.updateOwnRecord({ store: store(root), ownerId: "owner-a-0123456789abcdef", pid: process.pid, state: "active", cwd: process.cwd(), sessionId: "a", sessionFile: "/sessions/a.jsonl" }));
    await chmod(root, 0o700);
    assert.equal(await readFile(first.recordPath, "utf8"), before);
  } finally { await chmod(root, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("fails closed for symlink records and live guards, and serializes own updates with scans", async () => {
  const root = await temporaryStore();
  const unsafe = await temporaryStore();
  try {
    await writeFile(join(root, ".guard"), `${JSON.stringify({ protocol: "pi-session-owner.guard.v1", pid: process.pid, token: "live" })}\n`, { mode: 0o600 });
    assert.deepEqual(await launch(root, "owner-a-0123456789abcdef", { kind: "new" }), { decision: "blocked", reason: "registry-busy" });
    await rm(join(root, ".guard"));
    const first = await launch(root, "owner-a-0123456789abcdef", { kind: "new" });
    await Promise.all([
      api.updateOwnRecord({ store: store(root), ownerId: "owner-a-0123456789abcdef", pid: process.pid, state: "active", cwd: process.cwd(), sessionId: "active", sessionFile: "/sessions/active.jsonl" }),
      api.listLiveRecords(store(root)),
    ]);
    assert.equal((await api.listLiveRecords(store(root)))[0].state, "active");
    await writeFile(join(unsafe, "record"), "unsafe");
    await symlink(join(unsafe, "record"), join(root, "owner-link-0123456789abcdef.json"));
    await assert.rejects(api.listLiveRecords(store(root)));
    assert.equal(first.decision, "allow");
  } finally { await rm(root, { recursive: true, force: true }); await rm(unsafe, { recursive: true, force: true }); }
});

test("keeps PID and owner token across a real zsh to Node exec", { skip: process.platform === "win32" }, async () => {
  const ownerId = "owner-exec-0123456789abcdef";
  const child = spawn("zsh", ["-c", "exec node -e 'process.stdout.write(process.pid + \" \" + process.env.PI_SESSION_OWNER_ID)'"], {
    env: { ...process.env, PI_SESSION_OWNER_ID: ownerId }, stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await new Promise((resolve, reject) => {
    let value = "";
    child.stdout.on("data", (chunk) => { value += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(value) : reject(new Error(`zsh exited ${code}`)));
  });
  assert.match(output, new RegExp(`^${child.pid} ${ownerId}$`));
});

// 捕获把opened owner/type失败误当成可重试inode竞争，从而在异常消失后继续抢锁。
test('guard打开后owner失败立即拒绝，不能等异常消失后重试抢锁', async t => {
  const { unlinkSync } = await import('node:fs');
  const root=await temporaryStore();t.after(()=>rm(root,{recursive:true,force:true}));
  const guard=join(root,'.guard');await writeFile(guard,JSON.stringify({protocol:'pi-session-owner.guard.v1',pid:process.pid,token:'owner-check'}),{mode:0o600});
  let checks=0;
  const storeWithOwner={...store(root),ownershipUid(path,uid){
    if(path===guard&&++checks===2){unlinkSync(guard);return uid+1;}
    return uid;
  }};
  await assert.rejects(api.listLiveRecords(storeWithOwner),error=>error.code==='REGISTRY_UNAVAILABLE');
  assert.equal(checks,2,'opened owner失败不得再次竞争guard');
});

// 使用现有ownership校验接点，在真实lstat与open之间复现合法owner原子发布新inode。
test('guard合法inode替换后重读，不放宽文件owner检查', async t => {
  const { unlinkSync, writeFileSync } = await import('node:fs');
  const root=await temporaryStore();t.after(()=>rm(root,{recursive:true,force:true}));
  const guard=join(root,'.guard');const content=JSON.stringify({protocol:'pi-session-owner.guard.v1',pid:process.pid,token:'inode-check'});
  await writeFile(guard,content,{mode:0o600});let checks=0;
  const observed={...store(root),ownershipUid(path,uid){
    if(path===guard){checks++;if(checks===1){unlinkSync(guard);writeFileSync(guard,content,{mode:0o600});}else if(checks===3){unlinkSync(guard);}}
    return uid;
  }};
  assert.deepEqual(await api.listLiveRecords(observed),[]);
});

// ---- S1g §3–§6：受控运行期 session switch 事务 ----

const SWITCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTED_AT = "2026-10-13T00:00:00.000Z";
const OWNER_A = "owner-switch-a-0123456789";
const OWNER_C = "owner-switch-c-0123456789";
const OWNER_D = "owner-switch-d-0123456789";
const OWNER_E = "owner-switch-e-0123456789";
const OWNER_F = "owner-switch-f-0123456789";
const OWNER_MISSING = "owner-switch-missing-0123";

async function switchFixture(t) {
  const root = await temporaryStore();
  const sessions = await realpath(await mkdtemp(join(tmpdir(), "session-owner-switch-files-")));
  const cwd = await realpath(process.cwd());
  const otherCwd = await realpath(await mkdtemp(join(tmpdir(), "session-owner-switch-cwd-")));
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(sessions, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  });
  const file = (name) => join(sessions, name);
  const identity = (sessionId, name, dir = cwd) => ({ cwd: dir, sessionId, sessionFile: file(name) });
  return { root, sessions, cwd, otherCwd, file, identity };
}

async function activate(root, ownerId, identity, { pid = process.pid, reservation = { kind: "new" } } = {}) {
  const prepared = await api.prepareLaunch({ store: store(root), pid, ownerId, startedAt: STARTED_AT, reservation });
  assert.equal(prepared.decision, "allow", JSON.stringify(prepared));
  return api.updateOwnRecord({ store: store(root), ownerId, pid, state: "active", ...identity, pendingSessionFile: null, forkSource: null });
}

// 省略 pendingSessionFile：模拟 S1b 的 resume shutdown，只改 state 并保留 live reservation。
function transition(root, ownerId, identity, extra = {}, pid = process.pid) {
  return api.updateOwnRecord({ store: store(root), ownerId, pid, state: "transitioning", ...identity, ...extra });
}

async function recordOf(root, ownerId) {
  const record = (await api.listLiveRecords(store(root))).find((value) => value.ownerId === ownerId);
  assert.ok(record, `missing record for ${ownerId}`);
  return record;
}

async function exists(path) {
  return lstat(path).then(() => true, () => false);
}

function identityOf(record) {
  return { cwd: record.cwd, sessionId: record.sessionId, sessionFile: record.sessionFile };
}

const reserve = (root, ownerId, source, target, pid = process.pid) => api.reserveSwitchTarget({ store: store(root), ownerId, pid, source, target });
const commit = (root, ownerId, input, pid = process.pid) => api.commitSwitchTarget({ store: store(root), ownerId, pid, ...input });
const abort = (root, ownerId, input, pid = process.pid) => api.abortSwitchTarget({ store: store(root), ownerId, pid, ...input });

async function reserveOk(root, ownerId, source, target, pid = process.pid) {
  const result = await reserve(root, ownerId, source, target, pid);
  assert.equal(result.decision, "reserved", JSON.stringify(result));
  assert.match(result.reservationId, SWITCH_UUID);
  return result.reservationId;
}

test("导出reserve/commit/abort三个switch事务API", () => {
  assert.equal(typeof api.reserveSwitchTarget, "function");
  assert.equal(typeof api.commitSwitchTarget, "function");
  assert.equal(typeof api.abortSwitchTarget, "function");
});

test("reserve保留source并占用target，阻断其他owner，commit后旧source可重新被claim", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  const E = f.identity("e", "e.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  const reserved = await recordOf(f.root, OWNER_A);
  assert.deepEqual(identityOf(reserved), A, "顶层身份必须仍是source");
  assert.equal(reserved.state, "active");
  assert.equal(reserved.pendingSessionFile, B.sessionFile);
  assert.deepEqual(reserved.switchReservation, { reservationId, source: A, target: B, phase: "reserved" });
  // startup 的 file 与 session-id intent 都必须看见 pending target。
  assert.deepEqual(await launch(f.root, OWNER_C, { kind: "session", cwd: B.cwd, sessionFile: B.sessionFile, sessionId: B.sessionId }), {
    decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_A,
  });
  assert.deepEqual(await launch(f.root, OWNER_D, { kind: "session-id", cwd: B.cwd, sessionId: B.sessionId }), {
    decision: "blocked", reason: "session-id-owned", conflictingOwnerId: OWNER_A,
  });
  await activate(f.root, OWNER_E, E);
  assert.deepEqual(await reserve(f.root, OWNER_E, E, B), { decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_A });
  assert.deepEqual(await reserve(f.root, OWNER_E, E, A), { decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_A });
  // resume shutdown 只改 state，pending 与 receipt 必须保留。
  await transition(f.root, OWNER_A, A);
  const transitioning = await recordOf(f.root, OWNER_A);
  assert.equal(transitioning.state, "transitioning");
  assert.equal(transitioning.pendingSessionFile, B.sessionFile);
  assert.deepEqual(identityOf(transitioning), A);
  const committed = await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId });
  assert.equal(committed.decision, "committed", JSON.stringify(committed));
  assert.deepEqual(identityOf(committed.record), B);
  assert.equal(committed.record.state, "active");
  assert.equal(committed.record.pendingSessionFile, null);
  assert.equal(committed.record.forkSource, null);
  assert.deepEqual(committed.record.switchReservation, { reservationId, source: A, target: B, phase: "committed" });
  assert.deepEqual(await recordOf(f.root, OWNER_A), committed.record, "发布必须已落盘");
  // committed receipt 不占资源：旧 source 可被另一 launcher 重新 claim。
  assert.equal((await launch(f.root, OWNER_F, { kind: "session", cwd: A.cwd, sessionFile: A.sessionFile, sessionId: A.sessionId })).decision, "allow");
});

test("同owner/source/target重入返回原nonce，换target被拒且无副作用", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  const B2 = f.identity("b", "b2.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  const repeated = await reserve(f.root, OWNER_A, A, B);
  assert.deepEqual(repeated, { decision: "reserved", reservationId });
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B2), { decision: "blocked", reason: "transition-in-progress" });
  const unchanged = await recordOf(f.root, OWNER_A);
  assert.equal(unchanged.pendingSessionFile, B.sessionFile, "拒绝换目标不得留下副作用");
  assert.deepEqual(unchanged.switchReservation, { reservationId, source: A, target: B, phase: "reserved" });
  // 顶层 source 不一致时是 source-mismatch，不能偷偷当成换目标。
  assert.deepEqual(await reserve(f.root, OWNER_A, { ...A, sessionId: "a-other" }, B), { decision: "blocked", reason: "source-mismatch" });
});

test("另一owner同PID仍冲突，只有ownerId+pid同时匹配才排除自身", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  await activate(f.root, OWNER_C, B);
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_C });
  await api.releaseOwnRecord({ store: store(f.root), ownerId: OWNER_C, pid: process.pid });
  // 同一 PID 的自身记录才能继续事务。
  assert.equal((await reserve(f.root, OWNER_A, A, B)).decision, "reserved");
});

test("reserve只清理ESRCH记录，存活或EPERM的外部PID记录保留并继续冲突", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const deadPath = join(f.root, `${OWNER_D}.json`);
  await writeFile(deadPath, `${JSON.stringify({ protocol: "pi-session-owner.v1", ownerId: OWNER_D, pid: 99999999, cwd: B.cwd, sessionId: B.sessionId, sessionFile: B.sessionFile, state: "active", pendingSessionFile: null, forkSource: null, startedAt: STARTED_AT })}\n`, { mode: 0o600 });
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  assert.equal(await exists(deadPath), false, "ESRCH记录必须被清理");
  assert.equal((await abort(f.root, OWNER_A, { source: A, target: B, reservationId })).decision, "aborted");
  // pid 1 存活但普通用户无法 signal（EPERM）：不得当作死亡清理。
  const alivePath = join(f.root, `${OWNER_C}.json`);
  await writeFile(alivePath, `${JSON.stringify({ protocol: "pi-session-owner.v1", ownerId: OWNER_C, pid: 1, cwd: B.cwd, sessionId: B.sessionId, sessionFile: B.sessionFile, state: "active", pendingSessionFile: null, forkSource: null, startedAt: STARTED_AT })}\n`, { mode: 0o600 });
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_C });
  assert.equal(await exists(alivePath), true, "EPERM/存活记录必须保留");
});

test("own source被另一记录占用时reserve拒绝", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  // updateOwnRecord 不做冲突扫描，因此这是公开入口可产生的现场：两条记录同时声称同一 source。
  await activate(f.root, OWNER_C, A);
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_C });
  assert.equal((await recordOf(f.root, OWNER_A)).switchReservation, undefined, "被拒绝的reserve不得写receipt");
});

test("跨cwd target的ID冲突不能用source.cwd比较", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  await activate(f.root, OWNER_A, A);
  await activate(f.root, OWNER_C, { cwd: f.otherCwd, sessionId: "b", sessionFile: f.file("other-b.jsonl") });
  const target = { cwd: f.otherCwd, sessionId: "b", sessionFile: f.file("b.jsonl") };
  assert.deepEqual(await reserve(f.root, OWNER_A, A, target), { decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_C });
});

test("自身记录缺失或PID不同时三个API都返回owner-mismatch", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  assert.deepEqual(await reserve(f.root, OWNER_MISSING, A, B), { decision: "blocked", reason: "owner-mismatch" });
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B, process.pid + 1), { decision: "blocked", reason: "owner-mismatch", conflictingOwnerId: OWNER_A });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId }, process.pid + 1), { decision: "blocked", reason: "owner-mismatch", conflictingOwnerId: OWNER_A });
  assert.deepEqual(await abort(f.root, OWNER_A, { source: A, target: B, reservationId }, process.pid + 1), { decision: "blocked", reason: "owner-mismatch", conflictingOwnerId: OWNER_A });
  assert.deepEqual((await recordOf(f.root, OWNER_A)).switchReservation.phase, "reserved", "owner校验失败不得改动记录");
});

test("非active记录不能reserve，source三字段必须精确相等", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  await transition(f.root, OWNER_A, A);
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "transition-in-progress" });
  assert.equal((await launch(f.root, OWNER_C, { kind: "session", cwd: f.cwd, sessionFile: f.file("pending.jsonl"), sessionId: "pending" })).decision, "allow");
  assert.deepEqual(await reserve(f.root, OWNER_C, f.identity("pending", "pending.jsonl"), B), { decision: "blocked", reason: "transition-in-progress" });
  await activate(f.root, OWNER_E, f.identity("e", "e.jsonl"));
  assert.deepEqual(await reserve(f.root, OWNER_E, { ...f.identity("e", "e.jsonl"), cwd: f.otherCwd }, B), { decision: "blocked", reason: "source-mismatch" });
  assert.deepEqual(await reserve(f.root, OWNER_E, { ...f.identity("e", "e.jsonl"), sessionFile: f.file("e2.jsonl") }, B), { decision: "blocked", reason: "source-mismatch" });
});

test("commit resume校验state/nonce/source/target，只有全部匹配才原子发布", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  // resume shutdown 尚未发生（仍 active）时不能提前 commit。
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId }), { decision: "blocked", reason: "transition-in-progress" });
  await transition(f.root, OWNER_A, A);
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId: randomUUID() }), { decision: "blocked", reason: "stale-reservation" });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: { ...A, sessionId: "a-other" }, target: B, reservationId }), { decision: "blocked", reason: "source-mismatch" });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: A, target: { ...B, sessionFile: f.file("b2.jsonl") }, reservationId }), { decision: "blocked", reason: "target-mismatch" });
  const untouched = await recordOf(f.root, OWNER_A);
  assert.equal(untouched.state, "transitioning");
  assert.deepEqual(identityOf(untouched), A, "任何mismatch都不得清source或pending");
  assert.equal(untouched.pendingSessionFile, B.sessionFile);
  assert.equal((await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId })).decision, "committed");
});

test("commit resume同token幂等，旧token与committed token的abort一律拒绝", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  await transition(f.root, OWNER_A, A);
  const first = await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId });
  assert.equal(first.decision, "committed");
  const replay = await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId });
  assert.equal(replay.decision, "committed");
  assert.deepEqual(replay.record, first.record, "同token重入只做原子验证");
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId: randomUUID() }), { decision: "blocked", reason: "stale-reservation" });
  assert.deepEqual(await abort(f.root, OWNER_A, { source: A, target: B, reservationId }), { decision: "blocked", reason: "stale-reservation" });
  assert.deepEqual(await recordOf(f.root, OWNER_A), first.record, "拒绝的旧token不得改动记录");
});

test("abort幂等且只清pending不改source，transitioning与不同target/source被拒", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  assert.deepEqual(await abort(f.root, OWNER_A, { source: A, target: { ...B, sessionId: "b2" }, reservationId }), { decision: "blocked", reason: "target-mismatch" });
  assert.deepEqual(await abort(f.root, OWNER_A, { source: { ...A, sessionId: "a2" }, target: B, reservationId }), { decision: "blocked", reason: "source-mismatch" });
  assert.deepEqual(await abort(f.root, OWNER_A, { source: A, target: B, reservationId: randomUUID() }), { decision: "blocked", reason: "stale-reservation" });
  const aborted = await abort(f.root, OWNER_A, { source: A, target: B, reservationId });
  assert.equal(aborted.decision, "aborted");
  assert.deepEqual(identityOf(aborted.record), A, "abort不得改动顶层source");
  assert.equal(aborted.record.state, "active");
  assert.equal(aborted.record.pendingSessionFile, null);
  assert.deepEqual(aborted.record.switchReservation, { reservationId, source: A, target: B, phase: "aborted" });
  const replay = await abort(f.root, OWNER_A, { source: A, target: B, reservationId });
  assert.equal(replay.decision, "aborted");
  assert.deepEqual(replay.record, aborted.record);
  // abort 后旧 token 不能再 commit（new/fork shutdown 清终态 receipt 后）。
  await transition(f.root, OWNER_A, A, { switchReservation: null });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId }), { decision: "blocked", reason: "stale-reservation" });
  // live reservation 期间发生 teardown（transitioning）后不能 abort。
  await api.updateOwnRecord({ store: store(f.root), ownerId: OWNER_A, pid: process.pid, state: "active", ...A });
  const second = await reserveOk(f.root, OWNER_A, A, B);
  await transition(f.root, OWNER_A, A);
  assert.deepEqual(await abort(f.root, OWNER_A, { source: A, target: B, reservationId: second }), { decision: "blocked", reason: "transition-in-progress" });
  assert.equal((await recordOf(f.root, OWNER_A)).pendingSessionFile, B.sessionFile, "被拒abort不得清pending");
});

test("token1 abort后token2 reserve，token1的commit/abort一律stale-reservation", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const token1 = await reserveOk(f.root, OWNER_A, A, B);
  assert.equal((await abort(f.root, OWNER_A, { source: A, target: B, reservationId: token1 })).decision, "aborted");
  const token2 = await reserveOk(f.root, OWNER_A, A, B);
  assert.notEqual(token2, token1, "新的reserve必须替换终态receipt并生成新nonce");
  await transition(f.root, OWNER_A, A);
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId: token1 }), { decision: "blocked", reason: "stale-reservation" });
  assert.deepEqual(await abort(f.root, OWNER_A, { source: A, target: B, reservationId: token1 }), { decision: "blocked", reason: "stale-reservation" });
  const live = await recordOf(f.root, OWNER_A);
  assert.equal(live.switchReservation.reservationId, token2);
  assert.equal(live.switchReservation.phase, "reserved");
  assert.equal((await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId: token2 })).decision, "committed");
});

test("startup commit沿用launcher的pending/session-id/forkSource可启动规则", async (t) => {
  const f = await switchFixture(t);
  const pinned = f.identity("pinned", "pinned.jsonl");
  assert.equal((await launch(f.root, OWNER_A, { kind: "session", cwd: pinned.cwd, sessionFile: pinned.sessionFile, sessionId: pinned.sessionId })).decision, "allow");
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "startup", source: null, target: f.identity("pinned", "other.jsonl"), reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  const started = await commit(f.root, OWNER_A, { kind: "startup", source: null, target: pinned, reservationId: null });
  assert.equal(started.decision, "committed");
  assert.deepEqual(identityOf(started.record), pinned);
  assert.equal(started.record.state, "active");
  assert.equal(started.record.pendingSessionFile, null);
  assert.equal(started.record.switchReservation, null);
  // active 重入只接受同一 identity，不能被任意 target 覆盖。
  assert.equal((await commit(f.root, OWNER_A, { kind: "startup", source: null, target: pinned, reservationId: null })).decision, "committed");
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "startup", source: null, target: f.identity("other", "other.jsonl"), reservationId: null }), { decision: "blocked", reason: "target-mismatch" });

  assert.equal((await launch(f.root, OWNER_C, { kind: "session-id", cwd: f.cwd, sessionId: "sid" })).decision, "allow");
  assert.deepEqual(await commit(f.root, OWNER_C, { kind: "startup", source: null, target: { cwd: f.cwd, sessionId: "other", sessionFile: f.file("sid.jsonl") }, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  assert.equal((await commit(f.root, OWNER_C, { kind: "startup", source: null, target: { cwd: f.cwd, sessionId: "sid", sessionFile: f.file("sid.jsonl") }, reservationId: null })).decision, "committed");

  const forkSource = { cwd: f.cwd, sessionFile: f.file("fork-source.jsonl"), sessionId: "fork-source" };
  assert.equal((await launch(f.root, OWNER_D, { kind: "fork-source", cwd: f.cwd, source: forkSource })).decision, "allow");
  assert.deepEqual(await commit(f.root, OWNER_D, { kind: "startup", source: null, target: forkSource, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  assert.deepEqual(await commit(f.root, OWNER_D, { kind: "startup", source: null, target: { cwd: f.otherCwd, sessionId: "dest", sessionFile: f.file("dest.jsonl") }, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  assert.equal((await commit(f.root, OWNER_D, { kind: "startup", source: null, target: f.identity("dest", "dest.jsonl"), reservationId: null })).decision, "committed");

  // live reservation 期间不允许 startup commit 覆盖。
  const B = f.identity("b", "b.jsonl");
  const A = f.identity("a", "a.jsonl");
  await activate(f.root, OWNER_F, A);
  const reservationId = await reserveOk(f.root, OWNER_F, A, B);
  assert.deepEqual(await commit(f.root, OWNER_F, { kind: "startup", source: null, target: B, reservationId: null }), { decision: "blocked", reason: "transition-in-progress" });
  assert.equal((await recordOf(f.root, OWNER_F)).switchReservation.reservationId, reservationId);
});

test("reload commit只验证source===target并保留reservation与pending", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "reload", source: A, target: B, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "reload", source: B, target: B, reservationId: null }), { decision: "blocked", reason: "source-mismatch" });
  const reloaded = await commit(f.root, OWNER_A, { kind: "reload", source: A, target: A, reservationId: null });
  assert.equal(reloaded.decision, "committed");
  assert.deepEqual(reloaded.record, await recordOf(f.root, OWNER_A));
  assert.equal(reloaded.record.pendingSessionFile, B.sessionFile, "reload必须保留pending");
  assert.deepEqual(reloaded.record.switchReservation, { reservationId, source: A, target: B, phase: "reserved" });
  await transition(f.root, OWNER_A, A);
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "reload", source: A, target: A, reservationId: null }), { decision: "blocked", reason: "transition-in-progress" });
});

test("new/fork commit要求transitioning与新ID，成功后清startup字段与receipt", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  const C = f.identity("c", "c.jsonl");
  assert.equal((await launch(f.root, OWNER_C, { kind: "new" })).decision, "allow");
  assert.deepEqual(await commit(f.root, OWNER_C, { kind: "new", source: A, target: C, reservationId: null }), { decision: "blocked", reason: "transition-in-progress" });
  await api.releaseOwnRecord({ store: store(f.root), ownerId: OWNER_C, pid: process.pid });

  await activate(f.root, OWNER_A, A);
  // 未发生 teardown（仍 active）时，new/fork 只能用当前 active identity 幂等验证，不同 target 拒绝。
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "new", source: A, target: B, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  await transition(f.root, OWNER_A, A);
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "new", source: A, target: A, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "fork", source: A, target: { ...B, sessionId: "a" }, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "new", source: B, target: C, reservationId: null }), { decision: "blocked", reason: "source-mismatch" });
  const created = await commit(f.root, OWNER_A, { kind: "new", source: A, target: B, reservationId: null });
  assert.equal(created.decision, "committed");
  assert.deepEqual(identityOf(created.record), B);
  assert.equal(created.record.state, "active");
  assert.equal(created.record.pendingSessionFile, null);
  assert.equal(created.record.forkSource, null);
  assert.equal(created.record.switchReservation, null);
  // 重复 session_start：同 active identity 幂等，不同 identity 拒绝。
  assert.equal((await commit(f.root, OWNER_A, { kind: "new", source: A, target: B, reservationId: null })).decision, "committed");
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "fork", source: A, target: C, reservationId: null }), { decision: "blocked", reason: "target-mismatch" });

  // 终态 receipt 由 new/fork shutdown 清 null 后，fork commit 可继续，且不复用旧 receipt。
  const reservationId = await reserveOk(f.root, OWNER_A, B, C);
  await transition(f.root, OWNER_A, B);
  assert.equal((await commit(f.root, OWNER_A, { kind: "resume", source: B, target: C, reservationId })).decision, "committed");
  await transition(f.root, OWNER_A, C, { switchReservation: null });
  const forked = await commit(f.root, OWNER_A, { kind: "fork", source: C, target: f.identity("d", "d.jsonl"), reservationId: null });
  assert.equal(forked.decision, "committed");
  assert.equal(forked.record.switchReservation, null);
  assert.deepEqual(identityOf(forked.record), f.identity("d", "d.jsonl"));

  // live reservation 期间 new/fork 不放行。
  await activate(f.root, OWNER_E, f.identity("e", "e.jsonl"));
  const liveToken = await reserveOk(f.root, OWNER_E, f.identity("e", "e.jsonl"), f.identity("f", "f.jsonl"));
  await transition(f.root, OWNER_E, f.identity("e", "e.jsonl"));
  assert.deepEqual(await commit(f.root, OWNER_E, { kind: "new", source: f.identity("e", "e.jsonl"), target: f.identity("g", "g.jsonl"), reservationId: null }), { decision: "blocked", reason: "transition-in-progress" });
  assert.equal((await recordOf(f.root, OWNER_E)).switchReservation.reservationId, liveToken);
});

test("selecting记录可被startup commit落成已选identity，且不阻塞其他owner的new事务", async (t) => {
  const f = await switchFixture(t);
  assert.equal((await launch(f.root, OWNER_E, { kind: "selecting" })).decision, "allow");
  const selected = f.identity("selected", "selected.jsonl");
  const selectingCommit = await commit(f.root, OWNER_E, { kind: "startup", source: null, target: selected, reservationId: null });
  assert.equal(selectingCommit.decision, "committed");
  assert.equal(selectingCommit.record.state, "active");
  assert.deepEqual(identityOf(selectingCommit.record), selected);
  assert.equal(selectingCommit.record.switchReservation, null);
  // 已落成的 selecting 记录不再阻断其他 owner 的独立事务。
  const A = f.identity("a", "a.jsonl");
  await activate(f.root, OWNER_A, A);
  await transition(f.root, OWNER_A, A);
  assert.equal((await commit(f.root, OWNER_A, { kind: "new", source: A, target: f.identity("a2", "a2.jsonl"), reservationId: null })).decision, "committed");
});

test("reserve受外部selector阻断为selector-active，commit只按身份冲突判定", async (t) => {
  const f = await switchFixture(t);
  // 现场可达顺序：S 以 resume 进入 selector（contract.ts 将其解为 kind selecting），
  // A 随后以 new/ephemeral/non-interactive 启动（解为 kind new，不带 rejectSelecting）。
  assert.equal((await launch(f.root, OWNER_E, { kind: "selecting" })).decision, "allow");
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "selector-active", conflictingOwnerId: OWNER_E });
  assert.equal((await recordOf(f.root, OWNER_A)).switchReservation, undefined, "selector阻断不得写receipt");
  // 同一现场下 commit 不沿用 selector 全局规则：selector 记录没有可匹配身份，不阻断 new 事务。
  await transition(f.root, OWNER_A, A);
  const A2 = f.identity("a2", "a2.jsonl");
  const created = await commit(f.root, OWNER_A, { kind: "new", source: A, target: A2, reservationId: null });
  assert.equal(created.decision, "committed");
  assert.deepEqual(identityOf(created.record), A2);
  // 但真实身份冲突仍然阻断 commit，不能因为不看 selector 就放宽 target 校验。
  const C = f.identity("c", "c.jsonl");
  await activate(f.root, OWNER_C, C);
  await transition(f.root, OWNER_C, C);
  assert.deepEqual(await commit(f.root, OWNER_C, { kind: "fork", source: C, target: A2, reservationId: null }), { decision: "blocked", reason: "session-owned", conflictingOwnerId: OWNER_A });
});

test("两个owner的new/fork事务互相独立，不引入running owner全局锁", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  const C = f.identity("c", "c.jsonl");
  await activate(f.root, OWNER_A, A);
  await activate(f.root, OWNER_C, B);
  await transition(f.root, OWNER_A, A);
  await transition(f.root, OWNER_C, B);
  assert.equal((await commit(f.root, OWNER_A, { kind: "new", source: A, target: f.identity("a2", "a2.jsonl"), reservationId: null })).decision, "committed");
  assert.equal((await commit(f.root, OWNER_C, { kind: "fork", source: B, target: C, reservationId: null })).decision, "committed");
  assert.equal((await launch(f.root, OWNER_D, { kind: "new" })).decision, "allow");
});

test("legacy v1缺switchReservation等价null，畸形或不一致的receipt整条记录fail closed", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const legacy = { protocol: "pi-session-owner.v1", ownerId: OWNER_C, pid: process.pid, cwd: f.cwd, sessionId: "legacy", sessionFile: f.file("legacy.jsonl"), state: "active", pendingSessionFile: null, forkSource: null, startedAt: STARTED_AT };
  const legacyIdentity = { cwd: legacy.cwd, sessionId: legacy.sessionId, sessionFile: legacy.sessionFile };
  await writeFile(join(f.root, `${OWNER_C}.json`), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const records = await api.listLiveRecords(store(f.root));
  assert.equal(records.length, 2);
  assert.equal("switchReservation" in records.find((record) => record.ownerId === OWNER_C), false, "legacy记录不得被补键");
  assert.equal((await reserve(f.root, OWNER_A, A, B)).decision, "reserved", "legacy记录必须可参与冲突扫描");

  const malformed = [
    { ...legacy, ownerId: OWNER_D, switchReservation: { reservationId: "not-a-uuid", source: A, target: B, phase: "reserved" } },
    { ...legacy, ownerId: OWNER_E, switchReservation: { reservationId: randomUUID(), source: A, target: B, phase: "reserved", extra: true } },
    { ...legacy, ownerId: OWNER_F, switchReservation: { reservationId: randomUUID(), target: B, phase: "committed" } },
  ];
  for (const record of malformed) {
    const path = join(f.root, `${record.ownerId}.json`);
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "registry-unavailable" });
    assert.deepEqual(await commit(f.root, OWNER_A, { kind: "reload", source: A, target: A, reservationId: null }), { decision: "blocked", reason: "registry-unavailable" });
    assert.deepEqual(await abort(f.root, OWNER_A, { source: A, target: B, reservationId: randomUUID() }), { decision: "blocked", reason: "registry-unavailable" });
    await assert.rejects(api.listLiveRecords(store(f.root)), (error) => error.code === "REGISTRY_UNAVAILABLE");
    assert.equal(await exists(path), true, "坏记录必须保留等待人工确认");
    await unlink(path);
  }

  // phase 与顶层字段不一致（即使原 v1 字段全部有效）同样是坏记录。
  const inconsistent = [
    // reserved 必须 pendingSessionFile === target.file。
    { ...legacy, ownerId: OWNER_D, switchReservation: { reservationId: randomUUID(), source: legacyIdentity, target: B, phase: "reserved" } },
    // committed 必须顶层===target、state active。
    { ...legacy, ownerId: OWNER_E, switchReservation: { reservationId: randomUUID(), source: legacyIdentity, target: B, phase: "committed" } },
    // aborted 必须顶层===source、state active、pending null。
    { ...legacy, ownerId: OWNER_F, state: "transitioning", switchReservation: { reservationId: randomUUID(), source: legacyIdentity, target: B, phase: "aborted" } },
    // reserved 必须顶层===source。
    { ...legacy, ownerId: OWNER_C, pendingSessionFile: B.sessionFile, switchReservation: { reservationId: randomUUID(), source: A, target: B, phase: "reserved" } },
  ];
  for (const record of inconsistent) {
    const path = join(f.root, `${record.ownerId}.json`);
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "registry-unavailable" });
    assert.equal(await exists(path), true);
    await unlink(path);
  }
  assert.equal((await reserve(f.root, OWNER_A, A, B)).decision, "reserved", "清理坏记录后事务必须恢复");
});

test("updateOwnRecord省略字段保留reservation，phase reserved下拒绝清pending/换source/改receipt", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  await assert.rejects(api.updateOwnRecord({ store: store(f.root), ownerId: OWNER_A, pid: process.pid, state: "active", ...A, pendingSessionFile: null }), (error) => error.code === "REGISTRY_UNAVAILABLE");
  await assert.rejects(api.updateOwnRecord({ store: store(f.root), ownerId: OWNER_A, pid: process.pid, state: "active", ...B }), (error) => error.code === "REGISTRY_UNAVAILABLE");
  await assert.rejects(api.updateOwnRecord({ store: store(f.root), ownerId: OWNER_A, pid: process.pid, state: "active", ...A, switchReservation: null }), (error) => error.code === "REGISTRY_UNAVAILABLE");
  await assert.rejects(api.updateOwnRecord({ store: store(f.root), ownerId: OWNER_A, pid: process.pid, state: "active", ...A, switchReservation: { reservationId, source: A, target: B, phase: "committed" } }), (error) => error.code === "REGISTRY_UNAVAILABLE");
  const preserved = await recordOf(f.root, OWNER_A);
  assert.equal(preserved.pendingSessionFile, B.sessionFile);
  assert.deepEqual(preserved.switchReservation, { reservationId, source: A, target: B, phase: "reserved" });
  assert.equal(preserved.state, "active");
  // 省略 pendingSessionFile 的 transitioning 更新必须保留 live reservation。
  await transition(f.root, OWNER_A, A);
  const transitioning = await recordOf(f.root, OWNER_A);
  assert.equal(transitioning.state, "transitioning");
  assert.equal(transitioning.pendingSessionFile, B.sessionFile);
  assert.equal((await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId })).decision, "committed");
  // 终态 receipt 允许被 shutdown 显式清 null。
  await transition(f.root, OWNER_A, B, { switchReservation: null });
  assert.equal((await recordOf(f.root, OWNER_A)).switchReservation, null);
});

test("guard busy、坏记录、外国UID与symlink下三个API都fail closed", async (t) => {
  const caller = process.getuid?.();
  if (caller === undefined) return;
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);

  const guard = join(f.root, ".guard");
  await writeFile(guard, `${JSON.stringify({ protocol: "pi-session-owner.guard.v1", pid: 99999999, token: "stale" })}\n`, { mode: 0o600 });
  for (const result of [
    await reserve(f.root, OWNER_A, A, B),
    await commit(f.root, OWNER_A, { kind: "resume", source: A, target: B, reservationId }),
    await abort(f.root, OWNER_A, { source: A, target: B, reservationId }),
  ]) assert.deepEqual(result, { decision: "blocked", reason: "registry-busy" });
  assert.equal(await exists(guard), true, "陈旧guard只能人工确认，不得自动删除");
  await unlink(guard);

  const foreign = { ...store(f.root), uid: () => caller, ownershipUid: (path) => path.endsWith(`${OWNER_A}.json`) ? caller + 1 : caller };
  const foreignInput = { store: foreign, ownerId: OWNER_A, pid: process.pid, source: A, target: B };
  assert.deepEqual(await api.reserveSwitchTarget(foreignInput), { decision: "blocked", reason: "registry-unavailable" });
  assert.deepEqual(await api.commitSwitchTarget({ ...foreignInput, kind: "resume", reservationId }), { decision: "blocked", reason: "registry-unavailable" });
  assert.deepEqual(await api.abortSwitchTarget({ ...foreignInput, reservationId }), { decision: "blocked", reason: "registry-unavailable" });

  const unsafe = await temporaryStore();
  t.after(() => rm(unsafe, { recursive: true, force: true }));
  await writeFile(join(unsafe, "record"), "unsafe");
  await symlink(join(unsafe, "record"), join(f.root, `${OWNER_D}.json`));
  assert.deepEqual(await reserve(f.root, OWNER_A, A, B), { decision: "blocked", reason: "registry-unavailable" });
  await unlink(join(f.root, `${OWNER_D}.json`));

  await writeFile(join(f.root, `${OWNER_E}.json`), "not json\n", { mode: 0o600 });
  assert.deepEqual(await commit(f.root, OWNER_A, { kind: "reload", source: A, target: A, reservationId: null }), { decision: "blocked", reason: "registry-unavailable" });
  assert.equal(await exists(join(f.root, `${OWNER_E}.json`)), true);
});

test("publish失败与releaseGuard失败都返回blocked，不伪报rollback", async (t) => {
  const caller = process.getuid?.();
  if (caller === undefined) return;
  const { chmodSync } = await import("node:fs");
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const before = await readFile(join(f.root, `${OWNER_A}.json`), "utf8");

  // 在记录读取之后、发布之前把 root 变成只读：publish 失败必须原样保留旧记录。
  const readOnly = { ...store(f.root), ownershipUid: (path, uid) => { if (path.endsWith(`${OWNER_A}.json`)) chmodSync(f.root, 0o500); return uid; } };
  assert.deepEqual(await api.reserveSwitchTarget({ store: readOnly, ownerId: OWNER_A, pid: process.pid, source: A, target: B }), { decision: "blocked", reason: "registry-unavailable" });
  await chmod(f.root, 0o700);
  // releaseGuard 在只读 root 下同样失败，遗留的陈旧 guard 只能人工确认，这里显式清现场。
  await unlink(join(f.root, ".guard")).catch(() => {});
  assert.equal(await readFile(join(f.root, `${OWNER_A}.json`), "utf8"), before, "publish失败不得留下部分写入");
  assert.equal((await recordOf(f.root, OWNER_A)).pendingSessionFile, null);

  // guard 释放失败时 publish 可能已经发生：blocked 不等于已 rollback，调用方必须以持久记录 reconcile。
  const guardForeign = { ...store(f.root), uid: () => caller, ownershipUid: (path, uid) => path.endsWith(".guard") ? uid + 1 : uid };
  assert.deepEqual(await api.reserveSwitchTarget({ store: guardForeign, ownerId: OWNER_A, pid: process.pid, source: A, target: B }), { decision: "blocked", reason: "registry-unavailable" });
  const published = JSON.parse(await readFile(join(f.root, `${OWNER_A}.json`), "utf8"));
  assert.equal(published.pendingSessionFile, B.sessionFile, "blocked结果仍可能已发布");
  assert.equal(published.switchReservation.phase, "reserved");
  await unlink(join(f.root, ".guard"));
  const reservationId = published.switchReservation.reservationId;
  const repeated = await reserve(f.root, OWNER_A, A, B);
  assert.deepEqual(repeated, { decision: "reserved", reservationId }, "下次guard重试必须能reconcile同一nonce");
});

test("switch API输入必须已规范化，未知结构与非法owner/pid/nonce一律registry-unavailable", async (t) => {
  const f = await switchFixture(t);
  const A = f.identity("a", "a.jsonl");
  const B = f.identity("b", "b.jsonl");
  await activate(f.root, OWNER_A, A);
  const invalidReserve = [
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: { ...A, cwd: "relative/cwd" }, target: B },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: { ...A, sessionFile: `${f.sessions}/../a.jsonl` }, target: B },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: { ...A, sessionFile: `${f.file("a.jsonl")}/` }, target: B },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: A, target: { ...B, sessionId: "" } },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: A, target: { cwd: B.cwd, sessionId: "b" } },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: { ...A, extra: 1 }, target: B },
    { store: store(f.root), ownerId: OWNER_A, pid: 0, source: A, target: B },
    { store: store(f.root), ownerId: "bad", pid: process.pid, source: A, target: B },
    { store: { root: "relative/root", guardTimeoutMs: 150 }, ownerId: OWNER_A, pid: process.pid, source: A, target: B },
    { store: null, ownerId: OWNER_A, pid: process.pid, source: A, target: B },
  ];
  for (const input of invalidReserve) assert.deepEqual(await api.reserveSwitchTarget(input), { decision: "blocked", reason: "registry-unavailable" });
  const reservationId = await reserveOk(f.root, OWNER_A, A, B);
  const invalidCommit = [
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, kind: "unknown", source: A, target: A, reservationId: null },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, kind: "startup", source: A, target: A, reservationId: null },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, kind: "startup", source: null, target: A, reservationId },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, kind: "resume", source: A, target: B, reservationId: "token" },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, kind: "reload", source: A, target: A, reservationId },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, kind: "new", source: A, target: A, reservationId },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, kind: "resume", source: A, target: B },
  ];
  for (const input of invalidCommit) assert.deepEqual(await api.commitSwitchTarget(input), { decision: "blocked", reason: "registry-unavailable" });
  const invalidAbort = [
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: A, target: B, reservationId: "token" },
    { store: store(f.root), ownerId: OWNER_A, pid: process.pid, source: A, target: { ...B, sessionFile: "b.jsonl" }, reservationId },
    { store: store(f.root), ownerId: OWNER_A, pid: Number.NaN, source: A, target: B, reservationId },
  ];
  for (const input of invalidAbort) assert.deepEqual(await api.abortSwitchTarget(input), { decision: "blocked", reason: "registry-unavailable" });
  assert.deepEqual((await recordOf(f.root, OWNER_A)).switchReservation, { reservationId, source: A, target: B, phase: "reserved" }, "非法输入不得改动记录");
});
