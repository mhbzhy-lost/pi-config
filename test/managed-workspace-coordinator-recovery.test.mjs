import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createIntegrationQueue } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";

// daemon 形态下 listener 生命周期 = 进程生命周期（收缩已移除）；本文件验证
// 统一 idle 快照（引用计数归零判定依据）与陈旧 socket 回收。

test("clean listen exposes an all-zero idle snapshot and close unlinks the endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const endpoint = path.join(root, "coordinator.sock");
  const server = createCoordinatorServer({ endpoint, repositoryId: "a".repeat(64) });
  await server.listen();
  assert.equal(server.server.listening, true);
  assert.deepEqual(server.idleSnapshot(), { clients: 0, active: 0, retained: 0 }, "无连接无在途时统一 idle 快照全零");
  await server.whenStartupReady();
  assert.equal(server.isStartupReady(), true, "listen 完成即 startupReady");
  await server.close();
  assert.equal(server.server.listening, false);
});

test("retained queue or git activity is reflected in the idle snapshot until released", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const server = createCoordinatorServer({ endpoint: path.join(root, "coordinator.sock"), repositoryId: "a".repeat(64) });
  await server.listen();
  const release = server.beginActivity();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.idleSnapshot().retained, 1, "在途活动保留期间快照非零，归零退出被阻");
  assert.equal(server.server.listening, true, "listener 生命周期不受 idle 影响（收缩已移除）");
  release();
  assert.equal(server.idleSnapshot().retained, 0);
  await server.close();
});

test("stale UNIX socket is reclaimed while a live socket is preserved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const endpoint = path.join(root, "coordinator.sock");
  await writeFile(endpoint, "stale");
  const server = createCoordinatorServer({ endpoint, repositoryId: "a".repeat(64), idleGraceMs: 1000 });
  await server.listen();
  assert.equal(server.server.listening, true);
  await server.close();
});
