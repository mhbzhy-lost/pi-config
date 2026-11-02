import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoordinatorRegistry, COORDINATOR_METADATA_FILE, classifyCoordinatorOwner } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { ensureCoordinatorDaemon } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts";
import { captureProcessBirthIdentity } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "registry-lock-"));
  const originRoot = join(root, "origin");
  await mkdir(originRoot, { recursive: true });
  await writeFile(join(originRoot, "README.md"), "base\n");
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "t@t");
  git(originRoot, "config", "user.name", "t");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  const commonDir = join(originRoot, ".git");
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  t.after(async () => {
    // 清理可能被拉起的 daemon（测试用大宽限，避免误杀竞态）。
    try {
      const metadata = JSON.parse(await readFile(join(commonDir, ".pi-coordinator", COORDINATOR_METADATA_FILE), "utf8"));
      if (typeof metadata.pid === "number") process.kill(metadata.pid, "SIGKILL");
    } catch { /* 无登记即无 daemon */ }
    await rm(root, { recursive: true, force: true });
  });
  return { root, originRoot, commonDir, stateRoot, repositoryId: "a".repeat(64), storageRepositoryId: "b".repeat(64) };
}

const ensureOf = (f, overrides = {}) => ensureCoordinatorDaemon({
  stateRoot: f.stateRoot, repositoryId: f.repositoryId, commonDir: f.commonDir,
  endpoint: createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot }).endpoint,
  idleExitGraceMs: 60_000, ...overrides,
});

test("classify 四态：自身进程 alive，pid 复用 mismatch，死 pid dead，畸形 undetermined", async () => {
  const selfBirth = await captureProcessBirthIdentity(process.pid);
  assert.equal(await classifyCoordinatorOwner({ pid: process.pid, birthIdentity: selfBirth }), "alive");
  assert.equal(await classifyCoordinatorOwner({ pid: process.pid, birthIdentity: "f".repeat(64) }), "mismatch", "PID 复用形态必须判 mismatch");
  assert.equal(await classifyCoordinatorOwner({ pid: 999999999, birthIdentity: "0".repeat(64) }), "dead");
  assert.equal(await classifyCoordinatorOwner({ pid: -1 }), "undetermined");
  assert.equal(await classifyCoordinatorOwner({ pid: process.pid }), "undetermined", "缺 birthIdentity 不可判活");
});

test("spawn 锁：活 owner 的锁不回收（超时 fail-closed），释放后拉起成功", async (t) => {
  const f = await fixture(t);
  const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  const lock = `${registry.endpoint}.spawn.lock`;
  await writeFile(lock, JSON.stringify({ pid: process.pid, birthIdentity: await captureProcessBirthIdentity(process.pid) }), { mode: 0o600 });
  // 慢持有者：mtime 回拨到 60s 前也不得被回收。
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  await assert.rejects(() => ensureOf(f, { spawnTimeoutMs: 400 }), /lock|timeout/i, "活跃 owner 的锁不得被回收");
  assert.equal((await stat(lock)).isFile(), true, "活跃 owner 的锁不得被删除");
  await rm(lock, { force: true });
  const handle = await ensureOf(f);
  t.after(() => { try { process.kill(handle.metadata.pid, "SIGKILL"); } catch { /* 已退出 */ } });
  assert.match(handle.metadata.instanceId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
});

test("spawn 锁：死 owner（pid 不存在）被回收；pid 复用（birth 不匹配）fail-closed（D4）", async (t) => {
  for (const [label, owner, expectRecycled] of [
    ["dead-pid", { pid: 999999999, birthIdentity: "0".repeat(64) }, true],
    ["pid-reuse", { pid: process.pid, birthIdentity: "f".repeat(64) }, false],
  ]) {
    const f = await fixture(t);
    const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
    const lock = `${registry.endpoint}.spawn.lock`;
    await mkdir(join(f.commonDir, ".pi-coordinator"), { recursive: true });
    await writeFile(lock, JSON.stringify(owner), { mode: 0o600 });
    if (expectRecycled) {
      const handle = await ensureOf(f);
      t.after(() => { try { process.kill(handle.metadata.pid, "SIGKILL"); } catch { /* 已退出 */ } });
      assert.equal(handle.metadata.repositoryId, f.repositoryId, `${label}：锁回收后拉起成功`);
    } else {
      await assert.rejects(() => ensureOf(f, { spawnTimeoutMs: 400 }), (error) => error.code === "COORDINATOR_SPAWN_LOCK_UNDETERMINED", `${label}：mismatch 不得覆盖锁`);
      assert.equal((await stat(lock)).isFile(), true, `${label}：fail-closed 保留锁文件`);
    }
  }
});

test("spawn 锁：malformed 锁 fail-closed，不猜测不覆盖", async (t) => {
  const f = await fixture(t);
  const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  const lock = `${registry.endpoint}.spawn.lock`;
  await mkdir(join(f.commonDir, ".pi-coordinator"), { recursive: true });
  await writeFile(lock, "legacy", { mode: 0o600 });
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  await assert.rejects(() => ensureOf(f, { spawnTimeoutMs: 400 }), /无法解析|undetermined|unavailable/i, "malformed 锁不得被 TTL 兜底回收");
  assert.equal((await stat(lock)).isFile(), true, "fail-closed 不得删除锁");
  // 人工清理后恢复正常拉起。
  await rm(lock, { force: true });
  const handle = await ensureOf(f);
  t.after(() => { try { process.kill(handle.metadata.pid, "SIGKILL"); } catch { /* 已退出 */ } });
  assert.equal(handle.metadata.kind ?? "daemon", "daemon");
});
