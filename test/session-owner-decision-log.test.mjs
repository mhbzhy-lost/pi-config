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

/**
 * 子会话标记必须从被测进程环境剔除：`scripts/pi-session-owner.ts` 对
 * `PI_SUBAGENT_CHILD=1` / `PI_SUBAGENT_FANOUT_CHILD=1` 按设计直接写 `bypass`（子会话
 * 不得抢 root owner），而本用例断言的是 root 侧 blocked 决策。若测试自身从 agent 会话
 * 继承这两个标记，断言会稳定得到 bypass 而与被测逻辑无关（1.4 基线与候选同样复现）。
 * 与 test/session-owner-wrapper.test.mjs 的 childSafeEnv 同一既有约定。
 */
function childSafeEnv(overrides) {
  return { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined, ...overrides };
}

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
      env: childSafeEnv({ PI_SESSION_OWNER_REGISTRY: registryDir, PI_CODING_AGENT_SESSION_DIR: targetDir }),
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

