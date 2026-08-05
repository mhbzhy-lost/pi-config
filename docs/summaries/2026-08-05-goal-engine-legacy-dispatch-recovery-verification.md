# Goal Engine 历史派发事故恢复验证摘要

日期：2026-08-05  
候选范围：`f8c5664..d6ce365`  
结论：**Goal Engine 候选 Ready；尚未部署，不能据此宣称 production-ready。**

## 1. 修复范围

本轮针对历史派发导致 projection 与 Git Executor 资源分叉的问题，完成以下门禁：

- 历史不安全 task contract 在 workspace allocation 前拒绝，失败保持零状态副作用。
- `goal_settle(succeeded)` 只接受 exact attempt、persisted lease、live branch/worktree、clean 且非空的授权 commit range，并持久绑定 `executorHead`。
- inspection、durable event 与 destructive cleanup 之间增加复验；preserved cleanup 在底层释放 primitive 内执行最终 identity/clean fence。
- orphan inventory 只检查 exact attempt，不扫描目录；返回 `none | verified | unverified`，资源证据使用 `true | false | null`。
- `goal_status`、`goal_dispatch`、`goal_amend` 复用 orphan 门禁；verified orphan 提供人工 `discard | preserve` 选择，unverified 不提供 destructive choice。
- orphan recovery event 先持久化，再执行 disposition；preserved release event 只在资源清理并确认后追加。
- preserved workspace 可通过 typed `goal_integrate(discard)` 显式释放并恢复后续 dispatch/amend。
- 历史 v1/v2 replay、schema 单向升级、DAG、accepted/active task 保护继续生效。

## 2. Skill TDD 与压力验证

### 第一轮

- 无新增指导基线：`/tmp/using-goal-engine-orphan-baseline.md`。
- 结果：Agent 拒绝 raw Git，但错误地自行“优先 preserve”，暴露人工多选边界缺口。
- RED：`ffa8d7a`，新增 orphan、`.state` 与手工资源清理契约。
- GREEN：`6452a60`、`65f6d2e`、`f9513c1`。
- 压力复验：`/tmp/using-goal-engine-orphan-green-pressure.md`。
- 结果：仍自动选择 `preserve`，第一轮行为验证失败，未视为完成。

### 第二轮

- RED：`785c6f5`，冻结 generic authorization、deadline、默认 preserve 与提问停止边界。
- GREEN：`d6ce365`。
- 压力复验：`/tmp/using-goal-engine-orphan-green2-pressure.md`。
- 结果：Agent 先 `goal_status`；面对 `requiredNextAction:null` 与多个 choices，明确向用户询问 `discard` 或 `preserve`，随后结束轮次；回复前不调用 `goal_integrate`。

Skill 最终明确：

- 不提交 `.state`，不对 `.state` 执行 `reset` / `restore`。
- 不用 shell/CLI 手工删除 lease、worktree、branch。
- 遇到 `Origin must be clean` 或 `Executor workspace already exists` 时停止 raw Git 修复并调用 `goal_status`。
- verified orphan 多选只能由人类明确决策；`preserve` 不是默认安全动作。
- unverified orphan 只回到 `goal_status`；未释放 preserved resources 的唯一机器动作是 `goal_integrate(discard)`。

## 3. 验证结果

### Skill discovery

命令：

```bash
node --test test/using-goal-engine-skill.test.mjs test/skill-list.test.mjs test/skill-whitelist-extension.test.mjs
```

结果：**27 pass / 0 fail / 1 skip**。真实 Pi loader 成功发现 Git 管理的 `using-goal-engine` Skill。

独立 worktree 首次运行因未初始化 `vendor/superpowers` 与缺少本地 Pi package 安装失败；初始化受跟踪 submodule，并只读复用当前安装的 `pi/npm/node_modules` 后通过。该前置问题未通过产品代码掩盖。

### Doctor 与 exact-seven ABI

命令：

```bash
npm run doctor
```

结果：**OK**。Doctor 报告 Skill allowlist 与 Root subagent broker ready；仅保留既有能力限制 warning。

Goal Engine ToolDefinition 仍精确为七个：

- `goal_init`
- `goal_status`
- `goal_dispatch`
- `goal_settle`
- `goal_integrate`
- `goal_accept`
- `goal_amend`

没有增加 workspace tool、CLI mutation 或新 `goal_*` 名称。

### 冻结 Goal Engine 回归

命令：

```bash
node --test \
  test/goal-engine-audit.test.mjs \
  test/goal-engine-dispatch.test.mjs \
  test/goal-engine-events.test.mjs \
  test/goal-engine-extension.test.mjs \
  test/goal-engine-graph.test.mjs \
  test/goal-engine-runtime.integration.mjs \
  test/goal-engine-store-concurrency.test.mjs \
  test/goal-engine-workspace.test.mjs
```

结果：**310 pass / 0 fail**。

覆盖真实 Git repository/worktree/branch/commit/ref/sequencer、event-store 多进程并发、historical replay、settle/disposition race、orphan inventory/recovery、preserved release 与 destructive primitive fence。

### 全仓基线比对

命令：

```bash
npm test
```

Goal-only 候选独立 worktree结果：**1582 tests；1576 pass / 5 fail / 1 skip**。

失败名称与既有非 Goal Engine 基线重合：

1. `installed launch arguments keep project child agents outside fanout hierarchy`
2. `default plan runner bootstraps from a delayed real broker grant without PI_PLAN roots`
3. `cleaned tool result lookup releases the durable dispatch for a new Executor tool call`
4. `blocks rm targets outside the workspace and permits known workspace paths`
5. `retains exact subagent dependency ownership in Pi package management`

既有第六项 socket path/permission 失败在本次环境中未复现，不能因此宣称该独立问题已修复。第 5 项在独立 worktree 中还包含未生成 `pi/npm/package.json` 的环境前置差异。以上失败均未写成 GREEN；最终部署前仍需在冻结部署候选上重新运行并归因。

### Diff 检查

```bash
git diff --check f8c5664..d6ce365
```

结果：通过。

## 4. 独立审查

- Task 5 Round 1：`/tmp/goal-engine-incident-task5-review-agent-output.md`，发现 preserved cleanup 最终 TOCTOU Important，已按 bug-first/TDD 修复。
- Task 5 Round 2：`/tmp/goal-engine-incident-task5-review-round2-agent-output.md`，Critical/Important/Minor 均为 0，Ready。
- Task 6 累计最终审查：`/tmp/goal-engine-incident-cumulative-final-review.md`，范围 `f8c5664..d6ce365`，Critical/Important/Minor 均为 0，Ready。

外部 provider 因缺少 `ANTHROPIC_API_KEY` 未运行成功；未把 provider 不可用或 timeout 计为批准。上述结论来自独立本地 reviewer、完整源码状态链审查与真实回归证据。

## 5. Plan Runner 隔离说明

Plan Supervisor 双分支整合与 wake-debt 修复保存在独立候选 `02c4151`：

- merge：`7e91595`
- bug doc：`0f66441`
- RED：`377d232`
- fixture oracle：`7051977`
- GREEN：`02c4151`
- 定向回归：285/285
- Round 2：`/tmp/plan-supervisor-task6-merge-review-round2.md`，Ready

按用户最新要求，该 Plan Runner 候选**不进入本次 Goal Engine 部署候选**。Goal Engine 任务结束后，将先创建 Plan Runner 状态存档分支，再从当前主线移除 Plan Runner 代码，单独验证和提交。

## 6. 未执行与剩余门禁

- 已消费的 one-shot Plan Harness 未重跑。
- 未直接编辑 Goal JSONL/projection，未手工删除 TokenRec lease/worktree/branch。
- TokenRec `.state/goal-engine/**` 在本阶段保持只读。
- `refs/recovery/goal-engine/tokenrec-20260805-state-v5` 未移动或删除。
- 尚未将候选部署到实际 `main`，也未 `/reload`。
- 尚未创建 Executor recovery ref，未执行 typed orphan discard，未 amendment 或 attempt-2 canary。

因此当前结论仅为：**Goal Engine 部署候选通过 Task 6；Task 7 的授权部署、真实 Host exact-seven 验证与 TokenRec typed canary 仍是 production-ready 的必要条件。**
