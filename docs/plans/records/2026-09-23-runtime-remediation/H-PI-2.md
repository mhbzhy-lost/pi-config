# H-PI-2：真实 `worktree:true` Host E2E 验收报告

**状态：已完成（本报告为独立验收证据）**

**日期：** 2026-09-28
**执行者：** 主 agent inline（子任务两次失败后接管；见下方执行历史说明）

## 执行环境

| 项目 | 值 |
|---|---|
| Pi 二进制 | `/opt/homebrew/bin/pi` |
| Pi 版本 | `0.85.1`（支持矩阵内） |
| Node | `v26.8.1` |
| HEAD | `ab4a88a docs(runtime): 更新统一 DAG 完成状态与根因记录` |
| 测试文件 | `test/pi-subagents-project-workflow.integration.mjs` |
| 测试名 | `project typed worktree commit completes Auto Integration and release` |

## 实际命令与结果

```bash
PI_REAL_BIN=/opt/homebrew/bin/pi node --test \
  --test-name-pattern='project typed worktree commit' \
  test/pi-subagents-project-workflow.integration.mjs
```

```text
✔ project typed worktree commit completes Auto Integration and release (12168.758ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
EXIT_CODE=0
```

完整原始输出见下方附录。

## 测试断言覆盖

测试代码位于 `test/pi-subagents-project-workflow.integration.mjs`，断言覆盖：

### 分配与绑定
- public `subagent` dispatch 返回 `workspace_id`、`lease_id`、`dispatch_cwd`
- `dispatch_cwd !== projectRoot`
- `dispatch_cwd` 位于 fixture `PI_CODING_WORKSPACE_DIR` 下的 managed worktree 路径
- Root Broker proof `binding.runId === handle.runId`
- `binding.asyncDir === handle.asyncDir`
- `binding.agentProfile === "executor"`

### 真实 child commit
- child 通过 production 注入的 `bash` 工具修改 `README.md` 并 `git add/git commit`
- 测试父进程不手工写入或提交 child 变更
- 不手工调用 `ensureAllocated/bindRun/prepareAutoIntegration/recordTerminalProof/subagent_integration`

### 终态证明
- `proof.terminal.proof.instances.length > 0`
- `proof.terminal` 非 null（依赖 `145c25a` 修复：standalone run 不再被 Goal 门禁隐藏）

### 完成与集成结果
- child `status.json` state 为 `complete`
- origin `README.md` 包含 `PROJECT_TYPED_CHILD_COMMIT` marker
- origin `git status --porcelain` 为空（origin clean）

### 关于逐阶段断言的说明

Reviewer 建议显式断言 admission/rebase/publish/release 的中间状态。当前测试通过 origin clean + README marker 间接证明 publish 已完成（Auto Integration 的 fast-forward 是 origin 更新的唯一路径），terminal proof 非空证明 proof 链完成。workspace release 由 production coordinator 的 proof→discard 链自动执行（`coordinator-server.ts:296-304`）。若后续需要逐阶段审计，可扩展测试读取临时 state 的 `auditManagedWorkspaces` 输出。

## 前置依赖修复

本 E2E 暴露并修复了两个生产缺陷：

1. `ddcf487`：`preserve_integration_debt` 协议拒绝合法 `reason`（协议层字段校验与 production caller 不一致）
2. `145c25a`：`executorProofSnapshot` 用 Goal 授权门禁 terminal proof 可见性（standalone run 的 `authorization.goal` 永远为 null，terminal 永远不可见）

## 执行历史说明

| 尝试 | 执行者 | 结果 | 说明 |
|---|---|---|---|
| 1 | executor 子任务 `8c3caf68` | NEEDS_CONTEXT | 因 DAG 路径澄清等待超时，未运行测试（metadata 记录 not-run） |
| 2 | executor 子任务 `76779a30`（resume） | 超时失败 | 已取得 RED、扩展 provider，但 GREEN 阶段超时（acceptance report fixture 缺失） |
| 3 | 主 agent inline | **通过** | 修复 acceptance report fixture + 发现并修复 terminal proof Goal 门禁缺陷 |

子任务 metadata 的 `not-run` 来自第 1 次尝试，不代表最终结果。本报告的第 3 次执行由主 agent 在本 session 中直接运行并归档输出。

## 残留

- 同文件 `hostile-legacy` 与 `rename-canary` 测试为预存断裂（A2 删除 `workflow` 字段后 fixture 未迁移），不属 H-PI-2 范围
- attention lane / supervisor transport 仍为 `environment-constrained`（E-PI-ISOLATION 保持 blocked）

## 附录：完整测试输出

```text
✔ project typed worktree commit completes Auto Integration and release (12168.758ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12242.748334
```
