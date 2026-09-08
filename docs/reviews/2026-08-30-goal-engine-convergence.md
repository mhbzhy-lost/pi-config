# Goal Engine 收口报告（2026-08-30）

## 结论

本轮不再扩展 Goal Engine 语义，也没有发现需要修改 production 的 Critical/Important 缺陷。当前 runtime 在 fresh Host 的主要闭环已通过；剩余失败属于测试 fixture 未构造生产必需的 Root Broker binding sidecar，按来源分类门禁不修 production fallback。

## 实测证据

| 场景 | 结果 |
|---|---|
| `goal-runtime-real-canary.integration.mjs` PASS→finalize | 通过；约 5.6–6.7s；资源债务为 0 |
| `goal-engine-obligation-runtime.integration.mjs` | 105/105 通过；约 37.2s |
| `goal-engine-local-convergence.integration.mjs` | 12/12 通过；约 14.5s |
| R10B suspension/resume/quarantine | 20/20 通过；约 3.8s |
| runtime/production-host/events | 67/67 通过；约 7.5s |
| 真实 Pi RPC Host 八工具探针 | 通过；exit 0；stderr 为空 |
| 全量 `npm test` | 652/652 通过 |

## 已分类失败

Root Broker restart failed-terminal canary 返回 `attention / OWNED_STOP_RECOVERY_UNAVAILABLE`。该 fixture 手工写入 `status.json` 和 `process-terminal.json`，但没有经过 production 的 `bindSpawn → persistGoalBindingAuthority` 调用链，也没有生成 `root-broker.goal-binding-authority.v1.json` sidecar。加入合法 sidecar 的同等复现返回 `observed` 并保留 exit proof=1，因此这是测试制造的数据，不是 production 可达异常。

并发加载多个 integration 文件曾出现一次 Promise pending cancellation；单文件及受控串行运行均通过，归类为测试器/并发 harness 现象。

## 运行现场

只读审计记录了 242 个历史/并行 worktree 条目，其中 preserved 110、unmanaged 28、cleanup-debt 1、dirty 7、active 1、sequencer 2、released 64；另有 28 个 identity-mismatch lease。Goal registry 为空。没有执行任何未经授权的删除、release、reanchor 或 raw worktree 操作。它们不能作为 fresh Host 收敛失败依据，需另由 owner CAS/受管 disposition 处理。

## 收口决策

- 设计冻结：不新增 generation、event、projection field、状态或 recovery 分支。
- `planned.v1` 兼容语义保持不变。
- `goal-runtime.v1` 继续保持 Manual Preview；auto-continuation 不在本轮实现。
- fixture 缺 sidecar 的失败保留为测试修复项，不增加 production 兼容逻辑。
- 后续只接受有 production provenance 的 Critical/Important 修复；其余进入已知限制清单。

本轮达到“有限 canary 收敛”标准，但由于历史 worktree 债务未获 owner 授权处置，不宣称整个本机运行现场已清零。
