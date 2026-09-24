# managed worktree & git merge queue 实践失败归因 —— 整合报告

> 场景：用户在真实业务仓库 `~/new-api-account-pool`（Go 项目，含 submodule `sub2api`）的 live pi 会话中实践 managed worktree + git merge queue，反馈「agent 使用这套工具十分艰难且经常出错」。
>
> 调查对象：根会话 `var/sessions/2026-09-20T03-09-49-721Z_01a0bcca-9b19-751c-a28f-ba65e7d2b6e8.jsonl`（live，冻结于 L852 / 2026-09-21T12:22:36.135Z，273 toolResult）+ 64 个 nested child session + workspace 持久状态 + runtime 源码。
>
> 方法：4 个只读 subagent 并行取证（会话取证 / 派发合同源码归因 / workspace+queue 源码归因 / 跨 312 会话流行度统计），主 agent 独立复核关键论断。全程未修改任何生产代码、配置、session、ledger 或遗留 worktree。

---

## 0. 总结论

**用户的体感是准确的，但归因需要修正：agent 的操作大体正确，是这套 runtime 在「含 submodule 的真实仓库 + 只读派发 + 并发续做」这三个真实条件下从未跑通过一次。**

三个决定性的量化事实：

| 指标 | 实测值 |
|---|---|
| merge queue 完成率 | **0 / 1**（全程只入队 1 次，至今卡 `queued`） |
| terminal proof settle 率 | **0 / 5**（5 个 proof 全部 `observed`，`receipts: {}` 为空） |
| 成功的 typed integrate | **0 / 29** 次 `subagent_worktree` 调用 |
| workspace 回收失败率 | **4 / 5** 落入 `cleanup-debt`，5 个 worktree 目录全部滞留磁盘 |
| 派发拒绝率（本会话） | **15 / 79 = 19.0%**，作废参数 39,780 bytes ≈ 13.4k token |
| worktree 处置失败率 | **10 / 29 = 34.5%** |

两条彼此独立的故障链，分别对应「派发前」和「派发后」：

```
链一（派发前 · 合同面）
  schema 无 required + generic 字段平铺 + skill 文法写错 + 孤儿 IR 假绿
    → agent 反复被拒 → 19% 拒绝率 → 13.4k token 作废 → 认知负担

链二（派发后 · 生命周期面）
  child 提交 → proof observed → 但 receipt 从不 settle
    → queue 只 enqueue 不 claim（admissionGeneration=0）→ 永不 rebase/publish
    → agent 只能 preserve → release → git remove failed（stderr 被丢弃）
    → cleanup-debt → 无 agent 出口 + 无法派 child 回 worktree 续做
    → 永久遗留 + 退回仓库根裸写（59/64 child 无隔离）
```

---

## 1. 主 agent 自我更正（两处曾过度断言）

调查过程中主 agent 向用户播报过两个结论，经 C 组源码级取证后被推翻，记录在此以免污染后续决策。

### 1.1 ❌「preserve → status 不可用 → token 刷不出 → 只能 release」是死结

**真相**：`preserve → release` 有一条**无需 token 的 legacy 出口**。`releaseForLease` 在 preserve challenge 已消费（`challenge?.used === true`）时走 `legacyRelease`（`service.ts:591-600`），所以 preserve 后 release 并不会因缺 token 失败。现场也确实进入了 release。

**真正的死结更窄也更硬**：release 的 `git worktree remove` 失败后 state 进入 `cleanup-debt`（`service.ts:604-617`），而
- release 固定不带 `--force`（`git-worktree.ts:419-438`），重试只是重复同一条失败命令；
- `reconcile` 不在 `subagent_worktree` 的 action union 里（`tool.ts:1-92`）；
- admin `planManagedWorkspaceCleanup / applyManagedWorkspaceCleanup`（`administration.ts:198-245`）是人类/宿主管理面，agent 不可调用；
- 想派 child 回 worktree 续做又被 state-root cwd preflight 拒绝。

→ **agent 不可逃逸，只能人工介入。**

### 1.2 ❌「3/5 worktree 完全干净 → submodule 是共同真因」

主 agent 用 `git status --porcelain` 判定 3 个 worktree「完全干净」，据此断言 submodule 是共同原因。C 组加了 `--ignored --untracked-files=all` 后推翻：

| workspace | ledger | 现场（含 ignored） | 真因等级 |
|---|---|---|---|
| `c161c5e9` | cleanup-debt / phase=release | ` M sub2api`（gitlink 变更） | 候选高置信，**未证实** |
| `5c1844c9` | cleanup-debt / phase=release | ` M sub2api` + `?? docs/reports/...rebuild-log.md`，gitlink `5feca724→87bb590` | 候选高置信，**未证实** |
| `3b8d0a57` | cleanup-debt / phase=release | tracked 干净，但 `!! .pi/subagents/artifacts/*_meta.json`、`*_output.md` | **runtime 自产 artifacts**，候选高置信 |
| `6686ea46` | cleanup-debt / phase=release | 父/子 status 均无输出、无 lock、无驻留进程 | **未证实，必须保留未知** |
| `01a2da1b` | active（对照组，非失败项） | `sub2api/.git/index.lock` 存在 + pid 77416 驻留 | 证明 lock/process 放大器真实存在，但**不得倒推**到上述四条 |

**`3b8d0a57` 是最有价值的一条**：阻断物是 `.pi/subagents/artifacts/` 下 runtime **自己写进 worktree 的** meta/output 文件。`removeUntrackedRuntimeMetadata` 在 Git remove 前会尝试清理，但失败后可能被重建 —— **runtime 被自己的产物绊倒**。

而 `6686ea46` 必须诚实地标为未证实：因为 `git-worktree.ts:44-49` 从设计上丢弃 `cause.stderr`，原始 git 错误字符串已永久不可恢复，而铁律又禁止手工 `git worktree remove` 去复现它。**信息丢失在这里不是体验问题，它直接销毁了唯一的诊断证据。**

---

## 2. Blocker 级缺口

### B1 · 孤儿 IR + 假绿测试：merge queue 那次提交把修复打到了死文件

`b332005`（2026-09-18，`feat(subagent): 增加 durable FIFO 队列与真实子代理恢复机制`）**只改了 1 行，改在 `src/subagent-dispatch/ir.ts`**：

```diff
-      minItems: 1,
+      minItems: 0,
```

但生产路径是另一份文件：

```
package.json exports  "./dispatch-ir" → "./src/contracts/dispatch-ir.ts"
extension.ts:7        import ... from "../contracts/dispatch-ir.ts"
contracts/dispatch-ir.ts:168   writePaths: normalizeStringArray(..., { minItems: 1, ... })   ← 生产在跑
subagent-dispatch/ir.ts:211    writePaths: normalizeStringArray(..., { minItems: 0, ... })   ← 零生产 importer
```

`src/subagent-dispatch/ir.ts` 的 importer 全仓只有 3 个 test 文件 + 1 处 fixture 路径列表。配套测试 `test/subagent-dispatch-validation-errors.test.mjs:89-93`：

```js
test("coding contract with empty writePaths is an explicit read-only dispatch", () => {
  // 空数组 writePaths 是显式只读声明：纯运行/观测任务不再被迫造假路径。
  assert.deepEqual(ir.boundaries.writePaths, []);
});
```

**import 的是孤儿，所以 CI 全绿、意图从未上线。** 注释证明当时已准确诊断出痛点。

真实后果（现场 L689）：

```
taskId=clean-root-worktree  mode=docs-only  worktree=false
writePaths=["docs/plans/**","docs/bugs/**","docs/reports/**","sub2api"]
```

一个清理 worktree 的任务，被迫填三个无关文档 glob 加一个裸 `sub2api`（按文法这是「名为 sub2api 的**文件**」）。本会话 14 次 `docs-only` 派发全部被迫编造 writePaths。

### B2 · Schema 与 contract 系统性漂移

`TYPED_SUBAGENT_PARAMETERS`（`extension.ts:49-159`）根节点**没有任何 `required`**，且刻意不用 `oneOf/anyOf`（源码注释：某些严格 OpenAI-compatible provider 遇到根级 union 会生成空 arguments，`extension.ts:44-48`）。而 coding compiler 要求 13 个顶层字段中除 `model` 外**全部必填**（`contracts/dispatch-ir.ts:11-27,212-235`）。

同时 generic-only 字段被平铺进同一 schema，coding 分支一律按 unknown field 拒绝：`task / cwd / output / outputMode / outputSchema / artifacts / progress / worktree / skill / reads`。

跨 312 会话实测（T1 = 仅 runtime 工具、仅错误前缀、按 toolCallId 去重）：

| 签名 | 次数 | 会话 | 项目 | 跨度 |
|---|---:|---:|---:|---|
| `INVALID_PATH` | 327 | 52 | 12 | 07-20 → 09-20 |
| `INVALID_CONTRACT` | 312 | 52 | 10 | 07-20 → 09-20 |
| └ `workflow.reason is forbidden when mode is tdd` | **182** | 41 | 10 | 07-20 → 09-20 |
| └ `is missing required field boundaries` | 15 | 3 | 09-08 → 09-20 |
| `SUBAGENT_RPC_FAILED` | 22 | 11 | 4 | 08-26 → 09-20 |
| `MODEL_NOT_AVAILABLE` | 19 | 11 | 4 | 09-04 → 09-20 |

**头号慢性病是 `tdd` 禁止 `reason`**：182 次 / 41 会话 / 10 项目，占全部 `INVALID_CONTRACT` 的 58%，从有记录第一天持续到昨天。规则反直觉（「给出理由」竟被拒），schema 里 `workflow.reason` 只是个可选 string，条件约束完全不可见 → 只能靠被拒学习，且跨会话学不会。

月度趋势 T1：07月 482 / 08月 314 / 09月 427 —— **未收敛**。

### B3 · merge queue 从未 claim

```
queue-index.json  ["0ed45c9b-...json"]         全程只 1 个 item
queue-meta.json   {"nextSequence":2}           只入队过 1 次

item 0ed45c9b:  state="queued"  attempt=1  revision=3  admissionGeneration=0
                strategy="rebase-ff"  targetRef="refs/heads/main"  autoManaged=true
                workspaceId=3b8d0a57  childRunId=74f0fb42
                authorizedWorkspaceHead=a7526c46...   ← 与 worktree 实际 HEAD 精确一致
                缺失：queueLeaseId / admittedTargetHead / candidateHead /
                      integrationIntentId / workspaceDispositionReceiptId / completedAt
```

child 提交了、HEAD 与授权头一致、item 被 admit 进队列，然后**再没往前走一步**。写 admitted/lease/generation 的是 `claimNext`（`integration-queue.ts:235-242`）→ **coordinator worker 从未 claim**。断点精确落在 `queued → admitted` 之前。

`revision=3` 说明记录被改写 3 次而状态未变；4 份 resume 文件中 3 份 `failed`、1 份 `starting`，`resume-55...` 的 delivery 为 `debt`，reason `run can bind only to an active workspace`。

terminal proof 侧：`pending` 5 项全部 `state="observed"` / `conflict=false`，`receipts: {}` **空**，`debts` 的 reason 大量为 `trusted run binding is unavailable`。→ **proof 观测正常，settle 完全失效**，对应已知缺陷 `2026-09-13-real-runtime-enqueue-disconnect.md`、`2026-09-15-proof-settle-replay-diagnosis.md`、`2026-09-02-goal-settle-misses-persisted-executor-terminal-proof.md`，仍在复现。

5 个 proof 全部 `conflict=false`，现场却出现四轮重复冲突检查。

### B4 · cleanup-debt 无 agent 出口 + 无法续做既有 worktree

见 §1.1。补充：`dispose(integrate)` 在 publication allowed 时被生产直接拒绝（child queue 拥有 integration），但 `SKILL.md`、`README.md` 与 tool schema 都把它当作正常路径宣传（「按此顺序调用 list → status → dispose integrate」）。**这是工具面在宣传一条生产会拒绝的动作**，也解释了 A 组观测到的「29 次调用零成功 integrate」并非 agent 用错。

无法续做的抛点：`execution-contract.ts:154-163`（cwd 落在 `PI_CODING_WORKSPACE_DIR` 内即拒），被 `extension.ts:1319-1331` 的兜底 catch 错标为 `SUBAGENT_RPC_FAILED` / `rpcOperation=spawn` / `causeCode=unknown`，而此时 `rpc.spawn()` 尚未执行。

---

## 3. High 级缺口

| # | 缺口 | 源码位置 | 类型 |
|---|---|---|---|
| H1 | git stderr 被设计性丢弃，只回 `git ... failed` | `git-worktree.ts:44-49,419-429`；`tool.ts:87-88` 只透传 `message` + `code/detail/keypath` | 信息缺失 |
| H2 | runtime 自产 artifacts 写进 worktree，成为 remove 阻断物；`removeUntrackedRuntimeMetadata` 时序不可靠 | 现场 `3b8d0a57` 的 `!! .pi/subagents/artifacts/*` | 自伤 |
| H3 | `workflow.reason` 三态条件（tdd 禁止 / 其余必填）schema 与 description 完全不可见 | `contracts/dispatch-ir.ts:144-153`；`extension.ts:63-71` | 可发现性 |
| H4 | skill 教「目录可用尾随 `/`」，源码硬拒 | `SKILL.md` vs `contracts/dispatch-ir.ts:134-136` | 文档投毒 |
| H5 | reminder 覆盖不全：5 workspace 只 3 次提醒 | `completion-reminder.ts:25-45` 只匹配 `subagent:async-complete` + 同 lifecycleSessionId + runId 唯一 + active/preserved，不覆盖 cleanup-debt / queued | 接线缺口 |
| H6 | 无 queue inspect agent tool；auto-integration inspect 为防泄漏过度收敛，连分类 reason 都不给 | `integration-queue.ts:235-242`；`coordinator-server.ts inspectAutoIntegration`；对照 `2026-09-13-auto-integration-inspect-information-leak.md` | 能力+信息缺失 |
| H7 | paused run 无 cancel / 改态 / 回收路径；`resume` 只作用于新 continuation，不改写原 paused 记录 | upstream `pi-subagents@0.62.0` `src/extension/rpc.ts:668-680` 硬限 `state==="running"` | 生命周期能力缺失 |
| H8 | `MODEL_NOT_AVAILABLE` 不返回候选清单；裸 id 是完整 id 段精确匹配，无 alias/substring | `model-selection.ts:27-33,54-101` | 可行动性 |
| H9 | 本地 preflight 错误 taxonomy 混乱（policy 拒绝冒充 RPC 失败，`causeCode=unknown`） | `extension.ts:1319-1331`；`errors.ts:47-55` | 归因缺陷 |

---

## 4. Medium 级缺口

| # | 缺口 |
|---|---|
| M1 | **submodule 全链路无适配**：worktree add 不做 `submodule init/update`（`git-worktree.ts:198-218`）；admission/rebase/publish 全程无 recursion（`:221-250,371-407,520-545`）；writePaths 无 submodule-aware 类型（`contract.ts:87-99`），`assertManagedWorkspaceWritePaths` 只匹配 `git diff` 路径（`:193-195`），父仓 gitlink 变更可静默通过，子模块内部 dirty / commit 是否发布 / branch-HEAD 与 gitlink 是否匹配均不校验 |
| M2 | `INVALID_PATH` 三种原因（绝对路径 / 非法 pattern / unsafe segment）共用泛化消息，不返回合法文法与反例 |
| M3 | 缺 `version` 的自诊断 heuristic 只看 `taskId/objective/workflow` 且只在 generic 三必填不足时执行；混入其他 coding-exclusive 字段时不 fail closed |
| M4 | ledger 状态集合（`reserved/allocating/active/disposing/preserved/released/cleanup-debt`，`ledger.ts:31`）与对外语义标签（`awaiting-disposition`/`integrated`/`discarded`）混用，文档与工具文案不一致 |
| M5 | RPC 无操作级 retry，timeout 后无幂等身份可查，盲目重试 spawn 有重复派发风险 |
| M6 | 64 child 只有 5 个走 managed worktree，59 个直接写仓库根/submodule；`worktree=false` 的 coding child 完全不纳入 queue，也无 completion gate 统计 |
| M7 | 长时诊断任务无增量落盘约束：C 组 40 次取证、零落盘，上游流一断全部丢失（靠 resume + 768KB session 上下文才救回） |

---

## 5. 遗留现场状态（未处置，保持原样）

```
var/workspaces/repositories/85369acc.../
  records/  01a2da1b=active   3b8d0a57/5c1844c9/6686ea46/c161c5e9=cleanup-debt
            （4 条 debt 的 disposition 均为 {action:"preserve", reason:"subagent workspace preserved"}）
  worktrees/  5 个目录全部存在，各 13 entries
  integration-queue/  1 item 卡 queued + 4 resume（3 failed / 1 starting）
  terminal-proof-outbox/  pending 5 / receipts 0 / debts 1 / supersessions 1

主仓 HEAD e07cd25a（refs/heads/main）—— 从未收到 rebase-ff publish
worktree 01a2da1b 有 pid 77416 pi 进程 cwd 驻留，sub2api/.git/index.lock 存在
```

合规处置路径（**仅人类 owner 执行，本次调查未执行任何一条**）：优先走 `administration.ts:198-245` 的 admin plan/reconcile；仅在 admin 面明确显示必须人工强制回收、且已确认无进程驻留、无 index lock、未提交内容已审核后，才考虑 `git worktree remove --force`。完整命令文本见 `C-workspace-mergequeue-rootcause.md` §10.2。

---

## 6. 对 D 组报告的两处更正（防止污染后续引用）

1. **§8 child 交叉验证「81.7% 吻合」不可作为健康指标。** 57 个不吻合几乎全是测量假象，主 agent 已实测验证两种成因：
   - **前缀漂移**：`2026-07-21` 会话 529 个 subagent 结果无一以 `Started executor` 开头（实际是 `Run: <id>\nState: running` / `Executable agents:`）；`2026-07-30` 会话 837 个结果前缀是 `Spawn budget: N/10000 used`。三代 renderer 文案，脚本只认最新一代。
   - **目录形态**：`2026-07-20` 会话 282 child 目录 = 278 `run-0` + 5 `run-1`（resume 产生额外 run-N）；`2026-07-30` 会话 child 目录根本不存在（已清理）。`child=0` 是目录缺失，不是 spawn 丢失。
   - 目标会话 **64 == 64 精确吻合**这一条仍然有效，可作为方法论验证。
2. **`MODEL_MATCH_USED_GLOBAL_CATALOG` T1=0 被标为「未出现」是误导。** 它是 `details.warnings` 里的**警告**而非前缀错误，T1 的前缀过滤抓不到；T2 中 read=163 / bash=39 可证其大量存在。

另：D v1 的全部绝对数字因同时计 `content` 与 `details` 而恰好虚高 2 倍，v2 已按 toolCallId 去重修正，并逐项复现主 agent 独立算出的权威基准（9/3/2/1、5/3/1/1、Started 64、拒绝 15、19.0%）。

---

## 7. 修复优先级建议

**第一优先（解锁本次实践）**
1. 把 `minItems:0` 真正落到 `contracts/dispatch-ir.ts`，并**删除孤儿 `src/subagent-dispatch/ir.ts`**，让 3 个 test 文件改 import canonical 入口（B1）。同时裁决「只读 coding 派发」的官方表达方式。
2. 给 cleanup-debt 一个 agent-visible 出口：`recover` / `release-authorize` action，或允许 preserved/debt 的只读 status + 授权式 force release（带审计，不隐式删用户内容）（B4/H1）。
3. git wrapper 从 `cause.stderr` 提取 bounded、脱敏、**分类**的原因（dirty / untracked / ignored-runtime-artifact / submodule-gitlink / submodule-nested-dirty / locked / path-missing / process-cwd），放进 `details`（H1/M1）。

**第二优先（止血慢性病）**
4. 排查 coordinator 为何从不 claim：`queued → admitted` 断点，对齐 `2026-09-13-real-runtime-enqueue-disconnect.md` 与 `2026-09-17-premature-enqueue-freezes-base-authorized-head.md`（B3）。
5. proof settle 失效：5 observed / 0 receipt，`trusted run binding is unavailable`（B3）。
6. 错误文本一次性给全修复模板：`boundaries` 完整形状、`workflow.reason` 三态表、`writePaths` 合法文法 + 反例、模型候选清单（B2/H3/H8/M2）。
7. 修 skill 的尾随 `/` 错误，并把 `dispose(integrate)` 在 auto-managed 下会被拒绝这一事实写进文档（H4/B4）。

**第三优先（结构性）**
8. branch-specific description / 字段矩阵，补偿根 schema 不能有 union 的约束（B2）。
9. submodule 显式政策：递归 init/clean 检查、gitlink 与子 commit 绑定、writePaths 不把 `sub2api/**` 当普通目录静默放行（M1）。
10. managed state-root worktree 的受信 continuation dispatch contract（B4）。
11. reminder 覆盖 cleanup-debt / queued / delivery-debt；启动时扫描 owned records 补幂等通知（H5）。
12. queue inspect agent tool，暴露 state / sequence / admissionGeneration / blocked reason / conflict digest，但保持 path/branch/head 裁剪（H6）。
13. 收敛 dispatch IR 单一 canonical codec，补 schema↔contract 一致性测试（当前测试盲区：coding 带 generic 字段、顶层 required 一致性、skill 的 `dir/` 声明、空 writePaths 穿过 production import）（B1/B2）。

---

## 8. 覆盖度分类（E 组比对结论，含主 agent 更正）

编写修复计划前，对 20 项缺口做了既有计划 / 缺陷文档 / 在途改动的覆盖度比对（`E-coverage-mapping.md`）。结果重排了优先级：

| 分类 | 缺口 | 计数 | 计划处理 |
|---|---|---|---|
| **已修但复现（回归）** | B1 B2 B3 B4 H2 H5 | 6 | 最高优先；必须先补 live 验收门，否则修完仍无法验证 |
| **新缺口** | H3 H8 M3 M4 M5 M6 M7 | 7 | 纳入新计划 |
| **已诊断未修** | H1 H6 H9 M1 M2 | 5 | 纳入新计划（有根因文档，无已完成修复） |
| **已规划未执行** | H4 H7 | 2 | 归 lifecycle-overall `P6-T9` / `P3-T6`，不新立任务 |

### 8.1 假 ACCEPTED 的根因

`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md` 的 **Task 9 步骤 8（真实五 Subagent 验收：2 roots / 5 children / 冲突 / CAS fast-forward / queue+worktree+process 结算）从未勾选**，而它是该计划唯一的 live 验收门。同时 Task 10 在 `:892` 把「child `awaitIntegrationAdmission()` 同步触发 claim」与 `admissionGeneration` 0→1 写成独立验收条款，并在 `:913-920` **勾选为通过**——而 live 现场那个 item 至今 `admissionGeneration: 0`。

合同级测试跑在「独立 temporary repo、session、state 和 socket roots」上（package README 明载），天然不含 submodule、真实 dirty origin、64 个并发 child 与上游断流。**验收体制因此在产出假信号**，这比任何单个缺口都严重。

### 8.2 主 agent 对 E 报告的一处更正

E 报告表格 M1 行判定为 `已诊断未修`（→ 纳入新计划），但 §2「已修但复现」专章仍残留一节 `### M1`。按 E 自己声明的判定口径（「已修但复现」仅用于**明确声称已修复**者），表格改判更严谨：unified-harness T6 勾选的只是 dirty-submodule RED primitive，从无「submodule 全链路适配完成」条款。**以表格为准：M1 属新工作，不是回归。**

影响：submodule 适配是 greenfield 而非修复既有实现，这加强了「先显式拒绝、递归支持另立计划」的取向（决策 D5）。

### 8.3 硬前置门禁

工作树的未提交改动经判定为 **lifecycle-overall P1-T2 / P2-T3 / P2-T4 / P3-T5 / P3-T6 的部分执行现场**（17 个 tracked 文件、684 insertions / 36 deletions，另有大量 untracked 的 authority/durable/control-plane 实现与测试），而这些任务的 RED/GREEN 复选框**全部未勾**。故：未完成，不能作为新计划基线；`extension.ts` 是双热点（在途已注入 Supervisor control-plane fencing/reply/steer，而 B2/H3/H9/M3 都要改同一文件）。

**新计划不得在混合工作树上直接开写，须先由 owner 决定提交或丢弃。**

### 8.4 据此修正的计划拆分

按**冲突面**而非子系统拆分（冲突面决定可执行性）：

| 计划 | 内容 | 碰 `extension.ts` | 可立即开工 |
|---|---|---|---|
| **B 零冲突合同速修** | B1 孤儿 IR + `writePaths minItems` · H8 模型候选 · M2 路径错误文法 · M4 ledger 标签 | 否 | ✅ 无需等工作树决策 |
| **A 验收体制与回归** | 补跑真实五-child live 验收 → 以 live 现场为回归基线 → B3 B4 H2 H5 + H1 git stderr 分类 + H6 queue inspect + M1 submodule 显式拒绝 | 否 | ⚠️ 需先与 merge-queue T10/T11 语义对齐，避免重复发明 `recover/retry` ABI |
| **C 合同面重构** | B2 schema 分支隔离 · H3 删 workflow · H9 错误 taxonomy · M3 version heuristic · M5 RPC 幂等 · M6 隔离覆盖 · M7 增量落盘约束 | 是 | ❌ 等工作树处置 + lifecycle-overall P3-T6 |
| 延后 | H4 → P6-T9；H7 → P3-T6 | — | — |

H3（删 `workflow`）另有隐藏约束：该字段被 dispatch IR、prompt、schema 与**历史 replay/contract 测试**共同读取，直接删除会造成旧记录与测试解码冲突，须先有一个「canonical 兼容边界裁决」前置任务。

---

## 9. 分报告索引

| 文件 | 内容 | 状态 |
|---|---|---|
| `A-session-forensics.md` | 会话取证：完整时间线、26 个唯一错误事件、5 workspace 终态、workaround 与 raw git 统计、认知负担量化、agent 原话摘录。264 个 `L<n>` 引用自检通过 | ✅ 已验收 |
| `B-dispatch-contract-rootcause.md` | 派发合同/模型路由/run 控制源码归因：逐错误 A–E、顶层字段一致性审计表、writePaths 完整文法 + 正例反例、错误文本改写建议、测试盲区。聚焦合同测试 33/33 通过 | ✅ 已验收（B1 由主 agent 独立 git 考古确证） |
| `C-workspace-mergequeue-rootcause.md` | workspace 状态机全图 + ASCII、死结证明、逐 workspace git 真因（含未证实标注）、信息丢失审计、merge queue 实效判定、submodule 适配性、缺口清单、合规处置命令文本 | ✅ 已验收（并纠正主 agent 两处过度断言） |
| `D-error-prevalence.md` / `.csv` / `prevalence_scan.py` | 跨 312 会话流行度：T1 runtime 真实拒绝 / T2 受污染源分离、派生指标、月度趋势、项目分布 | ⚠️ 数据可用，§8 与 `MODEL_MATCH_USED_GLOBAL_CATALOG` 两处结论已被主 agent 推翻，见本文 §6 |
