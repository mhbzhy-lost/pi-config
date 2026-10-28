# Goal Runtime 首启真实冒烟运行手册与实测报告

日期：2026-10-27。执行任务：`dispatch-ad7660d5`。本报告覆盖真实 provider、真实物理 CLI、隔离仓库；不将既有 adapter 测试结果当作 child 终局证明。

## 首轮发现的生产缺陷

**首轮正向冒烟 failed：`INVALID_TITLE`。** 已停止真实 Host，未继续其余场景，未修改 production。主会话已接收为分类 1 生产缺陷并安排 owner 修复；后续结果以本报告续跑记录为准。

来源和调用链：真实 Pi CLI/RPC → `qoder-pool/DeepSeek-Flash` 实际模型 → 正式 `plan_execute({plan_path:"positive.md",mode:"subagent-driven"})` → [scheduler.ts](../../src/goal-runtime/scheduler.ts) 的 `prompt()` 生成固定首行、换行和格式化 JSON → `execution.start` 请求没有 title → package 正式执行闭包 `executeCoding` → [dispatch-ir.ts](../../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts) 缺 title 时取 `task.slice(0,50)` → `ensureAllocated` 与 `onAllocated` 成功 → RPC capability 协商 → [extension.ts](../../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts) 的 `titleRegistry.prepare` → [title-registry.ts](../../packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts) 拒绝控制符/换行，返回 `INVALID_TITLE`。

首个偏离点是缺省 title 生成：Goal 的合法多行任务正文被截取为展示标题，其中包含换行，与 title-registry 的单行合同冲突。此数据由正式 Goal 入口产生，没有手拼状态、proof、coordinator intent 或 adapter 替身。失败发生在 workspace 分配之后、child spawn 之前。Goal 如实保留 unknown/blocked，未谎报派发成功。

| 首轮证据 | 现场值 |
| --- | --- |
| 执行命令 | `node scripts/probes/goal-smoke.ts --scenario positive` |
| 物理 CLI | `/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/cli.js` |
| Host PID | `62734` |
| session | `01a17dfa-58c1-7773-b9a0-36e3b56ac695` |
| plan | `2572e6be-8bf2-4880-8e12-f60378b8fd5e` |
| contractHash | `9c4e0992462cd15beaeeaaba5a88f6ae87493864b5bf73953496785c51bfaf86` |
| 失败 entry | `bb69eed6` |
| workspace | `918538e6-19d5-4c5c-9f8a-aed93b6ff542` |
| A 状态 | `blocked`、attempt 1、run null、已保存 workspaceId |
| B 状态 | `pending`、attempt 0 |
| terminal proof / integration receipt | 均无；child 未启动 |
| 根模型实际消息 | `qoder-pool/DeepSeek-Flash`，4 条 assistant 消息，usage input 20913 / output 617 |
| 清理 | 临时根 `goal-smoke-QouKSS` 已删除；额外待清理 PID 列表为空；无 staged 文件 |

首轮探针只读诊断尝试写 stdout，但真实 Host 将扩展 stdout 捕获到 stderr；这是分类 2 的探针错误，已将诊断改成真实 RPC `get_entries` 读取 Goal entry，诊断命令调用公开 execution service 只读 inspect 并将快照写入沙箱内 observation.json。该问题不改变上表正式 `tool_execution_end` 中的 `INVALID_TITLE`、workspace 或 session 回执。修正仅发生于探针文件。

## 正向全链续跑：passed

生产 owner 修复已另记于 [多行 title 缺陷](../bugs/2026-10-27-goal-dispatch-multiline-title.md)。本代理只读取修复现场并重跑，不修改生产代码。第四轮真实 `positive` 最终通过：session `01a17e03-ebf0-71e0-9a35-790d7e6d7f4a`，Host PID `53835`，plan `1c93bf91-0f6d-4ff1-a49d-550392bfcd93`，revision `17`，终态 entry `bfec47eb`，A/B 均 accepted，plan completed。

| 真实证据 | A | B（依赖 A） |
| --- | --- | --- |
| child PID | `54125` | `55575` |
| runId | `a4fa4c82-08ed-44ea-adbe-f51393d16b0d` | `4ae23776-7ecd-484b-ac66-7fba6a1475db` |
| workspaceId | `2f3f1e6c-a3d7-44ba-a706-7bbe861537f3` | `d9cabf5c-f9f5-4ee2-a822-4f51252993bc` |
| child sessionId | `01a17e03-fd9e-7166-b41d-39dbb444e21f` | `01a17e04-4a84-776f-b4bf-5c1a6c42c378` |
| terminalProofRef | `f3cdb1094f185d7fbcb5fc8f4d565cfbab14b772737ad3d8ec57b76134cc7b64` | `260ef9471f36e20535059e84e5acb609cc520f6cfd97147c587f1d7564864021` |
| integrationReceiptRef | `cdad1a72-6b15-41f1-9c96-9fb7fed533df` | `296c0007-6a3a-427f-a02c-90a1a0d47cbd` |
| 官方事实 | succeeded / completed / released，blocker null | succeeded / completed / released，blocker null |
| 真实终态 check | `3b168a60#0`，exit 0 | `3b168a60#1`，exit 0 |
| child assistant 调用量 | 2，input 3230 / output 618 | 3，input 8057 / output 940 |

根模型 13 条 assistant 消息，input 114934 / output 1043。父子回执全部为 `qoder-pool/DeepSeek-Flash`。usage input 字段不包含 cacheRead；模型目录配置的 cost 为 0，不将其解释为供应商实际免费。

最终候选 HEAD `f125118605f2c4d2388af0efbe2e6070abfbcf83`，contentHash `2e05e9ca10f62200ed29126bcbafd06bad2515c6484461f9d4f6171f69d7c41f`，contractHash `158a6968550daed1d75c1fbd2792a1bdc189b6fcf8db845e02bc8c8f39d8221b`。B 的真实派发出现在 A accepted 之后；终态 checks 对两个已交付文件统一重跑。临时根 `goal-smoke-hxqswH` 已删除，cleanup 的额外待杀 PID 列表为空、无 staged 文件。

中间两轮停止也计入调用量和证据边界：第二轮 A 已真实启动并取得 integration receipt `4ce7e51a-f48d-4a9a-8417-f5c4bfd0dd61`，但探针按初始 3 消息预算在最终报告（第 4 条 assistant）处停止；根 5 条 / child 4 条。主管随后授权 child 每实例最多 6 条 assistant，含最终验收报告，超过即硬停。第三轮 child 2 条已完成并释放 workspace，根模型重复查询 released workspace 收到合法 `MANAGED_WORKSPACE_STATE` 拒绝，探针误将只读诊断拒绝当 fatal；根 5 条 / child 2 条。均已 finally 清理，没有把这两轮算作全链 passed。最终探针限制 Goal 场景的根 active tools 为 plan 工具及检查所需 bash，并保留所有正式工具门禁，不对实际回执改写。

## 失败修复环：passed

真实 `repair` 场景先由 child 产生 `exit 7`，`plan_verify` 写入 `check-A` failed receipt，A 进入 blocked，workspace released；其后用户授权 `plan_retry`，attempt 2 真实启动并完成修复，复验 exit 0，旧失败证据保留且最终计划 completed revision 19。首轮模型在暂停期间尝试自动 retry 被 `GOAL_NOT_ACTIVE` 合法拒绝，随后显式 `/plan resume` 后 retry 成功；这证明暂停门禁生效。

本场景模型实际为 `qoder-pool/DeepSeek-Flash`。child 首轮/修复轮均在 6 条 assistant 上限内，根调用预算未超限。失败、修复 run/workspace/proof 的完整身份保存在本次探针原始回执中；临时根已清理。

## cancelled 替换：第二轮真实链已通过，缺陷 D 收口

上一轮真实终验确认旧计划 terminal succeeded、workspace released；取消后新计划生成新 `planId`，旧 `goal-runtime.state.v1` entry 保留。新计划 child 真实取得 terminal proof，但集成 queue 仍停在 `queued`，workspace active，Goal facts 为 `manual-integration/subagent-integration-handoff`，没有完成至 completed。

终验现场：旧计划 `073e46b6-323d-4eb6-b876-af01d50fe5e7`，旧 run `4221959a-a01b-4c89-b3ce-daa71811637c`，旧 workspace `c39164a3-e0b0-4b20-9d0d-01701a7a98e9`，旧 proof `d8753b3d0de96a9c6ee30e0751511536b966f9737c90316bd5b21a87e48cbf4e`；新计划 `ce44a929-cc93-48c6-ac8a-d86c100ec8b0`，新 run `f4e5e3c1-2e49-416f-be46-2d307e044592`，新 workspace `e66c434b-4f27-4b73-9a74-8714ce6e5c1b`，terminal proof `0ff64b96080e1fc600bcec86399da06465d5782677a4f3a4d57e425e11dc13b6`，queue `4bb42a2e-cd63-406a-a899-ea11928998e4` queued，resume intent `7f58a0db-c638-4e84-a4c4-8391c17e34f4` pending。

上一轮结论：D 修复在 DI 层回归成立，但真实 cancelled 替换链仍停滞，当时不能收口为通过。该次临时根已清理，故以下第二轮重新保留现场取证。

第二轮 `dispatch-e1e38247` 使用 `--keep-artifacts`，在 `goal-smoke-Z33NyW` 保留完整 ledger、queue/intent、session 与 runner 事件。新 run `332ba929-8633-4499-8d63-c9f15ebcae40` 的原始 stderr 固定首个拒绝：`changed files outside writePaths: replacement-A.txt`。两个文件都为 `A\n`，Git 返回 `C100 replacement-A.txt replacement-next-A.txt`，而 `--no-renames` 只显示新增 `replacement-next-A.txt`；`git-worktree.ts:236` 的 copy/rename 共用解析误把未修改源文件也计为 changed。service 的范围门禁正确，上一轮 terminal 接续也被同一错误输入挡住，并非 queue 没有消费者。详细身份、原始日志摘录、base/HEAD 与哈希见 [D 第二轮根因报告](../bugs/2026-10-27-replaced-plan-queue-stall.md:53)。

生产修复只改 copy 的 changed-path 语义，rename 仍检查两端。修复后真实 `goal-smoke-Je1qej`：session `01a17e64-d7f4-7030-9b09-ae78b80e4989`，旧 plan `6b3f58e7-0f74-418d-8685-f4a037945a1c` released 后 cancel；新 plan `4779d7a1-909a-4be8-a1a8-ba04750c1912` **completed**，旧 entry 保留。新 run `ddee4fe5-b546-43e5-9558-f28a45420585`、workspace `6676ff3c-2996-4213-9bc0-6e53e30a6301` released，proof `f99d17b358999662a51e68c1997a4a77ce92fa12f73e616280d88024384e6142`、integration receipt `01e16bd6-1ce9-4bd2-95de-88178ff21857`，queue `dc64a9da-34a4-487a-b1e3-a16fa9c78357` completed，resumeIntents 为空。原 child stderr 记录 `integration-lifecycle-advance-result: completed, poll:0`；最终 Git diff 仍为相同 C100，证明没有改任务内容避开缺陷。真实模型仍为 `qoder-pool/DeepSeek-Flash`；旧 child 2、新 child 4、主模型 10 条 assistant，均在预算内。

中间一轮 `goal-smoke-ndX69M` 因探针在通知唤醒时发送 prompt，被官方 RPC 拒绝为 `Agent is already processing`，新计划尚未派发；仅给 execute prompt 补官方 `streamingBehavior: followUp` 后重跑。没有人工 integrate、没有改 queue、没有伪造 completed；DI 的 C100 窄范围回归先 RED 后验证，既有门禁保持。相关既有测试 **180/180 通过**，根/package typecheck 与探针独立静态检查通过。归因与验证完成后，`goal-smoke-Z33NyW`、`goal-smoke-ndX69M`、`goal-smoke-Je1qej` 均显式删除并得到 `removed:true`、`killedPids:[]`、`noStagedFiles:true`。完整临时文件已清理，原始摘录、身份和哈希保留于 D 报告。

## typed-resume：passed

真实场景使用正式 `subagent_start` 与 `subagent_run_resume`。首个 child `runId=7e0cb979-3493-4a3a-91a9-19a0a96ca67a`、PID `31553` 完成后留下真实 workspace `5ce3d2e0-4822-4754-9780-90464a47707e` 与 canonical resume intent `2864bef4-2881-4171-bb12-e6105f2b91d3`；delivery 为 `delivered`。正式 typed resume 返回新 `runId=3ca2f784-f5dc-4d6d-a4b8-c5be8ebe74f9`，新 PID `33638`，同一 child sessionFile 和 workspace。最终 intent state `completed`、agentProfile `delegate`、workspace released、integration receipt `ed170df7-ac9c-467f-b0f7-cc405deb0333`、新 proof `17ec248c85b019e81b7bc8e08db9bf1d8b71ed9748df1dcecd90a7ec1cdf037d`。旧/新 child 均实际使用 `qoder-pool/DeepSeek-Flash`；首 child 2 条、新 child 4 条 assistant。临时根已清理，无 staged 文件。

## compact 跨 Host：缺陷 C 已修复并通过真实终验

最后一次真实 compact smoke 成功：session `01a17e5c-54f2-75a9-a067-33feb20c48ec`，compact 前 Host PID `20084`，新 Host PID `21242`，plan `df53c7e2-bc2f-431b-83fd-c56422d7b650`，`tokensBefore=176707`、`estimatedTokensAfter=23854`。新 Host 使用同一 sessionFile 恢复后，`planExecution` facts 可用，不再返回 `PLAN_EXECUTION_FACTS_UNAVAILABLE`；真实 `plan_verify` 可用，两次 check receipt 均 exit 0，计划最终 completed。

完整终态证据：run `8ac34982-8cd1-4809-8d95-e777a47bbaf2`，workspace `03a83c59-188c-4107-8a94-ecd9b3151906`，terminal proof `f4a5d4925bcf8ad9af38750cacff3d546e46892666dc89b61cc8d02de7af27d1`，integration receipt `187a82a3-2d26-4992-99c8-4e227bef4e9b`，workspace released，queue `b086ad5f-574c-4095-abea-da6797b123e4` completed。新 Host Root Broker/planExecution 权威事实视图已重建；缺陷 C 结案。

本场景使用单任务 compact 合同，避免原双任务 fixture 中 B 的写入值与 check 期望不一致；该调整只修正探针数据，不改变 production。临时根已清理，child assistant 3 次、根模型 16 次，均在预算内。

## 模型与清理统计

所有实际模型回执均为 `qoder-pool/DeepSeek-Flash`，不是临时别名。官方 `deepseek/deepseek-flash` 目录存在但本机 enabledModels 的可用 qualified 名是 qoder-pool 这一通道，按主管裁决如实记录。

默认每个场景 finally 删除 0700 临时根；第二轮 D 使用 `--keep-artifacts` 保留到归因和验证结束后显式清理。日志只汇总 provider/model、PID、run/workspace/receipt 身份、token usage，不包含 auth 内容。凭据仅执行 `cp pi/auth.json <temp>/agent/auth.json`，脚本不读取其内容。各次 cleanup 记录 `removed:true`、`killedPids:[]`、`noStagedFiles:true`；未修改主仓 settings/models，未 stage/commit。



原始派发合同写 `deepseek/deepseek-flash`。本机 `pi/settings.json` 当前启用的是 `qoder-pool/DeepSeek-Flash`，`pi/models.json` 在 qoder-pool 网关定义该模型；`pi/models-store.json` 另有官方 `deepseek/deepseek-flash` 目录记录（官方凭据状态未验证）。主管明确裁决本轮使用已启用的 `qoder-pool/DeepSeek-Flash`，按实际 qualified 名留证，不伪造 provider 别名。因此本报告不宣称已验证官方 DeepSeek 端点。

## 运行方式与安全边界

探针：[scripts/probes/goal-smoke.ts](../../scripts/probes/goal-smoke.ts)。使用仓库现有依赖和物理 CLI，无 npm 安装。

```bash
node scripts/probes/goal-smoke.ts --help
node scripts/probes/goal-smoke.ts --scenario positive
```

探针参数接受 `all|positive|repair|replace|resume|compact`；可加 `--keep-artifacts` 在关闭自身进程后保留临时现场供归因，结束后须显式清理并记录 `removed:true`。各场景均已真实运行，结果见下方场景进度与验证命令。

资源隔离：`mkdtemp` 根权限 0700，agentDir、HOME、TMPDIR、sessions、仓库、workspaces 均在其中；临时 settings 同时开启 `goalEngine.enabled` 和 extension 自有 `goal-runtime.json` gate。真实 Goal/subagent 扩展直接加载仓库入口，不复制魔改生产源码；共享 agents 扩展使用指向真实入口的 symlink。角色 profile 复制到临时 agentDir 并固定本轮模型。凭据只由外部 `cp pi/auth.json` 复制；不读取、解析或打印内容。所有模型使用回执与日志均不包含凭据。

初始仓库提交只在临时仓库执行；受管 child 的 worktree、发布与清理由正式 package 管理，探针不执行 raw `git worktree`。finally 关闭自身 Host，按本次唯一临时根核对进程；默认删除临时根，`--keep-artifacts` 则保留至归因后显式清理。退出码 0 才表示所选路径全部断言通过；1 表示阻塞或失败。主仓 settings/models/用户 session 不写入，不 stage/commit。

## 场景进度

| 场景 | 当前结论 | 尚缺证据 |
| --- | --- | --- |
| 正向 A→B 全链 | **passed**，修复后第四轮完成 | 本轮只验证串行 A→B；不补签所有并发/竞态组合 |
| check exit 7 → retry 修复 | **passed**，真实失败后 blocked、资源释放、`plan_retry` attempt 2 修复并 completed | 首轮模型误尝试 retry 被 `GOAL_NOT_ACTIVE` 拒绝，显式 resume 后成功；完整身份见运行回执 |
| cancelled 闭合替换 | **passed，缺陷 D 第二轮已修复** | 保留现场固定 C100 复制源误计 changedFiles；修复后真实新 plan completed、queue completed、workspace released，proof/receipt 齐全 |
| typed-resume 新 PID | **passed**，新 PID、同 session/workspace、intent completed | 旧/新 run、proof、receipt 与清理证据已取证 |
| 活动 Goal compact + 跨进程恢复 | **passed，缺陷 C 已修复** | 新 Host facts 可用、plan_verify 通过、completed、queue completed、workspace released |

## 验证命令

- `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node scripts/probes/goal-smoke.ts`：修订后通过。
- `node scripts/probes/goal-smoke.ts --scenario positive`：passed，真实 child A/B、proof、Auto Integration、checks、completed。
- `node scripts/probes/goal-smoke.ts --scenario repair`：passed，exit 7 blocked → plan_retry attempt 2 → completed。
- `node scripts/probes/goal-smoke.ts --scenario replace --keep-artifacts`：第二轮先保留现场复现 `MANAGED_WORKSPACE_WRITE_PATHS`，copy 解析最小修复后 passed；新 plan `4779d7a1…` completed、queue `dc64a9da…` completed、workspace `6676ff3c…` released。
- `node scripts/probes/goal-smoke.ts --scenario resume`：passed，新 PID `33638`、同 session/workspace、intent completed、released。
- `node scripts/probes/goal-smoke.ts --scenario compact`：passed，session `01a17e5c…` 新 Host PID `21242` facts 可用，plan_verify 通过，最终 completed/released，queue completed。
- 默认 finally cleanup 为 `removed:true`；D 第二轮先以 `--keep-artifacts` 保留，归因及双重验证后显式清理得到 `removed:true`。均无 staged 文件。
