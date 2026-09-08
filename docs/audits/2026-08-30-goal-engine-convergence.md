# Goal Engine 收敛审计（2026-08-30）

## 范围与方法

本次审计只读执行：`node scripts/worktree-lifecycle.mjs audit --json`，并读取 `.state/goal-engine/registry.json`、worktree lifecycle leases 的脱敏字段，以及本机进程表和进程 cwd。没有执行 release、preserve、reanchor、prune、reconcile --apply、raw git worktree 或任何删除操作。

## 观测结果

审计快照共 242 项：

| 分类 | 数量 | 结论 |
|---|---:|---|
| 主工作区 | 1 | dirty，属于当前工作区现场，不应纳入自动清理 |
| preserved | 110 | 有 owner，状态是保留而非故障；主要来自历史 typed-subagent workspace |
| unmanaged | 28 | 无 owner 的 subagent worktree，且对应 28 个 `WORKTREE_IDENTITY_MISMATCH` lease |
| cleanup-debt | 1 | `09d026b9-8f35-4faf-b57b-664af551cd84`，有 owner 但 release 留下债务 |
| dirty | 7 | 有 owner 的 dirty subagent worktree，需 owner/任务侧决定保留或释放 |
| active | 1 | `3a6d6d85-e97c-4e32-b5ac-c5714768ced8`，owner active |
| sequencer | 2 | `99c4b92b-3a75-4cf0-a9f0-3b81d81b9f80` 与 `f2ea9e6f-1a50-42d0-81e6-e042f7a88a0a`，均有 `CHERRY_PICK_HEAD` 且 dirty |
| released | 64 | 已释放的历史登记，未见当前活跃资源 |

按来源路径计数：`.state/subagent-dispatch` 196 项、`.state/goal-engine` 15 项、lifecycle leases 28 项、其他 3 项。Goal Engine registry 当前为空（`active_goal_ids: []`、`goals: {}`），因此没有证据表明这些债务属于一个当前活跃 Goal。

Lease 目录共有 213 个 owner 记录：196 个 `typed-subagent-workspace`、17 个 `goal-engine`；其中 119 preserved、64 released、29 active、1 cleanup-debt。审计结果中的 28 个 unmanaged 与 28 个 `WORKTREE_IDENTITY_MISMATCH` lease 一一对应，表现为登记存在但当前 worktree 无 owner 事实。

## 进程观察

观察时存在两个 Goal Engine 集成测试进程：PID 98382（`node --test --test-timeout=15000 test/goal-engine-extension.integration.mjs`）和 PID 47771（timeout 5000 的同一套件）；另有 Pi 进程 PID 97551（cwd 为本仓库）、PID 8734（cwd 为本仓库的长期进程）及 PID 23364（cwd 为 `/Users/mhbzhy`）。这些进程是外部运行现场，未尝试中断或推断其 Goal 归属。运行中的测试/ Pi 进程意味着当前快照不是“空闲 Host”基线，不能据此授权清理或判定 production 缺陷。

## 来源分类门禁

* **已证实的生产可达异常：尚未发现。** 当前 Goal registry 无 active goal；没有观察到可由合法 Goal public/typed 入口产生的 active Goal 证据。
* **测试/历史 fixture：高度可能（但不对每项作强断言）。** 大量 preserved/released subagent worktree、不同历史 baseCommit，以及成批 Goal Engine 测试路径说明其主要来源是历史测试和子代理运行现场；这类数据应按 fixture/harness 或历史现场处理，不能增加 production fallback。
* **来源未证实：28 unmanaged + 28 identity-mismatch leases。** 它们没有 owner 事实，不能安全自动修复；在完成 provenance（创建入口、owner CAS、事件顺序、资源事实）前必须 fail closed，并保留现场。
* **需要任务侧确认：7 dirty、2 sequencer、1 active、1 cleanup-debt。** 这些条目有 owner 或明确 Git 状态，不能仅凭 TTL、clean 状态或 doctor 输出处置。

## 可恢复建议（只读结论）

1. 以当前快照作为 baseline，先等待/确认 PID 98382、47771 及本仓库 cwd 的 Pi 进程是否结束；在测试运行期间不要做 lifecycle mutation。
2. 对 1 active、2 sequencer、7 dirty 和 1 cleanup-debt，要求 owner 通过 typed disposition 或受管 lifecycle CLI 提供 CAS/terminal 证据；未经授权不 release/preserve/reanchor。
3. 对 28 unmanaged/identity-mismatch，建立逐项 provenance 清单；若只能证明是历史 fixture，再由测试 harness 或受管 cleanup 流程处理，禁止为 production 增加兼容分支。
4. fresh Host、fresh state root、无并行 Pi/测试进程的重复 audit 才能作为 Goal Engine 收敛验收基线；本次快照仅证明当前现场存在大量历史债务，不能作为收敛通过。
