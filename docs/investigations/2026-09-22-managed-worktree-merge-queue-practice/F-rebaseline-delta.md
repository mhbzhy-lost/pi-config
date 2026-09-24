# F — 新基线重验：20 项 runtime 缺口在 lifecycle 改造（P0–P6）后的 delta

> 基线：commit `3086d2b`（HEAD）+ 当前工作树（26 tracked 已改 / 34 untracked，全部未提交）。
> 本报告只做「是否仍成立」的事实判定与影响评估，不提出修复方案。
> 原始归因见 `00-INTEGRATED-runtime-gap-report.md`；覆盖度比对见 `E-coverage-mapping.md`。
> 行号以**当前工作树**为准；文件未被本批次触碰时行号与 HEAD 一致，不再单独标注。

---

## 1. 20 项 delta 总表

| 缺口 | 原判定 | 新基线判定 | 变化原因 | 新行号证据 | 对修复计划的影响 |
|---|---|---|---|---|---|
| **B1** 孤儿 IR + 假绿测试 | 成立 | **仍成立，且修复面扩大** | 本批次未触碰；另发现**第二个孤儿** `subagent-dispatch/prompt.ts`（生产 renderer 是 `contracts/dispatch-ir.ts:275`，extension.ts:7 import canonical；prompt.ts 的 `renderCodingDispatchPrompt` 仅 3 个 test import） | canonical `contracts/dispatch-ir.ts:168` 仍 `minItems: 1`；孤儿 `ir.ts`（11.5K）仍在，importer 仅测试；**`prompt.ts:1` 还从孤儿 `./ir.ts` import `CodingDispatchContractError`**；测试 `subagent-dispatch-validation-errors.test.mjs:7,90`、`subagent-dispatch-ir-coercion.test.mjs:4`、`subagent-dispatch-ir.test.mjs:7,9`、`pi-subagents-runtime.integration.mjs:10` | 计划 B 的 B1 条目从「删 1 孤儿 + 改 3 test」变为「删 2 孤儿（ir.ts+prompt.ts）+ 改 5 个 test import」；仍是零冲突速修 |
| **B2** Schema 与 contract 系统性漂移 | 成立 | **仍成立（一处微修）** | 本批次只修了 generic `task` 的长度漂移：schema 删 `maxLength:65536`（字符数），contract 侧 `generic-prompt.ts` 新增 `MAX_TASK_BYTES=64KiB` 字节预算（:7,:89）——schema 与 contract 的这一处单位不一致被消除 | 根节点仍无 `required`（仅嵌套 :67/:78/:93/:105）；根级 union 注释仍在 `extension.ts:44-48`；schema 定义 :50；generic-only 字段仍平铺 :131-146（task/cwd/output/outputMode/artifacts/progress/worktree/skill/reads）；coding compiler 全必填仍 `dispatch-ir.ts:212-235` | 计划 C 不变；B2 的「一次性给全字段矩阵」仍待做 |
| **B3** queue 从不 claim / proof settle 0/5 | 成立 | **仍成立** | `integration-queue.ts`、`coordinator-server.ts` 均未改；新增 durable/replay/authority 层无一调用 `claimNext`，不改 proof settle 消费方（见 §4） | `claimNext` 仍 `integration-queue.ts:234-241`，全仓唯一生产调用点 `coordinator-server.ts:76`（`awaitIntegrationAdmission` :66）；live 现场 item `0ed45c9b` 仍 `state:"queued"/attempt:1/revision:3/admissionGeneration:0`；`terminal-proofs.json` 仍 pending 5 / receipts 0；records 仍 1 active + 4 cleanup-debt（全部 preserve） | 计划 A 的 B3 归因不变；可额外利用新 `recovery-resume-contract.ts:125-136,164` 的 queue 指纹做漂移检测积木 |
| **B4** cleanup-debt 无 agent 出口 + 无法续做 | 成立 | **仍成立** | `recovery-resume-orchestrator.ts` 新增的 `recoverOrphanRun` 是**孤儿 run 级 rebind**，不是 workspace cleanup-debt 恢复，且**无生产调用方**（见 §3） | action union 仍只有 list/status/dispose/release（`workspace/tool.ts:3,7,10,19`），无 reconcile/recover；state-root cwd 拒绝仍 `execution-contract.ts:163`（`if (stateRoot && contains(stateRoot, cwd)) fail(...)`）；admin 面仍 `administration.ts:198-247`；`service.ts:586-617` release/legacyRelease/markDebt 原样；SKILL.md:130-145 仍把 `dispose(integrate)` 当正常路径宣传（`:141`） | 计划 A 不变；新增事实：service.ts:246-249（HEAD 既有）`recordTerminalProof` 在 authoritative proof 下可把 cleanup-debt 翻回 active——非本批次新增，且不构成 force-release 出口 |
| **H1** git stderr 设计性丢弃 | 成立 | **仍成立** | `git-worktree.ts` 未改 | `:44-50` 与 `:53-59` 两处 `catch (cause) { throw failure("MANAGED_WORKSPACE_GIT", \`git ${args.join(" ")} failed\`, cause) }` 仍不提取 `cause.stderr`；通用路径 :462 同 | 计划 A 不变 |
| **H2** runtime 自产 artifacts 绊倒回收 | 成立 | **仍成立** | `git-worktree.ts` 未改 | `removeUntrackedRuntimeMetadata` 定义 :92，调用 :427 仍在 `releaseManagedGitWorkspace`（:419-438）内、`git worktree remove`（:429）**之前**；失败重试窗口内仍可被重建 | 计划 A 不变 |
| **H3** `workflow` 三态条件不可见 | 成立 | **仍成立；删除阻碍清单更新** | schema 仍声明 workflow（`extension.ts:64-72`）；条件约束原样；新增 11 个 durable/replay/authority 文件**零处**读取/持久化 `workflow`（grep 0 命中），durable envelope 是不透明 JSON+digest（`durable-contract.ts:23-30`），`ReplayCursorV1`/`InventoryV1` 无 workflow 字段；新测试文件零 `workflow` 引用 | 条件约束 `dispatch-ir.ts:148-152`（tdd 禁 reason :149 / 其余必填 :152）；行为分支仍只有 compiler `normalizeWorkflow` 一处（dispatch-ir.ts:146-152）；live 渲染在 canonical `dispatch-ir.ts:259,276,288`；原报告引用的 `prompt.ts:17,61` 是**孤儿文件**（随 B1 删除） | 删除的既有阻碍（canonical compiler/renderer + schema + 既有 contract 测试 + SKILL.md:127 文案 + 历史记录）不变；**未新增** replay 解码冲突；反而 prompt.ts 孤儿随 B1 一并消失。可与 B1 合并执行 |
| **H4** skill 路径文法错误 | 成立 | **仍成立；两份副本同步地错** | 本批次 SKILL.md diff（+15 行）只新增「生命周期与控制面边界」章节（:66-80），未碰文法句 | 错误句原样在工作树 `SKILL.md:122`（HEAD :107，漂移 +15）；已安装副本 `/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md:122` **内容一致**；源码仍硬拒 `src/`（`dispatch-ir.ts:136` `base.endsWith("/")` → INVALID_PATH） | P6-T9 已完成但**没有修它**→ H4 失去归属，应收回计划 B（见 §6） |
| **H5** completion reminder 覆盖不全 | 成立 | **仍成立** | `completion-reminder.ts` 未改；新文件无 reminder 路径（`supervisor-replay.ts` 的 completion receipt 是用户可见 completion 的 exactly-once 去重，不是 debt/queued 通知） | 过滤仍 `completion-reminder.ts:33-38`（仅 `subagent:async-complete` + 同 lifecycleSessionId + active/preserved） | 计划 A 不变 |
| **H6** 无 queue inspect agent 面 | 成立 | **仍成立** | `workspace/tool.ts` 未改 | action union（:3,7,10,19）无任何 inspect 动作（grep 0 命中） | 计划 A 不变 |
| **H7** paused run 无 cancel | 成立 | **仍成立** | upstream pinned 未变；新 control-plane 只做 reply/steer fencing（`supervisor-control-plane.ts:14` kind 联合仅 `"reply"\|"steer"`），无 paused 改态；`root-session-owner.ts` 新增的是 child 侧 lease 过期自杀（SIGTERM），非 supervisor 侧取消 | upstream `node_modules/pi-subagents/src/extension/rpc.ts`：`status.state !== "running"` → `invalid_state`（"stop only supports running async runs"，约 :679-681） | 仍被 upstream 版本 pin 阻塞；P3-T6 完成但不覆盖此项（见 §6） |
| **H8** `MODEL_NOT_AVAILABLE` 不返回候选 | 成立 | **仍成立** | `model-selection.ts` 未改 | `ModelSelectionError` 仍只存 requested/agent（:27-33，消息 :31 无候选清单）；完整 id 精确匹配仍 :66-67 | 计划 B 不变 |
| **H9** 本地 preflight 冒充 RPC 失败 | 成立 | **仍成立（行号漂移 +63）** | 本批次在 executeControl 前后插入 control-plane 代码使后续行整体下移；逻辑逐行等价 | 兜底 catch 现 `extension.ts:1382-1396`（code 推断 :1383、isRpcFailure :1384、rpcOperation 由 trace.stage 推断为 spawn :1388）；state-root cwd 拒绝仍 `execution-contract.ts:154-163`（同行号）；`errors.ts:53` `causeCode: ... : "unknown"` 原样（:47-55） | 计划 C 不变，引用行号需更新 |
| **M1** submodule 全链路无适配 | 成立 | **仍成立** | `git-worktree.ts`（607 行）中 "submodule" 零命中；`contract.ts` 未改 | admission/rebase/publish 块 :221-250,:371-407,:520-545 无递归；`contract.ts:87-99` writePaths 仍是普通 path 列表 | 计划 A 不变（greenfield 取向不变） |
| **M2** `INVALID_PATH` 三因共用泛化消息 | 成立 | **仍成立** | `contracts/dispatch-ir.ts` 未改 | 三条消息 :132（repo-relative）/:136（unsupported pattern）/:139（unsafe segment），均无合法文法与反例 | 计划 B 不变 |
| **M3** 缺 version 自诊断 heuristic | 成立 | **仍成立（行号漂移 +9）** | 同 H9 的整体下移 | heuristic 现 `extension.ts:918-919`，仍只检查 `taskId/objective/workflow` 三键 presence，混入其他 coding-exclusive 字段仍不 fail closed | 计划 C 不变；若删 workflow（H3），heuristic 的第三键要同步改——**C 内部新增耦合点** |
| **M4** ledger 状态名与语义标签混用 | 成立 | **仍成立** | 两文件未改 | `ledger.ts:31` STATES 集合原样；`service.ts:176-177` markDebt→`cleanup-debt`；外部标签 `awaiting-disposition` 仍只存在于文档（`docs/bugs/bug-subagent-dispatch-cannot-request-managed-worktree.md:22`）与 SKILL.md:134 | 计划 B 不变 |
| **M5** RPC 无操作级 retry / 无幂等身份 | 成立 | **仍成立（新增不构成修复的局部缓解）** | 新 control-plane 引入幂等 receipt，但（a）仅覆盖 `reply`/`steer`（:14），**不含 spawn**；（b）receipts/requests 均为**进程内 Map**（:55-56），非 durable，crash 即失效；`rpc-client.ts` 零 retry/idempotency（grep 0 命中） | `supervisor-control-plane.ts:56,81-82`（in-memory receipts + 幂等键）；`replay-barrier.ts` 全文为 replay 游标/高水位屏障，与 RPC 重试无关 | 计划 C 的 M5（spawn 幂等）不变；R1/R2 残留还会再改同一文件，需排程协调 |
| **M6** 隔离覆盖率低 / `worktree=false` 不入队 | 成立 | **仍成立** | 本批次唯一触碰的 isolation 测试只是**源码文本断言更新**（追踪 authorityStore 接线），非新隔离覆盖；无 completion gate 新增 | `test/subagent-runtime-resource-isolation.test.mjs` diff 仅 4+/1-（断言 `new AuthorityStore(...)` 接线） | 计划 C 不变 |
| **M7** 长时诊断无增量落盘约束 | 成立 | **仍成立** | durable 层持久化的是**协议事件/receipt/inventory 引用**（`durable-run-registry.ts` InventoryV1 仅含引用与 provenance），不涉及 subagent 工作产物增量落盘 | `durable-run-registry.ts:6-13`；envelope payload ≤32KiB（`durable-contract.ts:29`） | 计划 C 不变；M7 仍属派发协议之外的问题 |

**总表结论：20 项全部仍成立，无一被本批次解决；B2 有一处微修（generic `task` 长度单位），M5/H3 各获得不构成修复的旁路能力或删障更新；B1 修复面扩大（+1 孤儿文件 +2 test 文件）。**

---

## 2. 本批次实际改了什么（git diff 语义摘要，按文件）

### 与 20 项缺口相关的改动（3 个被触碰文件 + 接线）

| 文件 | diff | 语义 | 关联缺口 |
|---|---|---|---|
| `src/subagent-dispatch/extension.ts` | +74/-7 | ① generic `task` 删 schema `maxLength`（配 `generic-prompt.ts` 的 64KiB 字节预算）；② `executeControl` 的 `ste`eer 走 control-plane fencing（resolve→rpc→commitDelivery，失败 commit `SUPERVISOR_STEER_DELIVERY_FAILED`）；③ 新 `createControlledSupervisorAdapter` 对 `reply` 做同构 fencing（无 pending request → `SUPERVISOR_REQUEST_NOT_PENDING`）；④ 注入 `supervisorControlPlane` 选项 + `message_end` 时注册 supervisor request | B2 微修；H9/M3 仅行号漂移；M5 局部缓解（reply/steer） |
| `recovery-resume-orchestrator.ts` | +66（另有既有内容） | 新增 `recoverOrphanRun`：孤儿 **run** 级 11 门 rebind 组合（runAuthorization→…→ack），输出 `rebound/blocked-unknown/debt`；带 runId 级 Promise 缓存与 provenance 脱敏 | B4 专项评估见 §3（结论：无关） |
| `skill-overrides/subagent-dispatch/SKILL.md` | +15 | 新增「生命周期与控制面边界」章节（两进程 stop/drain、resume 新 incarnation、reply/steer 语义、completion exactly-once、authority lease、orphan recovery 禁止承诺自动恢复） | H4 未触碰（错误句原样）；该章节与 P6-T9 对应 |

### 本批次其余改动（与 20 项缺口无关或仅间接）

| 文件 | diff | 语义 |
|---|---|---|
| `extensions/subagent-runtime.ts` | +28/-1 | 构造 `supervisorControlPlane`（readOwnerReceipt/readRuntime 基于 broker+rpc.status），`RootBrokerServer` 接入 `AuthorityStore`（`$PI_CODING_WORKSPACE_DIR/root-broker-authority/<rootSessionId>`），注入 extension |
| `root-broker-server.ts` | +140/-1 | durable authority：verified run 落 owner receipt+lease（确定性 receiptId）；heartbeat 定时续租（HEARTBEAT_RENEW_MS/LEASE_MS）；broker 方法 `owner.read/owner.rebind/owner.revoke`（CAS+processBirth 校验）；terminal 后 `trackTerminalLeaseRelease`（失败入 `leaseReleaseDebt`）；`lease.updated` push |
| `root-broker-protocol.ts` | +13/-2 | METHODS 增 owner.*，PUSH_TYPES 增 `lease.updated` 及其字段校验 |
| `root-broker-client.ts` | +8 | 客户端 owner.* 方法 |
| `child-extensions/root-session-owner.ts` | +28/-8 | child 消费 `lease.updated` 更新本地 expiresAt；**删除**了原先 terminate 时的 `pi-root-session-closing-v1` sendMessage，改为 SIGTERM + terminationReason |
| `src/contracts/generic-prompt.ts` | +4/-3 | `MAX_TASK_BYTES=64KiB`（task 专用字节预算，其余字段仍 4KiB） |
| `src/task-scheduler/adapter.ts` + `pi/extensions/task-scheduler.ts` | M | P5：scheduler outcome union 接入（`consumeRecoveryOutcome` 消费/去重） |
| `test/*`（10 modified + 14 new） | — | 生命周期批次的测试面；其中 `resource-isolation` 仅源码文本断言更新 |
| `.gitignore` +3 | — | 忽略 `/pi/extensions/rtk.ts`（rtk 工具生成，无关） |
| `pi/AGENTS.md`、`pi/AGENTS_APPEND.md`、`pi/agents/reviewer.md`、`pi/settings.json` | M | 文档/用户预存编辑（reviewer.md 即 R6；settings.json 含 enabledModels 预存变更，未读取内容） |
| untracked：`src/context-usage/`、`pi/extensions/context-usage.ts`、3 个 context-usage 测试、docs 两篇 | — | **独立的 context-usage feature**，与生命周期和 20 项缺口均无关 |
| untracked：11 个 `src/subagent-dispatch/{durable,authority,lifecycle,supervisor,replay}-*.ts` | — | 新 durable/replay/authority 层（任务清单列了 8 个，实际 11 个——另有 `durable-contract.ts`、`durable-event-outbox.ts`、`durable-run-registry.ts`） |

---

## 3. `recovery-resume-orchestrator.ts` 专项评估（对 B4 的影响）

**结论：不改变 B4。它解决的是「孤儿 run 的 rebind」，不是「cleanup-debt workspace 的处置/续做」，且当前无生产调用方。**

函数级证据：

1. **新增面只有 `recoverOrphanRun`（:36-71）+ 类型/常量（:8-34）**，其余 ~230 行（`createRecoveryResumeOrchestrator`、RECOVERY_RESUME_PROMPT 等）是 HEAD 既有内容，本批次未改其语义。
2. `ORPHAN_GATE_ORDER`（:19-31）的 11 道门是 **run 身份链**：`runAuthorization → sessionEligibility → identity → broker(generation/revision) → workspace(managed-workspace.v2 receipt **match**) → inventory → rebind(CAS) → lease → barrier(ReplayCursor) → replay → ack`。其中 `workspace` 门只校验 run 绑定的 workspace receipt **匹配**，不做任何 workspace 状态迁移、dispose、release 或 cleanup-debt 清算。
3. 输出联合 `RecoverOrphanOutcome`（:10-13）= `rebound / blocked-unknown / debt`——`debt` 分支（:60）只是把失败登记为 recovery-debt，**与 workspace ledger 的 `cleanup-debt` 状态无任何代码交集**（全文件 grep `cleanup-debt` 零命中；11 个新文件同样零命中）。
4. 注释自证边界（:34）：「Compose the standalone orphan recovery gates; **this path never sends model/control messages**」——它不派发 child、不回 worktree 续做。
5. **无生产调用方**：`recoverOrphanRun` 全仓引用只有定义本身 + 2 个测试文件（`test/subagent-orphan-recovery.integration.test.mjs:11,82,95,104,140`、`test/recovery-resume-orchestrator.test.mjs:9,337`）。`extensions/subagent-runtime.ts` 未接线它（该文件 import 的是 `createRecoveryResumeOrchestrator`，HEAD 既有）。
6. B4 的两条硬阻断在新基线原样：`subagent_worktree` action union 仍无 `reconcile/recover`（`tool.ts:3,7,10,19`）；派 child 回 worktree 仍被 `execution-contract.ts:163` 的 state-root cwd 拒绝 + `extension.ts:1382-1396` 错标为 RPC 失败。

补充（非本批次变化）：`service.ts:246-249` `recordTerminalProof` 在 cleanup-debt + authoritative proof 时可翻回 `active` 并清 debt——这是 HEAD 既有代码，前提是拿得到 authoritative terminal proof，而 cleanup-debt 场景恰恰是 proof 链路断裂（B3）所致；它不是 agent 可用的 force-release 出口，B4 结论不变。

---

## 4. 新增 durable/replay/authority 层对 B3/H5/M5 的间接影响评估

**对 B3（queue claim / proof settle）——间接、不改变结论：**
- 无新增 `claimNext` 调用方：唯一生产调用点仍是 `coordinator-server.ts:76`（未改）。`queued→admitted` 断点原样。
- `recovery-resume-contract.ts:125-136,164` 对 queue item 计算 `state/revision/admissionGeneration/conflictDigest/candidateHead` 指纹——**只读的漂移检测积木**，不推进队列。
- proof settle 通道未改：`root-broker-server.ts` 的 `trackTerminalLeaseRelease`（+行）只在 terminal 之后**释放 authority lease**，不改变 proof 如何写入/结算 coordinator proof outbox；`terminal-proof-outbox/terminal-proofs.json` 的消费路径未被触碰。
- **一个正向积木**：历史上 debts 的 reason 是 `trusted run binding is unavailable`；新 `AuthorityStore` 使 `PI_CODING_WORKSPACE_DIR` 设置时每个 verified run 都有 durable owner receipt（root-broker-server diff :414-429 段）。这为**未来的** settle 修复提供了持久 run 身份，但（a）只对**本批次之后**绑定的 run 生效，（b）没有任何新代码消费它去 settle 既有 outbox。live 现场 5 个 observed proof / 0 receipt 的状态**不会自愈**（现场已复核：pending 5 / receipts 0 / item 仍 `admissionGeneration:0`）。

**对 H5（reminder 覆盖）——无影响：** `supervisor-replay.ts:9-44` 的 completion receipt 是「用户可见 completion 的 exactly-once 去重」（`durable-event-outbox.ts:68-69` kind=`user-visible-completion`），语义是防重复播报，不是对 cleanup-debt/queued 的**新增通知**。reminder 模块与其过滤条件一字未动。

**对 M5（RPC 幂等）——覆盖面错位：** control-plane 的幂等 receipt 只覆盖 `reply`/`steer`（`supervisor-control-plane.ts:14`），spawn 不经过它（`executeControl` 只拦 `action==="steer"`，`createControlledSupervisorAdapter` 只拦 `action==="reply"`）；且 receipts 是进程内 Map（:56），非 durable。M5 指出的「盲目重试 spawn 有重复派发风险」原样成立。`replay-barrier.ts` 是事件重放游标屏障，与 RPC 操作重试无关。

---

## 5. 计划可追溯性缺陷（P0–P6 复选框 9/60）

**事实：**
- `docs/plans/2026-09-20-subagent-lifecycle-overall.md` 共 60 个复选框，仅 9 个勾选，且 9 个**全部**位于「执行前自检（本次已修订）」章节（9/9）。P0–P6 的任务复选框：P0 0/11、P1 0/5、P2 0/10、P3-T5 0/5、P3-T6 0/5、P4 0/5、P5 0/5、P6 0/5——**任务面 0/51 勾选**。
- 验收证据**实际落点**：`.pi/handoff/context-handoff.md`（P0 :39「P0 已完成」、P1 :49、P2 :65/:78、P3-T5/T6 :150-190 含三组主测试 80/80、membrane 66/66 等、P4 :205-212 含 82/82、P5 :221-228 含 P0–P5 验收矩阵、P6 :242-244、总状态 :255-257「P0–P6 全部完成…236+ tests…全绿」）；`p4-p5-readiness.md`、`p6-fresh-context-baseline.md`、`p6-fresh-context-postupdate.md`（fresh-context 6/6 逐场景比对，结论「通过」）；P0 Colima 报告 `/tmp/subagent-lifecycle-p0-colima-report.md` 实际存在（5.2K）。
- **复选框为何未回写**：handoff 与 residuals 均无解释；handoff 记录的是无人值守 DAG 推进（「不要每个子任务后停」），各阶段完成时只写了 handoff 章节，未回写计划文件。这是流程缺陷而非证据缺失。
- **幻影 commit hash**：handoff 的 P5-T8/P6-T9 验收引用 `d98c4c41`、`5a6f8f8f`，两者在仓库中**均不存在**（`git cat-file -t` 失败）。产物全部未提交，这两个 hash 无法溯源（疑为 diff-check 摘要或意图提交的 hash）。
- **「已验收」的已知裂缝**：residuals R1 自认 P3-T6 验收标准「同一 user intent 至多一次实际 delivery」在并发解读下被违反（resolve→native→commit 非原子）；R3 自认真实 Pi crash 场景（P4 真实进程 lane）因 `PI_REAL_BIN` 未设而未跑。
- **旁证**：本次抽查 `node --test test/lifecycle-policy.test.mjs` → fail 0（与新基线自洽；未全量复跑，全量结论仍以 handoff + residuals R4–R7 为准）。

**对方法论的影响：**
「以计划勾选状态判断完成度」在**两个方向**都已被证伪——E 报告证明「勾了 ≠ 完成」（merge-queue T10 勾选通过而 live `admissionGeneration:0`），本批次证明「没勾 ≠ 未完成」（0/51 勾选但实现+验收真实存在）。后续任何计划都必须以「实现文件 + 可复跑验收命令 + 可追溯证据落点（且证据文件须纳入版本控制或稳定路径）」三元组判断完成度；`.pi/handoff/` 目前是 **untracked**，一旦清理即失证据，幻影 hash 问题会随未提交状态持续存在。

---

## 6. 修复计划拆分建议的修正

原拆法：计划 B（B1/H8/M2/M4，零冲突）｜计划 A（B3/B4/H2/H5/H1/H6/M1，验收体制与回归）｜计划 C（B2/H3/H9/M3/M5/M6/M7，碰 extension.ts，需等工作树处置）｜延后 H4→P6-T9、H7→P3-T6。

新基线逐条判定：

1. **H4 必须收回，不能再延后。** 其归属任务 P6-T9 已「完成」（handoff :242-244 + fresh-context 6/6），但 SKILL.md:122 的错误文法句原样（已安装副本同步地错）。继续延后 = 无主缺陷。建议移入计划 B（纯文档 + 不碰 extension.ts，与 B1/H8/M2/M4 同批零冲突）。
2. **H7 仍应延后，但理由变为 upstream pin。** P3-T6 完成的是 reply/steer 控制面，不含 paused-run 取消；阻断点在 pinned `pi-subagents@0.62.0` 的 rpc.ts 硬限 `state==="running"`。需要的是「升级 upstream 或包装层」的产品决策，不是本仓代码缺口。
3. **计划 C 的前置从「等工作树处置」变为「等 lifecycle 批次提交」。** extension.ts 的在途改动（control-plane fencing）已自洽（typecheck/测试面全绿声明 + 本次抽查通过），且其改动区域（executeControl/createControlledSupervisorAdapter/message_end）与 B2/H3/H9/M3 要改的区域（schema 定义 :50-159、heuristic :918、兜底 catch :1382）**不重叠**。但「稳定」的前提是先落 commit——否则 C 与 lifecycle 批次的 diff 无法区分归因。owner 需先决策提交/丢弃 lifecycle 批次（含 11 个新 durable/authority 文件与 ~24 个测试文件）。
4. **B1 修复面扩大**（+`prompt.ts` 孤儿、+2 个 test 文件），仍属零冲突速修；且顺带消除 H3 引用的孤儿渲染点。
5. **H3 与 B1 合并执行更优**：新 durable/replay/authority 层不读不存 `workflow`（§1-H3），删除不引入新 replay 冲突；剩余阻碍（canonical compiler/renderer、schema、SKILL.md:127、既有 contract 测试）本就属 C 面，而 M3 heuristic 的第三键（:918 `workflow`）随之要改——建议 C 内把 H3+M3 作为同一任务。
6. **B3 获得 durable owner receipt 积木**：计划 A 的 B3 归因（coordinator 不 claim、settle 无消费方）不变，但修复设计可以直接复用 `AuthorityStore`/`recovery-resume-contract` 指纹，不必再发明 run 身份。
7. **新增排程耦合**：residuals R1/R2 将再改 `supervisor-control-plane.ts`（与 M5 同文件）与 membrane 测试；若 C 先行需注明冲突面。
8. 计划 A/B 其余条目在新基线无变化（§1 总表）。

---

## 附：验证脚本与命令

- 批量核查脚本：`/tmp/wt-analysis/reports/rebaseline_check.py`（20 项关键行一次性提取）
- `git status --porcelain`（60 entries：26 M + 34 ??）
- `git diff -- <3 个被触碰文件>`（§2 语义摘要来源）
- `git cat-file -t d98c4c41 / 5a6f8f8f`（不存在 → §5 幻影 hash）
- live 现场只读复核：`var/workspaces/repositories/85369acc.../{records,integration-queue,terminal-proof-outbox}`（§1-B3 行）
- 抽查：`node --test test/lifecycle-policy.test.mjs` → fail 0
