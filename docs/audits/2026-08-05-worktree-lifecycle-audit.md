# pi-config Worktree 生命周期审计（2026-08-05）

## 审计边界

- 全程只读：未执行 `git worktree remove/prune/lock/unlock`，未删除目录、branch、lease 或状态。
- 口径：`/Users/mhbzhy/pi-config` 的 `git worktree list --porcelain`；TokenRec 等外部仓库不计入本报告。
- 判定证据：worktree path/HEAD/branch、`git status --porcelain`、`merge-base`、`git cherry main <HEAD>`、Git lock/prunable 标志、Pi/Node 进程 cwd、磁盘占用。
- “待授权回收”只表示可在再次复验后移除 linked worktree；本报告不授权删除 branch。

## 结论摘要

| 分类 | 数量 | 当前结论 |
|---|---:|---|
| 主工作树 | 1 | 明确保留；`pi/settings.json` 是用户本地修改 |
| 普通 clean worktree | 77 | 无进程 cwd、无锁、无 Goal lease；可进入一次性 worktree-only 回收批次，但因缺 owner manifest 仍需明确授权 |
| 受保护 clean worktree | 1 | `fix/plan-supervisor-bound-wake` 历史候选，先保留 |
| 仅生成物脏 | 8 | 唯一变化是 `pi/npm` 指向主仓安装目录的 symlink；精确复验后可先去生成物再按 clean 流程处理 |
| 实质脏 worktree | 6 | 含未提交源码或文档，禁止删除；先保留或建立 recovery snapshot |
| 未完成 Git 操作 | 1 | `integrate/goal-plan-production-candidate` 有未完成 merge 和大量变更，禁止删除/abort |
| **总计** | **94** | 1 个主工作树 + 93 个 linked worktree |

93 个 linked worktree 合计约 **1.78 GiB**。其中 78 个 clean worktree 约 1.49 GiB；8 个仅生成 symlink 的 worktree约 124 MiB；7 个实质脏或 sequencer worktree 约 170 MiB。

当前没有进程 cwd 位于 `/private/tmp/pi-config-*`；没有 worktree 带 `locked` 或 `prunable` 标志；本仓不存在 `.state/goal-engine` lease。瞬时无进程不是 ownership 证明，因此回收器不能仅凭 TTL 或进程缺失自动删除。

另外，系统临时目录存在 **52,613** 个 `ge-ws-*`/`ge-ext-*` 测试 fixture，约 **6.46 GiB**。它们不是这 94 个 worktree 的组成部分，但证明测试 teardown 也存在独立泄漏。

## 可执行分组

### A. 一次性 worktree-only 回收候选（77）

这些 worktree 当前 clean、无可见使用者。建议第一阶段仅移除 worktree，**保留所有 branch/ref**；不要把 branch 清理与磁盘回收绑定。再次执行前必须逐项复验 path、HEAD、branch、clean、sequencer、owner/lease 和进程 cwd。

其中 50 个 branch 的 commit 已被 `main` 包含或全部具有 patch-equivalent；另 27 个仍有 `git cherry` 判定的独有 patch，故其 branch 必须保留。

### B. 仅生成物脏（8）

八项的唯一未跟踪内容均为 `pi/npm -> /Users/mhbzhy/pi-config/pi/npm`。它是安装期复用 symlink，不是任务成果；仍需由受控迁移器精确核对“只有这一项且 target 完全一致”，然后才能清除 symlink 并执行无 `--force` 的 worktree removal。

### C. 禁止自动清理（9）

- 当前主工作树。
- `fix/plan-supervisor-bound-wake` attached worktree：历史候选保留约束。
- 六个含未提交源码/文档的 worktree。
- 一个存在未完成 merge 的 production combined candidate。

### D. 外部活跃 Goal

TokenRec 属于另一仓库和另一协调会话，进程快照显示其 Goal Engine worktree 正在被 Pi/Node 使用。本审计没有读取、修改或处置其 registry、lease、branch、worktree；统一回收方案也必须按 originRoot 隔离，禁止跨仓扫描后删除。

## 当前创建者矩阵

| 创建者 | 是否创建 linked worktree | 当前回收 | 缺口 |
|---|---|---|---|
| Goal Engine `goal_dispatch` | 是；`allocateExecutorWorkspace()` 调用 `git worktree add -b` | `goal_integrate(integrate/discard)` 释放 worktree、branch、lease；`preserve` 显式保留；dispatch 后续失败有补偿 | `worktree add` 成功而 lease 写入失败的窗口没有 durable intent；没有跨 Goal 的 cleanup-debt 总览 |
| typed `subagent` / `pi-subagents` | 否 | 只管理子进程、会话和 artifact | 接受调用方给定 cwd，不拥有 cwd 对应 Git 资源 |
| Root Broker / Supervisor | 否 | 管进程 ownership、关闭、terminal proof 和重试债务 | 不应扩权为 Git worktree 回收器 |
| 历史手工 Agent 协调 | 是；通过 shell 直接 `git worktree add /private/tmp/...` | 无统一回收 | 这是本仓 93 个 linked worktree 的主要来源 |
| Goal Engine 单元/集成测试 | 在独立临时 Git repo 中创建 | 测试内验证局部 release | fixture 根目录没有统一 `after()`，累计 52,613 个临时目录 |
| 已退役 Plan Runner | 当前 `main` 不再创建 | 无现行入口 | 现存 `pi-config-plan-runner/*` 只是历史遗留 worktree |

## 逐项清单

| 分类 | Path | Branch | HEAD | Dirty | `git cherry` 独有 patch |
|---|---|---|---|---:|---:|
| 保留：主工作树 | `/Users/mhbzhy/pi-config` | `main` | `4f773b9e4445` | 1 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-event/task-tool-descriptions` | `agent/ge-tool-usage-descriptions` | `0a1113c102cf` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-event/task2-dispatch-ack` | `agent/ge-event-dispatch-ack` | `3b7a41f1ed8f` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-event/task2-dispatch-ack-fix` | `agent/ge-event-dispatch-ack-fix` | `c8615b4eac04` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-event/task3-final-accept` | `agent/ge-event-final-accept` | `0af7167fb7bd` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-event/task3-final-accept-fix` | `agent/ge-event-final-accept-tests` | `99d07939d8c3` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-event/task4-v1-dispatch` | `agent/ge-event-v1-dispatch` | `456afda447fb` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-event/task6-evidence` | `agent/ge-event-evidence` | `06df4ccd81f1` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-hardening/coordinator` | `agent/goal-engine-hardening` | `db9387fb12ff` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-recovery` | `docs/goal-engine-incident-recovery` | `61ab540b4c45` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task1` | `fix/goal-engine-legacy-dispatch-preflight` | `9d5bc6b0dc3e` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task2` | `feat/goal-engine-amend-workflow` | `0f96e7061189` | 0 | 0 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-incident-task3` | `fix/goal-engine-settle-commit-gate` | `b45dad8f8096` | 0 | 1 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task3-redo` | `fix/goal-engine-settle-gate-redo` | `2e04a110da83` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task3a` | `fix/goal-engine-workspace-inspection` | `41abf855554c` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task3b` | `fix/goal-engine-settle-handler-gates` | `b44d61c7a2e9` | 0 | 0 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-incident-task3c` | `fix/goal-engine-settlement-head-binding` | `cc4a9b0bc147` | 0 | 3 |
| 禁止：实质脏 | `/private/tmp/pi-config-goal-engine-incident-task3c-redo` | `fix/goal-engine-settlement-head-binding-redo` | `dad50321d4a6` | 2 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task3c-redo2` | `fix/goal-engine-settlement-head-binding-redo2` | `1ca284e2a738` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task3c-remediation-fix` | `fix/goal-engine-settle-race-remediation` | `2e04a110da83` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task3c-review-fix` | `fix/goal-engine-inspection-race-error-contract` | `1894c18447bb` | 0 | 0 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-incident-task4-orphan-inventory` | `feat/goal-engine-orphan-inventory` | `dd005a70c962` | 0 | 3 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-incident-task4-orphan-inventory-redo` | `feat/goal-engine-orphan-inventory-redo` | `081cb0fd2e51` | 0 | 2 |
| 禁止：实质脏 | `/private/tmp/pi-config-goal-engine-incident-task4a-inventory-tests` | `test/goal-engine-orphan-inventory-red` | `4e8acb4b82d2` | 1 | 0 |
| 禁止：实质脏 | `/private/tmp/pi-config-goal-engine-incident-task4a-inventory-tests2` | `test/goal-engine-orphan-inventory-red2` | `7a4754cc7d4e` | 1 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task4a-inventory-tests3` | `test/goal-engine-orphan-inventory-review-red2` | `d7230859b444` | 0 | 0 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-incident-task4a-orphan-inventory-redo2` | `feat/goal-engine-orphan-inventory-redo2` | `8b7085944dd7` | 0 | 3 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-incident-task4a-red-verifier` | `verify/goal-engine-orphan-inventory-red` | `365f01174a33` | 0 | 1 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task4b-review-fix` | `fix/goal-engine-orphan-error-contract` | `4f008b038fab` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task4b-status-green` | `feat/goal-engine-orphan-status-gate` | `9744b3937ace` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task4b-status-red` | `test/goal-engine-orphan-status-red` | `018f8c0c01d8` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5-review-fix` | `fix/goal-engine-preserved-cleanup-fence` | `212cfbe27d78` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5a-events-green` | `feat/goal-engine-orphan-recovery-events` | `d669edf35588` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5a-events-red` | `test/goal-engine-orphan-recovery-events-red` | `847356c4fb45` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5b1-typed-green` | `fix/goal-engine-orphan-typed-adoption` | `c7c31fb18b20` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5b1-typed-red` | `test/goal-engine-orphan-typed-recovery-red` | `0a11b4202330` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5b2-preserved-green` | `fix/goal-engine-preserved-release` | `3d6f81312f56` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5b2-preserved-red` | `test/goal-engine-preserved-release-red` | `d561901d8194` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5b3-amend-green` | `fix/goal-engine-orphan-amend-gate` | `a5df4d042922` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task5b3-amend-red` | `test/goal-engine-orphan-amend-red` | `6e2d520f2e4b` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task6-skill-green` | `feat/using-goal-engine-orphan-recovery-guidance` | `f9513c1c0c2d` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task6-skill-green2` | `docs/using-goal-engine-human-choice-guidance` | `d6ce3659534e` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task6-skill-red` | `test/using-goal-engine-orphan-recovery-red` | `ffa8d7a58265` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-incident-task6-skill-red2` | `test/using-goal-engine-human-choice-red` | `785c6f57ad04` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e1` | `agent/ge-p0p1-e1` | `94654c59df11` | 0 | 0 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-p0p1/e1fix` | `agent/ge-p0p1-e1fix` | `27d8f1a0e08e` | 0 | 1 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-p0p1/e1fix2` | `agent/ge-p0p1-e1fix2` | `2a931208a3fa` | 0 | 1 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-p0p1/e1fix3` | `agent/ge-p0p1-e1fix3` | `949a744bae2a` | 0 | 1 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-goal-engine-p0p1/e1fix4` | `agent/ge-p0p1-e1fix4` | `7077e91ca828` | 0 | 1 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e5` | `agent/ge-p0p1-e5` | `390ee44fa7db` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e5atomic` | `agent/ge-p0p1-e5atomic` | `952fe91f354b` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e5identity2` | `agent/ge-p0p1-e5identity2` | `4bdbd9617c20` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e5lockfile` | `agent/ge-p0p1-e5lockfile` | `fc1b18b4028b` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e5pid` | `agent/ge-p0p1-e5pid` | `fbd73ec88d8a` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e5registry2` | `agent/ge-p0p1-e5registry2` | `ac8681caeb04` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/e5registry3` | `agent/ge-p0p1-e5registry3` | `7c8c49f194a1` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/w2` | `agent/ge-p0p1-w2` | `783ff0cf99b5` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/w2fix` | `agent/ge-p0p1-w2fix` | `1a052c720f53` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/w2fix2` | `agent/ge-p0p1-w2fix2` | `ab48110fe6e7` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/w2fix3` | `agent/ge-p0p1-w2fix3` | `3ba7c63fe121` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-goal-engine-p0p1/w2fix4` | `agent/ge-p0p1-w2fix4` | `316e33fa2f0d` | 0 | 0 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-goal-skill-combined` | `agent/goal-skill-combined` | `e5790d48fb79` | 1 | 0 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-goal-status-legacy-v2-replay` | `agent/goal-status-legacy-v2-replay` | `90b5bd8ade7a` | 1 | 0 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-goal-status-legacy-v2-review-fix` | `agent/goal-status-legacy-v2-review-fix` | `f8c5664f44dd` | 1 | 0 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-goal-tool-validation/init-preflight` | `agent/goal-tool-init-preflight` | `548356b54d6b` | 1 | 3 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-goal-tool-validation/init-preflight-tdd` | `agent/goal-tool-init-preflight-tdd` | `32f0f6c0cb3e` | 1 | 0 |
| 禁止：实质脏 | `/private/tmp/pi-config-plan-runner-removal/coordinator` | `remove/plan-runner` | `61ab540b4c45` | 1 | 0 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/attention-combined` | `agent/plan-supervisor-combined` | `744a378f288d` | 0 | 38 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/attention-dispose-fence` | `agent/plan-supervisor-dispose-fence` | `cc48a51b2c3a` | 0 | 33 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/attention-push-fix` | `agent/plan-supervisor-attention-persistence` | `d8705953ac0d` | 0 | 30 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/attention-push-fix-tdd` | `agent/plan-supervisor-attention-persistence-tdd` | `f3d491be97b0` | 0 | 32 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/attention-push-integration` | `agent/plan-supervisor-real-integration` | `01cc4ab0e357` | 0 | 32 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/attention-review-fixes` | `agent/plan-supervisor-review-fixes` | `ad89dc65a276` | 0 | 38 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/broker-fixture-fix` | `agent/plan-runner-broker-fixture-cwd` | `2017d057b42e` | 0 | 8 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/deepseek-thinking` | `agent/deepseek-review-thinking-control` | `fb18119d440f` | 0 | 16 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/entry-cleanup-fix` | `agent/plan-runner-entry-cleanup-race` | `35dbd95a23bd` | 0 | 6 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/external-review-toggle` | `agent/plan-external-review-toggle` | `372cb056712f` | 0 | 19 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/pi-deepseek-review` | `agent/plan-runner-pi-deepseek-review` | `49af9a8bb620` | 0 | 13 |
| 禁止：实质脏 | `/private/tmp/pi-config-plan-runner/review-none-contract` | `agent/external-review-none-contract` | `b85fa21d6342` | 2 | 22 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/shell-policy-fixture` | `agent/plan-runner-shell-policy-fixture` | `465d9665416a` | 0 | 10 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-plan-runner/task-1` | `agent/plan-runner-production-task-1` | `52c528caeda2` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-plan-runner/task-2` | `agent/plan-runner-production-task-2` | `ba86656bf0b7` | 0 | 0 |
| 待授权回收：clean/equivalent | `/private/tmp/pi-config-plan-runner/task-3` | `agent/plan-runner-production-task-3` | `65f42be82956` | 0 | 0 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/task-4` | `agent/plan-runner-production-task-4` | `3401af9b1301` | 0 | 2 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/task-5` | `agent/plan-runner-production-task-5` | `5593b21c41b9` | 0 | 4 |
| 禁止：实质脏 | `/private/tmp/pi-config-plan-runner/task-6` | `agent/plan-runner-production-task-6` | `c31fab8c246c` | 1 | 44 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/task6-supervisor-merge` | `integrate/plan-supervisor-task6` | `7e9159550174` | 0 | 46 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/task6-supervisor-wake-fix-doc` | `docs/plan-supervisor-bound-wake-race` | `0f66441e4efb` | 0 | 47 |
| 保留：受保护候选 | `/private/tmp/pi-config-plan-runner/task6-supervisor-wake-green` | `fix/plan-supervisor-bound-wake` | `02c4151c4a46` | 0 | 50 |
| 待授权回收：clean/保留 branch | `/private/tmp/pi-config-plan-runner/task6-supervisor-wake-red` | `test/plan-supervisor-bound-wake-red` | `377d232e3c55` | 0 | 48 |
| 禁止：未完成 merge | `/private/tmp/pi-config-production-combined-candidate` | `integrate/goal-plan-production-candidate` | `d6ce3659534e` | 82 | 0 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-using-goal-engine-review-discovery` | `agent/using-goal-engine-review-discovery` | `de058c0ee15d` | 1 | 0 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-using-goal-engine-review-lifecycle` | `agent/using-goal-engine-review-lifecycle` | `7e7d3d31f407` | 1 | 0 |
| 待复验：仅生成 symlink | `/private/tmp/pi-config-using-goal-engine-skill` | `agent/using-goal-engine-skill` | `94f57013d553` | 1 | 0 |

## 安全边界

1. 不对 Goal Engine 管理的资源运行 raw Git 清理；必须服从 `goal_status.requiredNextAction` 和 typed disposition。
2. routine cleanup 不使用 `--force`；dirty、sequencer、锁、owner 活跃、identity 不一致任一条件出现即 fail closed。
3. worktree removal 与 branch/ref 删除分开；第一阶段一律保留 branch。
4. `preserve`、archive、recovery refs 和用户本地配置永不受 TTL 自动删除。
5. 清理前后都生成 machine-readable inventory，并以 path + commonDir + branch + HEAD + owner token 做 CAS 复验。
