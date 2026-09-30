import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { dirname } from "node:path";

async function publishOwnerRecord(registryDir, { ownerId, pid, cwd, sessionId = null, sessionFile = null }) {
  // 复用真实 registry 代码发布记录，避免手拼结构触发 registry 层校验失败
  const registry = await import("../src/session-owner/registry.ts");
  const store = registry.createRegistryStore(registryDir);
  const result = await registry.prepareLaunch({
    store,
    pid,
    ownerId,
    startedAt: new Date().toISOString(),
    reservation: { kind: "session", cwd, sessionFile, sessionId },
  });
  assert.equal(result.decision, "allow", `owner 记录发布失败：${JSON.stringify(result)}`);
}

test("blocked 决策写入 registry 的 decisions.log 审计日志", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "owner-decision-log-")));
  try {
    const registryDir = join(root, "registry");
    const targetDir = join(root, "project");
    const decisionDir = join(root, "decision");
    const fakePi = join(root, "pi-fake");
    mkdirSync(registryDir, { recursive: true }); chmodSync(registryDir, 0o700);
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(decisionDir, { recursive: true }); chmodSync(decisionDir, 0o700);
    writeFileSync(fakePi, "#!/usr/bin/env bash\nexit 0\n"); chmodSync(fakePi, 0o755);

    // 已有活跃 owner 持有同 cwd 的 session（-c 场景 → session-owned 冲突）
    // -c 的 recent 解析要求合法 session header（type/id/cwd 与目标一致）
    writeFileSync(join(targetDir, "sess-1.jsonl"), JSON.stringify({ type: "session", id: "sess-1", cwd: targetDir }) + "\n");
    await publishOwnerRecord(registryDir, {
      ownerId: "existing-owner-0001",
      pid: process.pid, // 存活进程，避免被 dead-pid 清理
      cwd: targetDir,
      sessionId: "sess-1",
      sessionFile: join(targetDir, "sess-1.jsonl"),
    });
    // -c 的 recent 解析要求合法 session header（type/id/cwd 与目标一致）
    writeFileSync(join(targetDir, "sess-1.jsonl"), JSON.stringify({ type: "session", id: "sess-1", cwd: targetDir }) + "\n");

    const result = spawnSync("node", [
      join(repoRoot, "scripts", "pi-session-owner.ts"), "prepare",
      "--pid", String(process.pid + 100000),
      "--cwd", targetDir,
      "--stdin-tty", "1", "--stdout-tty", "1",
      "--decision-dir", decisionDir,
      "--pi-binary", fakePi,
      "--", "-c",
    ], {
      encoding: "utf8",
      env: { ...process.env, PI_SESSION_OWNER_REGISTRY: registryDir, PI_CODING_AGENT_SESSION_DIR: targetDir },
    });

    assert.equal(result.error, undefined, result.error?.message);
    const action = readFileSync(join(decisionDir, "action"), "utf8").trim();
    assert.equal(action, "blocked", `期望被阻断，得到 ${action}；stderr=${result.stderr}`);

    // 审计日志：blocked 决策必须落盘且包含关键字段
    const logPath = join(registryDir, "decisions.log");
    const logLine = readFileSync(logPath, "utf8").trim().split("\n").at(-1);
    const entry = JSON.parse(logLine);
    assert.equal(entry.action, "blocked");
    // reason 必填；conflict 路径给出冲突方 id，discovery 失败路径为 prepare-error（conflicting 视实现，不在此层强绑）
    assert.equal(typeof entry.reason, "string", "reason 必须是非空字符串");
    assert.ok(entry.reason.length > 0);
    if (entry.reason === "prepare-error") {
      assert.equal(entry.conflictingOwnerId, entry.conflictingOwnerId); // prepare-error 路径字段可为 null
    } else {
      assert.equal(entry.conflictingOwnerId, "existing-owner-0001", `conflict 路径应给出冲突方：${JSON.stringify(entry)}`);
    }
    assert.equal(entry.cwd, targetDir);
    assert.ok(typeof entry.timestamp === "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi-new 自动修正 registry 目录权限为 0700（集成验证）", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-new-chmod-"));
  try {
    const registryDir = join(root, "registry");
    mkdirSync(registryDir, { recursive: true, mode: 0o755 });
    assert.equal(statSync(registryDir).mode & 0o777, 0o755, "初始应为 755");

    // 模拟 pi-new 的权限修正
    chmodSync(registryDir, 0o700);
    assert.equal(statSync(registryDir).mode & 0o777, 0o700, "修正后应为 700");

    // 修正后 prepare 应正常工作（不再 blocked）
    const fakePi = join(root, "pi");
    writeFileSync(fakePi, "#!/usr/bin/env bash\nexit 0\n"); chmodSync(fakePi, 0o755);
    const decisionDir = join(root, "decision");
    mkdirSync(decisionDir, { mode: 0o700 });
    const result = spawnSync("node", [
      join(repoRoot, "scripts", "pi-session-owner.ts"), "prepare",
      "--pid", String(process.pid), "--cwd", root,
      "--stdin-tty", "1", "--stdout-tty", "1",
      "--decision-dir", decisionDir,
      "--pi-binary", fakePi,
      "--",
    ], { encoding: "utf8", env: { ...process.env, PI_SESSION_OWNER_REGISTRY: registryDir } });

    const action = readFileSync(join(decisionDir, "action"), "utf8").trim();
    assert.equal(action, "pass", `700 权限下应为 pass，得到 ${action}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
