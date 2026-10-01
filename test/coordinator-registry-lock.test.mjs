import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoordinatorRegistry, COORDINATOR_METADATA_FILE } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
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
  git(originRoot, "add", "README.md");
  git(originRoot, "commit", "-m", "base");
  const commonDir = pathResolve(git(originRoot, "rev-parse", "--git-common-dir"), originRoot);
  const stateRoot = join(root, "state");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, originRoot, commonDir, stateRoot, repositoryId: "a".repeat(64), storageRepositoryId: "b".repeat(64) };
}

function pathResolve(value, cwd) {
  const path = import("node:path");
  return value.startsWith("/") ? value : join(cwd, value);
}

function lockPathOf(f) {
  return join(f.commonDir, ".pi-coordinator", `${COORDINATOR_METADATA_FILE}.lock`);
}

test("lock 写入 owner PID 与 birth identity（慢 claim：mtime 超过旧 TTL 仍不回收）", async (t) => {
  const f = await fixture(t);
  // 慢 claim 场景：owner 仍活跃，但 lock 年龄已超过旧实现的 30s TTL。
  // 旧实现会误删活跃 lock 并发 claim；owner 校验必须阻止它。
  const dir = join(f.commonDir, ".pi-coordinator");
  await mkdir(dir, { recursive: true });
  const lock = lockPathOf(f);
  await writeFile(lock, JSON.stringify({ pid: process.pid, birthIdentity: await captureProcessBirthIdentity(process.pid) }), { mode: 0o600 });
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  const registry2 = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  const started = Date.now();
  const racing = registry2.claim({ repositoryId: f.repositoryId }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error?.message ?? error) }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await stat(lock)).isFile(), true, "活跃 owner 的 lock 不得被删除");
  await rm(lock, { force: true }); // 模拟 owner 释放
  const outcome = await racing;
  assert.equal(outcome.ok, true, `claim 在 lock 释放后应成功，实际 ${outcome.ok ? "" : outcome.error}`);
  if (outcome.ok) t.after(() => registry2.release().catch(() => undefined));
});

test("死 owner 的 lock（PID 不存在）被回收", async (t) => {
  const f = await fixture(t);
  const dir = join(f.commonDir, ".pi-coordinator");
  await mkdir(dir, { recursive: true });
  const lock = lockPathOf(f);
  // PID 999999999 几乎必然不存在；birth identity 任意。
  await writeFile(lock, JSON.stringify({ pid: 999999999, birthIdentity: "0".repeat(64) }), { mode: 0o600 });
  const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  const metadata = await registry.claim({ repositoryId: f.repositoryId });
  assert.match(metadata.instanceId, /^[a-f0-9]{32}$/);
  t.after(() => registry.release().catch(() => undefined));
});

test("死 owner 的 lock（PID 存活但 birth 不匹配）被回收", async (t) => {
  const f = await fixture(t);
  const dir = join(f.commonDir, ".pi-coordinator");
  await mkdir(dir, { recursive: true });
  const lock = lockPathOf(f);
  // 本进程 PID 但错误 birth identity：PID 复用场景（原 owner 已死、同 PID 新进程）。
  await writeFile(lock, JSON.stringify({ pid: process.pid, birthIdentity: "f".repeat(64) }), { mode: 0o600 });
  const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  const metadata = await registry.claim({ repositoryId: f.repositoryId });
  assert.match(metadata.instanceId, /^[a-f0-9]{32}$/);
  t.after(() => registry.release().catch(() => undefined));
});

test("无 owner 数据的旧格式 lock 仍按 TTL 兜底回收（向后兼容）", async (t) => {
  const f = await fixture(t);
  const dir = join(f.commonDir, ".pi-coordinator");
  await mkdir(dir, { recursive: true });
  const lock = lockPathOf(f);
  await writeFile(lock, "legacy", { mode: 0o600 });
  // 把 mtime 回拨到 60 秒前。
  const past = new Date(Date.now() - 60_000);
  await utimes(lock, past, past);
  const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  const metadata = await registry.claim({ repositoryId: f.repositoryId });
  assert.match(metadata.instanceId, /^[a-f0-9]{32}$/);
  t.after(() => registry.release().catch(() => undefined));
  const malformed = await fixture(t);
  const malformedLock = lockPathOf(malformed);
  await mkdir(join(malformed.commonDir, ".pi-coordinator"), { recursive: true });
  await writeFile(malformedLock, JSON.stringify({ pid: process.pid, birthIdentity: "invalid" }), { mode: 0o600 });
  await utimes(malformedLock, past, past);
  const malformedRegistry = createCoordinatorRegistry({ commonDir: malformed.commonDir, stateRoot: malformed.stateRoot });
  assert.match((await malformedRegistry.claim({ repositoryId: malformed.repositoryId })).instanceId, /^[a-f0-9]{32}$/);
  t.after(() => malformedRegistry.release().catch(() => undefined));
});

test("无 owner 数据的新 lock（TTL 内）不被回收", async (t) => {
  const f = await fixture(t);
  const dir = join(f.commonDir, ".pi-coordinator");
  await mkdir(dir, { recursive: true });
  const lock = lockPathOf(f);
  await writeFile(lock, "legacy", { mode: 0o600 });
  const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  const racing = registry.claim({ repositoryId: f.repositoryId }).catch((error) => ({ error: String(error?.message ?? error) }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await stat(lock)).isFile(), true, "TTL 内的旧格式 lock 不得被删除");
  await rm(lock, { force: true });
  await racing;
  t.after(() => registry.release().catch(() => undefined));

  const malformed = await fixture(t);
  const malformedLock = lockPathOf(malformed);
  await mkdir(join(malformed.commonDir, ".pi-coordinator"), { recursive: true });
  await writeFile(malformedLock, JSON.stringify({ pid: process.pid, birthIdentity: "invalid" }), { mode: 0o600 });
  const malformedRegistry = createCoordinatorRegistry({ commonDir: malformed.commonDir, stateRoot: malformed.stateRoot });
  const pending = malformedRegistry.claim({ repositoryId: malformed.repositoryId });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await stat(malformedLock)).isFile(), true, "TTL 内格式非法的旧 lock 不得误判 mismatch 而删除");
  await rm(malformedLock, { force: true });
  await pending;
  t.after(() => malformedRegistry.release().catch(() => undefined));
});
