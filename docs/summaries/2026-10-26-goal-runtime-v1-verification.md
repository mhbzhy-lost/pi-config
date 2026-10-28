# Goal Runtime v1 聚焦验证报告

验证日期：2026-10-27。任务：T8 / `dispatch-11dbd8aa`。本报告记录当前未提交工作树的实测结果，不将 HEAD 当作全部交付代码已经提交的证明。

**结论：三份授权测试全部通过，合计 31/31，失败、取消、跳过、TODO 均为 0；root/package 类型检查通过。恢复引用链缺陷已由主会话安排修复，本执行代理复验通过。完整 F1–F10 生产终态仍存在下表明确列出的验证缺口，不能据本报告宣称真实 child 全链已经验收或建议立即启用。**

## 1. 版本、范围与证据分层

- 工作树基线 HEAD：`633a2af2c43ae4dbbe9a2dc1d88937d39353622a`。
- 实测：Node `v26.8.1`；physical Host `@earendil-works/pi-coding-agent@1.4.0`；`pi-subagents-enhanced@0.1.0`。未在最低 Node `22.19.0` 上复测。
- 既有 dirty 文件保持原样；本代理只创建三份测试和本报告，不修改生产文件、计划复选框或设置，不 stage/commit/push。
- 测试复用 `test/helpers/joint-upgrade-session.mjs` 的 SDK、离线合成 provider 和临时会话；RPC 沿用既有受限 env + 官方 `runRpcMode` 模式。临时仓库只运行 `git init`，新测试不运行真实 coding child，不建立新测试框架。
- 主管在本任务执行中明确裁决：允许 `PlanExecutionService` 接口形状的 adapter 边界双打，成组覆盖 pending/closed/unknown/manual/缺 proof 等组合；真实 child spawn、官方 proof 和 Auto Integration 链必须另记 blocked/未执行，不用双打冒充这些证据。
- Host 的 session、custom entry、磁盘核验、默认 compact 和 bash 检查使用真实实现。除首次模型调用和 RPC 模型场景外，部分工具场景通过真实 Host `getToolDefinition().execute` + `createToolContext()` 调用，因此不代表每个用例都经过模型参数校验/外层 tool hooks；检查命令本身经过真实 `ctx.executeTool('bash', …)`。
- RPC 1.4 没有原生 `get_tools` 或 `execute_tool` 协议。本测试使用测试专用 slash command 投影真实 registry，并经 `get_messages` 读取；另以合成模型调用测试工具，真实嵌套执行 direct `plan_status`。没有新增或声称存在这些 RPC 方法。

复验时，将以下文件按路径排序，计算每个文件 SHA-256，再对 `JSON.stringify([[path, sha256], …])` 计算 SHA-256：`src/goal-runtime/*.ts`、`pi/extensions/goal-runtime.ts`、`packages/pi-subagents-enhanced/src/execution/index.ts`、三份新测试。该明确范围的摘要为 `0531ab4bf0468bea237fca7e0c47bcc44aab31c79dd47c9ac1909db0eaf843d4`；不包含其他 package 内部实现，不能代替全仓树标识。

| 关键文件 | 复验时 SHA-256 |
| --- | --- |
| `src/goal-runtime/session-state.ts` | `4c7a7597c38665da6e9d43e57c98d91c9b62930c384597ddfc9542004e126a09` |
| `test/goal-runtime-contract.test.mjs` | `f134901eae3b32064ba424316e5738b831cbbab1beb185147e7b2081431cbae4` |
| `test/goal-runtime-runtime.integration.mjs` | `eb39b8bd7cc9611a177f13b11fd9d8bf8b8626dbb0a3d005d2f7b81943b99e17` |
| `test/goal-runtime-rpc.integration.mjs` | `9a97c8c78fc91c4428abd6773af835e298b09b42e16d0579600d35128ff0b623` |

## 2. 实际运行命令与统计

先完成副作用审计，再按 T8 顺序运行既有基线；新测试逐份创建、运行。发现恢复缺陷后停止并上报；主会话安排修复后，重新运行三份全套与类型检查。以下命令均实际运行，输出保存在本任务工具回执中。

| 命令 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 初始基线通过；恢复缺陷修复后再次通过，覆盖 root 与 package 两个 `tsc --noEmit` |
| `node --test --test-concurrency=1 test/subagent-execution-contract.test.mjs test/subagent-auto-integration-plan.test.mjs test/context-usage.test.mjs test/context-usage-extension.test.mjs test/context-usage.integration.test.mjs` | 22 tests，22 pass，0 fail，0 skipped |
| `node --test --test-name-pattern='publishable pinned package contract' test/pi-subagents-enhanced-package.test.mjs` | 1 test，1 pass，0 fail，0 skipped；仅所选元数据合同，不代表网络发布闭包 |
| `node --test --test-concurrency=1 test/managed-workspace-contract.test.mjs test/managed-workspace-terminal-proof-handoff.integration.mjs test/subagent-auto-integration-lifecycle.integration.mjs test/subagent-auto-integration-recovery.integration.mjs` | 29 tests，29 pass，0 fail，0 skipped；既有隔离 coordinator/process/workspace 与局部 lifecycle 回归，不等于 Goal child 全链 |
| `node --test test/goal-runtime-contract.test.mjs` | 独立首轮 9/9 通过，0 skipped |
| `node --test --test-concurrency=1 test/goal-runtime-runtime.integration.mjs` | 逐步构建时先 4/4、再 12/12；随后新增开关子项和加强带 receipt 的恢复用例，最终权威结果见全套命令 |
| `node --test --test-concurrency=1 --test-name-pattern='F10' test/goal-runtime-runtime.integration.mjs` | 测试设置时序修正后 6/6，通过四个子项及两个顶层用例，0 skipped |
| `node --test --test-concurrency=1 test/goal-runtime-rpc.integration.mjs` | 独立首轮 4/4 通过，0 skipped |
| `node --test --test-concurrency=1 --test-name-pattern='F5 新 Host' test/goal-runtime-runtime.integration.mjs` | 修复前稳定失败；详见缺陷记录。未删除、skip 或反转断言 |
| `node --test --test-concurrency=1 test/goal-runtime-contract.test.mjs test/goal-runtime-runtime.integration.mjs test/goal-runtime-rpc.integration.mjs` | **修复后最终全套：31 tests，31 pass，0 fail，0 cancelled，0 skipped，0 todo；约 12.26 秒** |
| `git diff --cached --name-only` | 空输出；无 staged 文件 |

最终全套按文件统计：

| 文件 | 顶层用例 | 子用例 | Node tests/pass | fail/skipped |
| --- | ---: | ---: | ---: | ---: |
| [契约测试](../../test/goal-runtime-contract.test.mjs) | 9 | 0 | 9/9 | 0/0 |
| [Host 测试](../../test/goal-runtime-runtime.integration.mjs) | 14 | 4（开关四态） | 18/18 | 0/0 |
| [RPC 测试](../../test/goal-runtime-rpc.integration.mjs) | 4 | 0 | 4/4 | 0/0 |
| 合计 | 27 | 4 | 31/31 | 0/0 |

`npm run verify:subagents-enhanced` 的网络 npm pack/install 发布闭包未执行。本轮没有调用真实/付费 provider，也没有读取真实凭据。

## 3. F1–F10 实证矩阵

表中 passed 只适用于写明的验证层；blocked 表示完整终态证据仍缺失，不是测试 skip。

| ID | 当前验证结论 | 现场实证与边界 |
| --- | --- | --- |
| F1 | **passed：绑定与拒绝合同** | [Host:71](../../test/goal-runtime-runtime.integration.mjs#L71) 从正常空持久会话经真实模型工具链首次 `plan_execute`，核验 sessionId/contractHash/真实 entry；同计划不重建、第二计划拒绝、自依赖拒绝、Inline 显式拒绝。[契约:57](../../test/goal-runtime-contract.test.mjs#L57) 验证缺终态与修复引用拒绝。[RPC:134](../../test/goal-runtime-rpc.integration.mjs#L134) 比对绑定与状态读回身份。run 仍属 adapter 边界，不能证明真实 child 已启动。 |
| F2 | **passed：Goal→真实 child→workspace→proof→Auto Integration→released 全链；并发边界仍未专项** | 本次真实 positive session `01a17e03-ebf0-71e0-9a35-790d7e6d7f4a` 中 A/B 顺序依赖成立；A/B 均真实 child、worktree、terminal proof、integration receipt、released，A accepted 后 B 才启动，最终 completed。多独立任务容量并行竞态仍未专项。 |
| F3 | **passed：真实检查和证据落盘；blocked：完整负向/官方证明链** | [Host:112](../../test/goal-runtime-runtime.integration.mjs#L112) running→verifying→accepted→completed；真实嵌套 bash 事件带 parentToolCallId；真实 evidence entry 的 `structuredContent.exit_code=0` 与 receipt 一致。检查不接受模型文案代替结果的生产实现被此正向路径消费；伪造完成字段经模型 schema 拒绝、旧候选 receipt 及检查期间漂移的完整负向矩阵本轮未专项执行。官方 run proof 由 adapter 双打供给。 |
| F4 | **passed：真实失败→blocked→plan_retry 修复闭环；typed resume 另有独立 receipt** | 真实 repair 场景取得 check exit 7，任务 blocked、workspace released；`plan_retry` 以 repairTaskIds 路径启动 attempt 2，修复后 exit 0、accepted、completed。真实 typed-resume 场景的新 PID 授权、workspace/queue 重绑和 intent completed 也已在 smoke 报告取证。 |
| F5 | **passed：C 已修复；真实 compact 跨 Host 恢复终验通过** | 最后一次真实 compact `tokensBefore=176707`→`estimatedTokensAfter=23854`；新 Host facts 可用，不再 `PLAN_EXECUTION_FACTS_UNAVAILABLE`，`plan_verify` 可用，计划 completed；run `8ac34982…` proof `f4a5d492…`、integration receipt `187a82a3…`、queue completed、workspace released。 |
| F6 | **blocked：D 修复在 DI 层成立，但真实 cancelled 替换链仍停滞** | 终验确认旧计划 terminal/released、取消后新 planId 和旧 entry 保留；新 child proof `0ff64b96…` 已生成，但新 queue `4bb42a2e…` 仍 queued、resume intent `7f58a0db…` pending、workspace active、Goal 为 `manual-integration/subagent-integration-handoff`。保留 ledger 的有界真实复现，下一轮继续归因修复；未人工 integrate 或伪造 completed。 |
| F7 | **passed：指定既有回归；blocked：Goal→通用 runtime 全链资源审计** | 22 项基线、29 项 workspace/proof outbox/lifecycle/recovery 回归及 package 元数据 1 项全部通过。根 feature 通过 `pi-subagents-enhanced/execution` 公开边界消费服务；新测试没有真实 Goal workspace/lease/publication。因此只能证明局部合同与既有回归，不能声称 Goal 实际 child 的资源释放和 Auto Integration 已整链验收。 |
| F8 | **passed：类型和本轮测试交付；blocked：完整计划验收** | root/package typecheck 通过；三份新增测试最终 31/31、零跳过；本报告记录所有层次与缺口。由于 F2–F7 仍有明确未验证组合，F8 所需的完整终态证据未齐；网络 package closure 未执行。 |
| F9 | **passed：观测迁移；边界见说明** | 既有三份 context usage 检查共 11 项通过，覆盖 unknown/高占用/schema/无提醒 hook。[Host:331](../../test/goal-runtime-runtime.integration.mjs#L331) 合成 provider 合法 usage 事件产生约 **94.606%** 占用，真实 Host `context_usage` 保留估计量/余量，无 handoff 字段、写文件提醒或路径；四态均验证。manual compact 成功是真实执行；threshold/overflow 失败为 runner 生命周期注入，未实际制造模型溢出。历史 handoff 文件未被测试删除或改写。 |
| F10 | **passed：真实入口四态、两阶段 gate、reload 与 RPC 两态** | [Host:331](../../test/goal-runtime-runtime.integration.mjs#L331) false/缺失/非法均 registered、active、callable 的 plan 集合为空，无 Goal entry/context/continuation；true 注册与激活五工具，callable 只有 direct `plan_status`，可执行计划。[Host:357](../../test/goal-runtime-runtime.integration.mjs#L357) factory true/session 权威 false 时注册仍存在但返回 `GOAL_SESSION_NOT_READY`，会话无 Goal 副作用；reload 关再开重读成功。[RPC:119](../../test/goal-runtime-rpc.integration.mjs#L119) 开启枚举与直读，[RPC:148](../../test/goal-runtime-rpc.integration.mjs#L148) 关闭零 plan 工具。错配不是“factory 关闭”的场景，不能把其已注册集合说成空。 |

契约拒绝矩阵由 9 个用例中的断言真实触发全部 25 个错误码：`INVALID_CONTRACT`、`INVALID_VALUE`、`UNKNOWN_FIELD`、`UNKNOWN_SCHEMA`、`DUPLICATE_ID`、`DUPLICATE_REFERENCE`、`DUPLICATE_PATH`、`UNKNOWN_TASK_REF`、`UNKNOWN_CHECK_REF`、`UNKNOWN_RESOURCE_REF`、`MISSING_REPAIR_OWNER`、`EMPTY_REPAIR_OWNERS`、`SELF_DEPENDENCY`、`DEPENDENCY_CYCLE`、`EMPTY_TERMINAL_CHECKS`、`ORPHAN_CHECK`、`INVALID_PATH`、`INVALID_CAPACITY`、`INVALID_COMMAND`、`MISSING_CONTRACT_BLOCK`、`DUPLICATE_CONTRACT_BLOCK`、`INVALID_CONTRACT_BLOCK`、`INVALID_JSON`、`PLAN_TOO_LARGE`、`UNREADABLE_PLAN`。另外覆盖递归冻结、键序/checkbox/JSON 空白 hash 稳定、实际环路径、32KiB 任务正文边界和 4MiB 文件边界。

## 4. 本次实测引用

以下引用来自修复后最终 31/31 命令的 `t.diagnostic` 输出。临时 session 文件已按约定清理，不能作为仍可打开的永久证据路径；证据由可重跑测试、工具回执和此处身份记录组成。下一次运行的 UUID/entry ID 会变化。

| 场景 | 身份与引用 |
| --- | --- |
| F1 Host 绑定 | session `01a17de6-b349-75c3-8d3f-6b3c94e8a836`；plan `821d62aa-d60e-4de2-af68-468565868be2`；entry `d3bf6865` |
| F1 session 文件（已清理） | `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/joint-session-s4yFMP/agent/sessions/2026-10-27T15-07-13-610Z_01a17de6-b349-75c3-8d3f-6b3c94e8a836.jsonl` |
| Host 合同 hash | `d44b8127058e1212dc4b2a305e938709532a493d31cc507d043c10bffa8d0425`；合同内 executable 使用本机 `process.execPath`，换 Node 安装路径可能改变此 hash |
| F3 真实 bash 证据 | session `01a17de6-b843-75c3-8d3f-6b43e7026368`；receipt `76fed2f5#0`；父调用 `host-plan_verify-1793113635028`；exitCode 0 |
| RPC 绑定 | session `01a17de6-ad34-70e9-bc0d-e0e326324c54`；plan `134308dd-603a-4897-b32c-51553517318c`；entry `2a3b9775`；contractHash `4784e79c630eadda857752d483e608ece14f43cf7b9388b81db92b154f211ee7` |
| F10 false/缺失/非法 | session 依次为 `01a17de6-d04d-75c3-8d3f-6b5dbf3955f7`、`01a17de6-d0d3-75c3-8d3f-6b5f1638fe4a`、`01a17de6-d169-75c3-8d3f-6b60aca83e8d`；三集合均 `[]` |
| F10 true | session `01a17de6-d22b-75c3-8d3f-6b635fbb85b8`；registered/active 为五个 plan 工具，callable 为 `["plan_status"]` |

## 5. 发现的缺陷与处置

### 5.1 真实 receipt 的恢复引用解析缺陷：failed → 修复后 passed

**数据来源分类：1，预期 production 数据未被正确处理。** adapter 只提供交付事实；receipt 和证据完全由 production `plan_verify → scheduler.verify → verifyChecks → ctx.executeTool('bash') → store.writeEvidence` 产生并真实写盘，未手工构造 Goal state/evidence。该问题与 adapter 的 proof 文案无关。

真实入口顺序：`plan_execute` 绑定 → adapter 闭合 facts → 任务进入 verifying → `plan_verify` 执行良性命令且 exit 0 → `goal-runtime.check-result.v1` 与 accepted 状态落盘 → shutdown → `SessionManager.open` 同文件 → 新 SDK Host session_start 恢复。

首个偏离点是 [session-state.ts 的 resolveEvidenceEntry](../../src/goal-runtime/session-state.ts#L710)：原逻辑直接拿完整 `entryId#0` 查询 entry ID；[verification.ts](../../src/goal-runtime/verification.ts) 按 `${entryId}#${index}` 生成引用，而 [index.ts 的 evidenceFor](../../src/goal-runtime/index.ts) 已按该约定拆分。结果是 entry 实际存在，但新 Host 返回 `state:null`、`writable:false`、`SESSION_STATE_CORRUPT`。

修复前的现场错误：`回执 resultRef 2a3d9189#0 在当前分支找不到唯一证据条目`，session `01a17de2-107e-76b3-8607-6cbb5e42d995`。最小复现为上表 `--test-name-pattern='F5 新 Host'` 命令；加强该用例之前只恢复 running、无 receipt，不能覆盖此缺陷。

本代理发现后停止相关验证并向主管上报，未自行修改 production。主会话安排 owner 最小修复：按 `entryId#index` 剥离索引后缀精确查 entry；带后缀找不到时 fail-closed，不回退模糊匹配；保留原无后缀行为和后续身份/落盘核验。续跑时已直接读取修复代码，且本代理重新执行三份全套 31/31 和 typecheck 通过。修复仍在未提交工作树，没有虚构修复 commit。

### 5.2 gate 错配测试设置时序：测试制造的数据，已修测试

首次将权威设置 override 放在 `loader.reload()` 前，随后 loader 重读文件覆盖 override，实际 session_start 仍看到 true，与测试欲制造的 false 不符。此为分类 2；将 override 移到 factory 完成后，并显式断言 `settingsManager.getSettings().goalEngine` 与预期一致。生产代码未为此添加兼容逻辑。修正后 F10 专项 6/6，最终全套亦通过。

## 6. 清理与未验证边界

新测试以 `mkdtemp` 隔离仓库、agentDir 和 session；Host 用既有 harness `close()`，子用例注册 `t.after`；临时 IO 故障用 `finally` 恢复文件；RPC 有 watchdog、EOF 正常退出、异常 SIGKILL 和父进程 finally 删除临时根。最终全套成功完成这些 cleanup；另实际检查 F1 和五个 gate 诊断中的临时根均已不存在。未访问用户 `var/workspaces`，未产生真实 Goal child workspace。

以下边界已由独立首启真实 smoke 补测，结果不与本报告原有 adapter 证据混写：

1. Goal→真实 coding child spawn→真实 worktree→terminal proof→Auto Integration→workspace release：已通过正向 A→B 串行依赖链；A/B 均真实 child、proof、integration receipt、released，最终 completed。并发容量与全部竞态组合仍未覆盖。
2. 真实失败修复：已通过 check exit 7→blocked、workspace release、`plan_retry` attempt 2、exit 0、accepted/completed；真实 typed-resume 也已通过新 PID、同 session/workspace、intent completed。
3. cancelled 闭合替换：旧 plan terminal/released、取消后新 planId 和旧 entry 保留；真实终验中新 child proof 已生成但 queue 仍 queued、resume intent pending、manual integration blocked，按 D 保留 ledger 复现，未伪造 completed。
4. 活动 Goal compact 与跨 Host 恢复：真实 compact、同 session 新 Host、facts 重建、`plan_verify`、completed/released 和 queue completed 均已通过；缺陷 C 结案。

仍未专项执行的边界包括 `not-started` 故障、伪造完成字段/旧候选/检查中漂移的完整负向矩阵、switch/shutdown 迟到回调、完整 fork/tree 用户导航和用户队列竞态、网络 package 发布闭包及最低支持 Node 版本复测。上述 smoke 的 blocked 项不计通过，也不设 skip。

## 2026-10-28 T5 v2 单仓库回归追加

本追加不改动上文 v1 实测记录。沿用真实 `qoder-pool/DeepSeek-Flash`、真实 Host RPC 与临时 Git 根，`scripts/probes/goal-smoke.ts --scenario positive`、`--scenario resume`、`--scenario compact` 均通过：正向 A/B proof、integration receipt、checks exit 0、completed/released；typed resume 取得同 session/workspace 的新 PID、intent completed、proof/receipt/released；compact 取得 `tokensBefore=176274`、`estimatedTokensAfter=24254`，旧 Host PID `39207`、新 Host PID `51081`，跨 Host 后 `plan_verify`、completed/released 通过。三场景主 Host assistant 消耗分别为 13、9、13，child 均不超过 6 条；成功临时根均 `removed:true`、`killedPids:[]`、`noStagedFiles:true`。v2 多仓库专项证据与失败现场归因见 [2026-10-27 Goal Runtime v2 多仓库 smoke 报告](2026-10-27-goal-runtime-v2-multirepo-smoke.md)。
