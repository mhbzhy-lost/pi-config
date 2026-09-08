import assert from "node:assert/strict";
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
