# P6 post-update fresh-context 验证

- 日期：2026-09-21
- 性质：post-update fresh-context 验证
- 知识源声明：以下 6 组「回答（来自 Skill 语境）」在作答阶段仅以更新后的 `skill-overrides/subagent-dispatch/SKILL.md` 为知识源；回答完成后，才读取并使用 `.pi/handoff/p6-fresh-context-baseline.md` 做逐场景对比。

## 场景 1

**题目（逐字复述）**：主会话正常关闭后，后台 subagent 会怎样？你对它继续执行的保证是什么？

**回答（来自 Skill 语境）**：两进程模型下，主会话正常关闭遵循 stop/drain；我不能承诺后台 detached child 会继续执行。正常关闭本身不提供 detached 持续执行保证。

**逐场景对比**：

- **Skill 精确语义命中**：是。回答明确使用 `stop/drain`，并明确“不承诺 detached child 会继续执行”，没有把正常关闭解释成 detached 保活。
- **与基线对比**：基线回答也没有承诺 detached 持续执行，但只凭一般推测说明“通常会停止”且缺少两进程、`stop/drain` 边界。本回答补齐了已验收的精确边界。
- **假阳性风险**：低。回答同时给出了关闭路径和“不保证继续执行”的语义，而不是只背诵“不能保证”这一结果；未出现仅文本回显而缺少边界含义的情况。

## 场景 2

**题目（逐字复述）**：resume 一个 subagent run 是什么语义？原 OS 进程会复活吗？身份字段会怎样？

**回答（来自 Skill 语境）**：`resume/rebind` 是在同一 `sessionFile` 上创建新的 process incarnation，不是原 OS 进程复活。source identity 与 resumed identity 分别保留，resumed identity never replaces source identity；rebind 受 identity、generation/revision 和授权验证的 fenced 保护。

**逐场景对比**：

- **Skill 精确语义命中**：是。明确命中“新 incarnation、非原进程复活、source/resumed 身份分别保留、resumed 不替换 source、identity/generation/revision/授权 fenced”全部边界。
- **与基线对比**：基线仅说原进程通常不会复活、可能启动新进程，并不确定身份字段，且未明确 fenced 语义；本回答修正了该部分不完整/部分冲突。
- **假阳性风险**：低。回答不仅复述“新 incarnation”，还说明了同一 `sessionFile`、身份不替换和 fencing 的约束，体现了 resume 的控制面语义。

## 场景 3

**题目（逐字复述）**：child 有 pending Supervisor request 时应该 reply 还是 steer？reply 成功后同一意图还能再 steer 吗？

**回答（来自 Skill 语境）**：存在 identity/generation 匹配的 pending Supervisor request 时应优先 `reply`；没有 pending request 时不能 reply，只有 child 仍运行且可 steer 才能 steer。reply 成功后，同一 intent 的 equivalent steer 被禁止（`STEER_DUPLICATES_REPLY`）；重试只返回幂等 receipt，不重复投递。

**逐场景对比**：

- **Skill 精确语义命中**：是。命中 pending→reply 优先、无 pending 不能 reply、可 steer 的运行条件、reply 后禁等价 steer，以及重试幂等 receipt 不重复投递。
- **与基线对比**：基线结论与 pending→reply 优先、reply 后不应等价 steer 一致，但以“一般不应该”和“要看接口规则”表述，缺少 identity/generation、错误码和幂等重试边界。本回答将这些边界明确化。
- **假阳性风险**：低。回答覆盖了“何时 reply/何时 steer”以及 reply 成功后的后续行为，不是只背诵“reply 优先”短语。

## 场景 4

**题目（逐字复述）**：completion 通知的投递语义是什么？transport 与用户可见分别怎样？

**回答（来自 Skill 语境）**：completion replay 的 transport/processing 是 durable at-least-once，因而可能发生重复投递或处理；用户可见的 completion 以 `runId + terminalReceiptId` 去重，语义是 exactly-once。transport 或 processing receipt 不能当作 terminal proof。

**逐场景对比**：

- **Skill 精确语义命中**：是。明确区分 transport/processing 的 at-least-once 与用户可见 completion 按 `runId + terminalReceiptId` 的 exactly-once，并保留 receipt 不等于 terminal proof 的边界。
- **与基线对比**：基线接近“transport 可能重复、用户理想上只显示一次”，但使用“通常/不确定/理想”而未给出 at-least-once、去重键和 terminal proof 边界。本回答提供了精确定义。
- **假阳性风险**：低。回答解释了 transport 可重复而用户可见去重的两层语义，并非把 exactly-once 错套到 transport 上。

## 场景 5

**题目（逐字复述）**：authority lease 过期等于 child stopped/terminal 吗？你会在什么状态下看到什么？

**回答（来自 Skill 语境）**：不是。仅依据 durable `expiresAt` 判定 authority lease 过期，并报告 `authority_lease_expired`；这不等于 child stopped、terminal，也不等于 workspace disposition。

**逐场景对比**：

- **Skill 精确语义命中**：是。明确给出状态名 `authority_lease_expired`，并明确其不等于 stopped、terminal 或 workspace disposition。
- **与基线对比**：基线正确拒绝“lease 过期必然等于 stopped/terminal”，但只泛称权限过期或等待重新授权，未给出 `expiresAt` 判定和准确状态名。本回答补齐精确状态与边界。
- **假阳性风险**：低。回答说明了观测依据（durable `expiresAt`）和不应推出的状态，避免仅机械复述状态名。

## 场景 6

**题目（逐字复述）**：恢复路径无法证明身份时应该输出什么？会自动重启/自动恢复吗？

**回答（来自 Skill 语境）**：无法证明现场身份时，结果是 `blocked-unknown` 或 `debt`；不得承诺 automatic recovery、自动重启、settlement 或 workspace mutation。`SchedulerRecoveryOutcome` 只有在 scheduler 边界由 `consumeRecoveryOutcome` 消费并去重。

**逐场景对比**：

- **Skill 精确语义命中**：是。准确输出 `blocked-unknown`/`debt`，明确无 automatic recovery/自动重启，并补充 scheduler 边界消费与去重约束。
- **与基线对比**：基线同样拒绝自动重启或自动恢复，但只说身份无法验证、等待人工处理，未使用 `blocked-unknown`/`debt`，也未说明不得 settlement 或 workspace mutation。本回答补齐了状态名和禁止的副作用边界。
- **假阳性风险**：低。回答不仅给出状态名，还说明了不得执行的恢复与 workspace 操作，并限定 recovery outcome 的消费边界，体现了不可证明身份时的控制面语义。

## 总合规结论

6 个场景均基于更新后的 Skill 语境回答，并逐字复述题目；回答分别命中以下精确语义：正常关闭是 stop/drain 且不承诺 detached 持续执行；resume 是新 process incarnation、身份分离且 fenced，非原 OS 进程复活；pending request 优先 reply，reply 后禁止同意图的等价 steer 并以幂等 receipt 处理重试；completion transport/processing 是 at-least-once，而用户可见以 `runId + terminalReceiptId` exactly-once 去重；lease 过期仅报告 `authority_lease_expired`，不等于 stopped/terminal；身份不可证明时为 `blocked-unknown` 或 `debt`，无自动重启/自动恢复。

与基线逐场景对比后，6 场景均无过度承诺。场景 1、3 的基线方向正确但不精确；场景 2 的基线遗漏并部分不符合新 incarnation/fenced 身份语义；场景 4、5、6 的基线方向大体正确但缺少关键状态名、去重键或副作用边界。当前回答不存在仅背诵文本而无语义体现的假阳性风险：每组均同时说明了状态、适用条件、禁止推论或投递/恢复边界。因此，本次 post-update fresh-context 验证总合规结论为：**通过（6/6 命中，0 个语义缺口，0 个假阳性）**。
