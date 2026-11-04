# goal-runtime 缺陷⑤与缺陷③调研报告（2026-11-04）

## 0. 输入、方法与代码基线

- 必读输入：`docs/investigations/2026-11-04-goal-runtime-usability-defects.md`（原始实测报告）。本报告不盲信其结论，对缺陷③⑤相关全部断言逐条源码复核，偏差在 §1.5 显式列出。
- 调研对象：`src/goal-runtime/`（index.ts、continuity.ts、session-state.ts、scheduler.ts、contract.ts）、`pi/extensions/goal-runtime.ts`、`docs/architecture/goal-runtime-v1.md`、`docs/bugs/2026-08-24-goal-runtime-idle-input-misclassified-as-amendment.md`、以及已安装 pi 包的 extension 类型声明（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`）。
- 代码基线：goal-runtime 全部文件来自同一提交 `b5730308`（feat(goal): 增加计划执行与多仓库支持），无更早演化历史；设计意图以该提交携带的架构文档与源码注释为准。
- 本任务为只读调研 + 本报告落盘，未修改任何 production 代码。

---

## 1. 事实核实（逐条 确认/修正）

### 1.1 缺陷⑤：goal 引擎实例在会话内的完整生命周期

**F1（确认 + 语义澄清）：不存在独立的「goal 存盘文件」。goal 状态唯一持久载体是 Pi session 文件（JSONL）内的 custom entry。**

- 状态条目 custom type 为 `goal-runtime.state.v1`（session-state.ts:48），证据条目为 `goal-runtime.check-result.v1`（session-state.ts:51）；写入仅经 Host 公共入口 `pi.appendEntry(customType, data)`（类型声明 session-state.ts:1006，index.ts:294-297 绑定到 `pi.appendEntry`）。
- `src/goal-runtime/` 全目录 grep 无任何 `writeFile`/自建状态文件；session-state.ts 头注释明确「不新建 journal/index/第二状态文件、全局 registry 或进程锁」（session-state.ts:9-21，关键句在 :15）。
- 推论：原报告所说「删除 goal 存盘文件」实际删除的是 **session JSONL 文件本身**（`binding.sessionFile`），即连同整个会话记录一起删除，而不只是 goal 快照。

**F2（确认）：会话内 goal 实例由三层内存态构成，磁盘只在「恢复核验」和「写入后落盘确认」两个时刻被读取。**

1. 组装层：`installGoalRuntime` 闭包变量 `current: GoalRuntimeSession | null`（index.ts:159）。
2. 存储层：`GoalStateStoreImpl.current`（冻结的 `GoalState` 快照，session-state.ts:1042 起）；`read()` 直接返回内存值且显式不做 I/O——「只读返回最后已核验状态；不做 I/O，不推进 revision」（session-state.ts:1026-1027、实现 1088-1090）。
3. Host 层：SessionManager 的内存分支索引；store 的 `readBranch` 即 `sessionManager.getBranch()`（index.ts:294-295）。即使存储层内存被清空，分支索引仍持有 goal 条目。

**F3（生命周期四问）：实例何时进内存、何时写盘、何时清除、重启如何恢复。**

- **进内存**：`session_start` 事件（reason ∈ startup/reload/new/resume/fork，types.d.ts:575-581）→ `start(ctx)`（index.ts:279-325）→ 先 `dispose()` 使旧 generation 失效 → `createGoalStateStore` → `session.ready` 内 `await session.store.restore()`（index.ts:312）→ `restoreNow()`（session-state.ts:1231）从「内存分支 + 同一 session 文件」双重核验后把快照发布进 `this.current`。
- **写盘**：每次业务转换（`update` / `replaceCancelled` / `checkpoint` / `writeEvidence`）经 `appendVerified`：`pi.appendEntry` → 在当前分支唯一定位条目 → `confirmPersisted` 重读同一文件核对 id/customType/内容/父链（session-state.ts:1431 起、1477 起）。append 或核验任一失败即对本实例设置不可写 latch（`assertWritable()` 此后抛错，session-state.ts:1105-1116）。
- **从内存清除**：唯一路径是 `dispose()`（index.ts:173-183），由 `session_shutdown`、下一次 `session_start`（换代）、`session_tree`（continuity.ts:256 → `start(ctx, false)`）触发。**不存在任何业务层面的「把实例从内存抹掉」入口**。
- **会话重启恢复**：新进程按 session 文件重建分支后走同一 `restore()` 双核验。文件已被删除时：会话本身已不存在（session 即文件），新会话分支无 goal 条目、文件缺失 → `assertNoLiveGoalRecord` 对 `SESSION_FILE_MISSING` 显式放行（session-state.ts:845），按「新空会话」恢复为无 goal。**即「删文件 + 重启」场景在现行设计下天然得到无实例语义，缺陷只发生在同会话内存生命周期内。**

**F4（确认）：plan_execute 的 GOAL_CANCELLED_REPLACEMENT_REQUIRED 拒绝路径，实例引用全部来自内存，全程不读 store 文件。**

调用链（均带行号证据）：

1. `plan_execute.execute`（index.ts:374-400）：`toolSession(ctx)`（index.ts:327）取**内存中的** session；`session.store.read()?.status === "cancelled"`（index.ts:383，内存读）判定走替换分支。
2. `session.runtime!.replaceCancelled(binding, contract)`（index.ts:389）→ scheduler.ts:342 `replaceCancelled`。
3. `read()`（scheduler.ts:262-265）→ `store.read()`（内存，见 F2）得 baseline；`baseline.status !== "cancelled"` 拒绝（scheduler.ts:350）。
4. 对每个有 run 的任务 `execution.inspect(task.run)`（scheduler.ts:358），`!sameRun || !closed(fact)` 即拒绝（scheduler.ts:360）。`closed` = `provedTerminal ∧ integrated ∧ workspaceState=released ∧ recovery=none ∧ blocker=null`（scheduler.ts:58-72，与原报告引用一致）。

因此删除文件后：内存中的 cancelled 快照与 scheduler 的 facts 缓存原样保留，重试 plan_execute 走同一路径、同样被拒——**这条路径上根本没有任何读盘行为，「读不到盘」不构成输入**。原报告现象确认。

**F5（补充事实）：单纯的「内存清理/重置」在现行架构下不可达，也不充分。**

- 若只清存储层内存再让新实例 bootstrap：`assertBranchContinuity` 发现「当前分支已有 Goal 状态条目，但本实例未恢复它」→ 以 `SESSION_STATE_CORRUPT` 拒绝覆盖（session-state.ts:1213-1227）。
- 若走 restore 而文件已删：`restoreNow` 把 `SESSION_FILE_MISSING` 转为 latch 阻塞（session-state.ts:1254-1258 的 `this.block(...)` 路径），本实例此后不可写。
- 即：同会话内建立新 goal 血统的唯一合法通道是**追加新状态**（`store.replaceCancelled`，session-state.ts:1123-1157）或换代重建，二者都绕不开「与既有分支事实和解」。

### 1.2 缺陷③现象 B：pi.on("input") 打回 paused

**F6（确认，行号级）：每条非 extension 输入在 goal 处于 active 时将其打回 paused。**

- 源码：continuity.ts:163-171。`if (event.source === "extension") return;`（165 行，goal 自身经 `pi.sendMessage` 发出的 continue 消息 source=extension，不会自暂停）；`if (!session || session.store.read()?.status !== "active") return;`（167 行，**仅 active 状态受影响**，paused/completed/cancelled 与无 goal 会话不受影响）；`session.suspended = true`（168 行）→ `control(session, "paused", "收到用户新消息或 steer，自动续跑已暂停；使用 /plan resume 恢复")`（169 行）。
- 触发条件精确化：input 事件在 agent 处理前触发（types.d.ts:909-921 注释 "Fired when user input is received, before agent processing"），`source ∈ {interactive, rpc}`（types.d.ts:908）；`streamingBehavior` 为 steer（流中）或 undefined（idle）均触发——与 164 行注释一致。`/plan` 等命令不经 input 事件，不会自暂停。
- 自动暂停当前**完全静默**：`control(..., "paused", ...)` 成功路径无任何 notify（continuity.ts:111-139 内无 UI 调用）；pauseReason 只能从 `/plan status` 或 `pi.on("context")` 投影（continuity.ts:201-217）间接看到。

**F7（护栏证据，三处）：该暂停是设计内护栏，不是副作用。**

1. 源码注释（continuity.ts:164）：「普通消息和 steer 均暂停；不解析自然语言推测新授权，也不消费用户原始输入。」
2. 架构文档 §9.4（docs/architecture/goal-runtime-v1.md）：「来自 interactive/RPC 的新消息或 steer 暂停自动续跑，不猜测其自然语言授权；既有 child 仍由通用 runtime 管理。」
3. 历史缺陷谱系（docs/bugs/2026-08-24-goal-runtime-idle-input-misclassified-as-amendment.md）：旧 goal-engine 曾把普通 idle 输入误判为 execution_amendment，处置结论确立「不得用自然语言猜测意图」原则；现行「一律暂停、要求显式 resume」是该原则的保守化落地。

护栏同时封住两条自动续跑通道：idle 时 `wakeIfIdle` 的 sendMessage 续跑（`session.suspended` 早退，index.ts:221-222）与 turn 内 `agent_before_settle` 的 `entries + continue:true` 自动续跑（index.ts:455；`session.suspended` 早退在 464-465 行）。若不暂停，用户消息的 turn 结束后 `agent_before_settle` 会在**无显式授权**的情况下自动续跑 goal——用户指令与 goal 自动推进交错，正是护栏要防的场景。

### 1.3 缺陷③现象 A：resume 后无续跑 turn

**F8（确认 + 关键修正）：resume 无 wake 仅发生在「无可推进事实」时；「resume 顺带 reconcile-wake」本身已是既有行为。**

- resume 完整路径：`/plan resume`（continuity.ts:154）→ `control(session, "active", null)`（continuity.ts:111-139）：
  - 121 行先 `reconcileGoalSession`（此时状态仍为 paused，`wakeIfIdle` 因 `state.status !== "active"` 早退，index.ts:221）；
  - 126-133 行经 store 写队列把状态更新为 active；
  - 137 行清 `lastWakeFingerprint`（保证去重指纹不残留旧值）；
  - **138 行 `if (status === "active") await runtime.reconcile(session)`** → `refreshRuns` → `wakeIfIdle`（index.ts:219-240）。
- `wakeIfIdle`（index.ts:219-240）：当 `next` 为 actionable（advance/retry/verify，判定在 index.ts:208-209）且 idle、无 pending 消息、无 latch/暂停/压缩/导航/恢复挂起等全部护栏满足时，`pi.sendMessage({customType:"goal-runtime.continue.v1",...}, { triggerTurn: true, deliverAs: "followUp" })`（index.ts:234-236）**主动排一个续跑 turn**。
- 因此：**next 可推进时，resume 已经会排 turn；「不排 turn」精确发生在 `next.kind ∈ {wait, blocked}` 时**（`if (!actionable(next)) return;`，index.ts:232）。此时唯一用户可见输出是 /plan handler 157 行的整份 JSON 状态——其中其实**已包含** `next.reason` 与人类可读 `guidance` 字段（index.ts:205，由 `describeGoalNextAction`（index.ts:143-157）生成的 wait/blocked 文案），但淹没在 JSON 里，用户观感即「resume 无效」。
- 修正结论：原报告期望的「或提供 resume 顺带触发一次 reconcile-wake 的语义」**不是缺失能力而是既有实现**；真实缺口收敛为「非 actionable 时缺少一行人类可读 notify」。

### 1.4 pi 的 turn/队列模型对 extension 主动排 turn 的支持（方案前提）

- 公共 API 明确支持：`pi.sendMessage(message, { triggerTurn?: boolean; deliverAs?: "steer"|"followUp"|"nextTurn" })`（types.d.ts:330-332、1258-1261）；types.d.ts:735 注释确认「A run started by `pi.sendMessage(..., { triggerTurn: true })` while idle」是一等运行来源（`BeforeAgentStartCustomEvent`）。
- turn 内续跑：`agent_before_settle` 返回 `{ entries, continue: true }`（goal-runtime 已在用，index.ts:480-484）。
- 与队列的互斥由既有护栏保证：`isIdle()`、`!hasPendingMessages()`、`settled`、指纹去重（index.ts:221-231），`deliverAs:"followUp"` 保证不打断进行中的 turn。
- **结论：goal-runtime 边界内即可完成「主动排 turn」，无需改动 pi 核心 turn/queue 模型。**

### 1.5 与原报告不一致的事实偏差（显式清单）

| # | 原报告表述 | 核实结果 |
| --- | --- | --- |
| D1 | 缺陷⑤「删除 goal 存盘文件」 | 不存在独立 goal 存盘文件；唯一载体是 session JSONL 内 custom entry（F1）。删除它等于删除整个会话记录。「删文件 + 重启会话」在现行设计下已天然得到无 goal 语义（F3），缺陷只在同会话内存生命周期内成立。 |
| D2 | 缺陷⑤期望「store 读不到时按无实例处理（需先确认会话 runtime 生命周期设计）」 | 与生命周期设计正面冲突（详见 §2.2）：会话代内 read 不做 I/O 是设计而非疏漏；分支索引持有条目使 bootstrap 被拒（F5）；「分支无 goal 条目 + 文件缺失 → 按无实例」的路径已经存在（session-state.ts:845）。 |
| D3 | 缺陷③期望「或提供 resume 顺带触发一次 reconcile-wake 的语义」 | 该语义已实现（continuity.ts:138 → index.ts:219-240，actionable 时 sendMessage triggerTurn 排 turn）；缺口只是非 actionable 时无可读反馈（F8）。 |
| D4 | 缺陷③现象 B「pi.on("input") 对每条非 extension 输入都把 active 打回 paused」 | 确认，且精确化：仅 `status === "active"` 时触发；interactive/rpc 的 idle 消息与 steer 均触发；goal 自身 continue 消息（source=extension）与命令不触发（F6）。 |
| D5 | 缺陷③「实操要求 resume 后零用户消息」 | 确认（F6 推论），且该暂停是三重证据支持的设计护栏而非副作用（F7）。 |
| D6 | （缺陷②位置描述，顺带记录）「control/resume → runtime.reconcile(session) 是唯一推进点」 | 不准确：reconcile 有四个触发点——execution.subscribe 通知（index.ts:272-278）、control(active)（continuity.ts:138）、agent_before_settle（index.ts:468）、execution availability 回调（index.ts:299-309）。与③⑤结论无冲突，仅记录。 |

---

## 2. 缺陷⑤方案评估（按会话 runtime 生命周期事实）

### 2.1 方案 a：会话内强制清理/重置的 typed 命令

**形态一（纯内存 reset，直接丢弃内存态实例）：不可行。** F5 已证：存储层内存清空后，下一次 bootstrap 写入被 `assertBranchContinuity` 以 `SESSION_STATE_CORRUPT` 拒绝（分支索引仍有 goal 条目）；走 restore 则因文件缺失 latch 阻塞。该形态也直接违反模块头注释边界「新实例只能凭实际文件重新核验」（session-state.ts:15）。

**形态二（admin 强制闭合 + 复用正常替换通道）：可行，推荐，且应与缺陷④的 admin 闭合命令合并设计。**

- 形态：`/plan` 新子命令（如 `/plan force-close`）或 typed 工具，语义 = 在 `status === "cancelled"` 前提下，为每个 `task.run`/`workspaceId` 引用取得「已闭合」处置结论，然后**仍经 `store.replaceCancelled` 追加全新状态**（session-state.ts:1123-1157）——不删除任何历史条目、不绕过写队列、不改 SessionManager 内部状态、不新建第二状态文件。
- 安全门（防误删活跃计划 / 防资源失管）：
  1. **状态门**：仅 cancelled 实例可强制闭合；active 必须先 `/plan cancel`（保留用户显式动作作为第一道闸）。
  2. **资源核对门**：逐 run `execution.inspect` + workspace released 核对；inspect 给不出闭合事实（缺陷①④的死锁场景）时不允许静默通过，必须降级为「用户显式 typed 确认」路径，并把确认事实（谁、何时、确认了什么）写入新状态的 checkpoint 留痕。
  3. **交互确认门**：命令路径用 `ctx.ui.confirm`（pi ExtensionUIContext 支持，types.d.ts:548）二次确认；文案说明不可回滚性与残余风险。
  4. **不释放资源**：命令与 `/plan cancel` 同语义——不停止 child、不清理资源（continuity.ts:142 命令描述）；它只解除「内存实例对未闭合事实的阻塞」，资源处置仍走 subagent/managed workspace 的 typed 路径。
- 与资源释放的关系：强制闭合**不等于**资源已释放；它把「证明闭合」的责任从 adapter facts 转移到用户 typed 收据。这正是缺陷①④场景（事实链断裂、inspect 永远给不出 closed）下唯一不撒谎的出口。

### 2.2 方案 b：store 读不到时按无实例处理

**按生命周期事实评估：与设计正面冲突，不推荐。**

- **与内存态权威性的矛盾是结构性的**：会话代内 `read()` 不做 I/O 是显式设计（F2）；「读不到=无实例」要求把「文件缺失/不可读」降级为 null，但分支索引仍持有 goal 条目，bootstrap 仍会被 `assertBranchContinuity` 拒绝（F5）——要让方案 b 成立必须**同时**放宽 read 与分支连续性核验，等于放弃「branch 身份 + 同一文件落盘」双重核验这一模块根基（session-state.ts:9-21 头注释；架构文档 §9.2「同一 Manager 内存中的 Goal entry 若没有文件证明，恢复保持 blocked」）。
- **破坏崩溃恢复语义**：文件缺失/IO 错误是完整性事件（崩溃、半写、误删、外部破坏）。按无实例处理会在这些场景下允许同一会话重建第二条 goal 血统，旧 run/workspace 引用从此脱离任何实例的管辖 → 子代理/worktree 资源失管、双派发风险。现行 latch（blocked 但 `plan_status`/`/plan status` 只读诊断仍可用）正是为守住这条线。
- **诉求已被既有设计覆盖的部分**：「重启后文件没了 → 无 goal」已经成立（F3、session-state.ts:845）；同会话内删除文件影响的是内存实例存活期，这不是「读不到」语义能解决的问题，而是「cancelled 实例既不能修也不能换」的缺陷④死锁问题的投影。
- 结论：**拒绝**。若强行采纳需推翻双重核验并重新论证资源安全，收益（省一次会话重启）远小于风险。

### 2.3 方案 c：仅改进错误信息指引

- 位置：scheduler.ts:350、354、360 三处 `GOAL_CANCELLED_REPLACEMENT_REQUIRED` reject 文案（工具层经 runTool 包装为 error reason 返回，index.ts:347-353）。
- 建议内容：指明「被拒实例持有于当前会话内存与 session 分支索引中，删除存盘文件不影响本会话判定；处置路径：①核实资源闭合后经 admin 强制闭合命令（与缺陷④共用入口）；②若 session 文件已被删除，重启会话后旧 goal 随会话一并消失，可直接重新 plan_execute」。
- 评估：零风险、立即可做。但只治标：缺陷④的 `closed()` 恒假死锁仍在，用户拿到指引后依然没有可用出口——必须与方案 a 形态二配套，单独实施价值有限。

**缺陷⑤推荐：c（立即，纯文案）+ a 形态二（与缺陷④ admin 闭合合并设计）；拒绝 b。**

---

## 3. 缺陷③方案评估

### 3.1 方案 a：resume 后无可推进事实时的明确 notify

- **触发条件（精确）**：`/plan resume` 成功（`control(active)` 未抛错）后，读取 `runtime.status(session).next`；当 `next.kind ∈ {wait, blocked}`（非 actionable）时输出一行人类可读提示；`next.kind ∈ {advance, retry, verify}` 时不输出——此时 `wakeIfIdle` 已排续跑 turn（F8），用户能看到实际推进，再提示反而噪音。
- **通道**：沿用既有 `ctx.ui.notify(text, level)`（continuity.ts:149、157 已在用），**不新开通道、不改动 JSON 输出结构**：157 行的整份 JSON（含 next/guidance 机器可读事实）是设计内成功输出，保留；在其前追加一行 "info" 级摘要。文案直接复用 `describeGoalNextAction(next, planPath, revision)`（index.ts:143-157）或 `next.reason`，例如「已恢复；当前无可推进事实：t1 运行事实读取失败…。事实变化后将自动续跑，无需重复 resume」。
- **边界合规**：notify 是 UI 层人类可读投影，不进入 transcript、不改写 agent 收到的消息/事实，符合 TUI 精简边界规范（渲染投影只发生在展示层）。
- 风险：与 JSON 输出信息重复——可接受（一行给人、整份给机器）；如嫌重复可把摘要并入 JSON 顶层字段，属实现细节。

### 3.2 方案 b：resume 顺带触发一次 reconcile-wake

- **事实**：已存在（F8）。`control(active)` 末尾 `runtime.reconcile`（continuity.ts:138）→ `wakeIfIdle`（index.ts:219-240）在 actionable 时 `pi.sendMessage(..., {triggerTurn:true, deliverAs:"followUp"})` 排 turn。
- **与现有 turn/队列模型的冲突分析**：
  - pi 公共 API 已把「idle 时 extension 触发 turn」列为一等运行来源（§1.4，types.d.ts:330-332、735），turn 内续跑经 `agent_before_settle` 返回 `{entries, continue:true}`（index.ts:480-484）。**无核心模型冲突、无需越出 goal-runtime extension 边界。**
  - 与用户消息队列的互斥由既有护栏保证（isIdle / !hasPendingMessages / settled / 指纹去重，index.ts:221-231）。
  - 若把 wake **扩展到非 actionable 状态**（强制排一个「汇报用」turn）：与设计正面冲突——`wait` 的工具指引明确「等待事实通知，不轮询」（index.ts:148），且 `recordProgressTurn` 对 `next.kind === "wait" || "done"` 显式豁免无进展计数（scheduler.ts:688 起），说明设计上就不希望在无可推进事实时消耗 turn。空 turn 只会烧一次模型调用、制造「动了但没进展」的错觉。不推荐。
- **结论**：方案 b 无需实现（能力已在）；缺口收敛为方案 a 的 notify。

### 3.3 现象 B 的替代护栏评估

- **保留护栏 + 补可发现性（推荐）**：暂停语义本身正确（F7 三重证据）。当前问题是**静默**——input 暂停无任何 UI 反馈（F6）。修补：在 continuity.ts:163-171 的 input handler 中，`control(paused)` 成功后追加一行 `ctx.ui.notify("Goal 已因新用户消息自动暂停；/plan resume 恢复", "info")`，把「隐形踩雷」变为「显式提示」。注意 167 行已保证仅 active→paused 转变会走到这里，无重复提示问题；若嫌每条消息都提示，可按 pauseReason 去重（实现细节，见开放问题 4）。
- **替代 1「仅事实未闭合/存在自动续跑可能时才暂停」**：弱化护栏。缩小暂停条件需要重新论证「用户消息≠授权」原则（F7-3 的历史教训正是输入误分类），且收益有限——wakeIfIdle 的 hasPendingMessages/settled 护栏已避免与用户消息队列交错；真正依赖 pause 的是 settle 自动续跑通道。属产品语义决策，列为开放问题 2，本报告不建议。
- **替代 2「resume 后宽限一条消息」**：引入时间/计数窗口状态，直接与护栏目的（防用户指令与自动推进交错）冲突，且增加状态机复杂度。不推荐。

**缺陷③推荐：a（resume 非 actionable 时一行 notify）+ 现象 B 静默暂停补 notify；b 不需要；不放宽 input 暂停条件。**

---

## 4. 推荐与影响面

| 缺陷 | 推荐 | 改动点（文件:行） | 影响面 | 风险 |
| --- | --- | --- | --- | --- |
| ⑤-c | 改进 GOAL_CANCELLED_REPLACEMENT_REQUIRED 文案 | scheduler.ts:350、354、360 | 错误消息消费者（agent 工具回执 + 用户）；无行为变化 | 无 |
| ⑤-a2 | admin 强制闭合命令（与缺陷④合并设计） | continuity.ts（/plan 子命令）、scheduler.ts（replaceCancelled 前置门复用）、可能 index.ts（若走 typed 工具） | goal-runtime extension 内；需与缺陷①④调研线对齐入口与安全门 | 误用（对资源未闭合的实例强行替换）→ 由 §2.1 三道安全门缓解；用户谎报闭合 → typed 收据留痕审计 |
| ③-a | resume 非 actionable 时一行 notify | continuity.ts:154-157 附近（resume 分支后判定 next） | 仅 UI 输出，不改状态机 | 低（信息重复可接受） |
| ③-B | input 自动暂停补 notify | continuity.ts:163-171 | 仅 UI 输出 | 提示频率噪音（可按 pauseReason 去重） |

实施顺序建议：③-a + ③-B（最小 UX 修补，独立可交付）→ ⑤-c（纯文案）→ ⑤-a2/④合并设计（需授权与跨线对齐）。

**边界声明**：全部推荐方案均未越出 goal-runtime extension 边界——pi 核心 turn/queue 模型无需任何改动（sendMessage triggerTurn 公共 API 足够，§1.4）。

## 5. 与缺陷①④方案（另一路调研）的接缝

- 缺陷④的「admin 强制闭合命令」与缺陷⑤-a2 是**同一命令的两面**：④解锁「cancelled 死实例可替换」（让 `closed()` 门可满足或显式接管），⑤提供「事实不可得/文件已删」时的兜底出口。应同一入口、同一套安全门（状态门 + 资源核对门 + typed 收据留痕），避免两套 admin 语义并存。
- 若①④侧选择「replaceCancelled 按 resume 血缘解析最终 run / 接受 integration-queue 台账证据」使 `closed()` 可正常满足，则⑤-a2 的使用频率大幅下降、仅剩罕见兜底——两线实施顺序相互影响优先级（见开放问题 3）。
- ⑤-c 的错误文案应引用④侧最终确定的命令名，两报告合入时需对齐。

## 6. 开放问题

1. **admin 强制闭合的入口形态**：`/plan` 子命令（人在 TUI、可 ui.confirm）vs typed 工具（agent 路径、需参数化确认）vs 两者兼有？涉及授权边界（未获用户确认的强操作不得由 agent 自行执行），需主管/用户决策。
2. **input 暂停条件是否收窄**（§3.3 替代 1）：产品语义决策，涉及「不解析自然语言推测授权」原则的适用范围，本报告不建议放宽，列出供决策。
3. **⑤-a2 与④侧方案的先后**：若④侧修复使 replaceCancelled 门可正常通过，⑤-a2 降级为低频兜底；先做④则⑤的紧迫性下降。
4. **auto-pause notify 去重**：每条用户消息提示一次是否过吵；可按「同一 pauseReason 只提示一次」去重，属实现细节。
5. **（超出本报告边界的决策点）**若未来产品要求「非 actionable 也排汇报 turn」，将与 wait 豁免无进展计数的机制（scheduler.ts recordProgressTurn）冲突，需重新设计 goal-runtime 的推进经济学——届时才可能触及 pi turn 模型边界；当前所有方案均不需要。
