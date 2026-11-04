# 托管工作区生命周期恢复路径设计评估

日期：2026-11-04。性质：架构级设计评估，不实施修复。触发背景：Goal Engine 已由用户 disable；同日连续修复 12 项缺陷后，用户提出立项时的担忧已成真——「修完一个遇到另一个」。本评估回答：问题出在设计的哪个层面、什么机制能终结打地鼠模式。

## 一、立项担忧的实质

立项时担心的「解决不完的 bug」，今天可以精确表述为：**fail-closed 语义按组件独立设计，组合可达性无人负责**。每个状态机各自正确地「不确定就拒绝」，但没有任何一层对「任意状态组合下，存在一条到达终态的路径」负责。恢复靠的不是产品化机制，而是恰好懂内部结构的人找到恰好存在的逃生 API。agent 拿到的多数拒绝码只说「为什么不行」，不说「下一步去哪」。

## 二、评估方法

对生命周期全链路（派发 → 队列集成 → 终止证明 → 处置结算 → resume/Goal 恢复）枚举全部已知拒绝语义与失败落点，逐项回答：**存在恢复 owner 吗？**恢复 owner 必须是三者之一：自动泵、工具化收敛操作、文档化运维路径。仅有「人工诊断 + 专家账本手术」不计为出口。证据来源为当日实证（主仓与 yugang 会话两起事故链）与源码核实。

## 三、拒绝语义 × 恢复 owner 矩阵（核心产出）

| # | 拒绝/失败落点 | 恢复 owner | 状态 |
| --- | --- | --- | --- |
| 1 | action token 过期/重放（`MANAGED_WORKSPACE_ACTION`） | 重新 status 签发 | ✅ 良好 |
| 2 | 状态机非法调用（`MANAGED_WORKSPACE_STATE`） | 错误消息含 allowed actions + next 指引 | ✅ **模范**：全系统唯一给 next 的拒绝码 |
| 3 | origin dirty 阻塞 integrate | `integrate_blocked_reasons` 明示原因，修 origin 后重试 | ✅ 良好 |
| 4 | writePaths 越界（派发合同声明不全） | `additionalWritePaths` 显式补授权，授权留痕 | ✅ 当日修复（8e6d616/d37f08d） |
| 5 | 新旧 schema 进程混踩 ledger | null 字段序列化收窄 | ✅ 当日修复（1077217） |
| 6 | released workspace 遗留 queued 孤儿项阻塞 FIFO | coordinator 启动对账转 preserved | ✅ 当日修复（810883c） |
| 7 | proof 分类失败 → outbox debt | **无**：replay 只重投 pending，debt 无任何泵 | ❌ 实证死锁（yugang） |
| 8 | 后到真实证明 vs 已 settle 项 `proofHash:null` | **无**：`deliverTerminalProof` 拒绝「结算时未观察、后到的真证明」，与伪造不区分 | ❌ 实证死锁 |
| 9 | coordinator 侧 release 无 terminalProofProvider | **无**：Host 侧 status 说 release 可用（provider 解析异步事实），coordinator 侧 release 拒绝（无 provider）——同一事实两个权威视角 | ❌ 结构性不对称 |
| 10 | resume intent 被 preserve 结算关闭 → `managedCodingResume` 要求恰好一条活跃 intent | **无**：单向门，无重开语义 | ❌ 实证死锁 |
| 11 | `RETRY_NOT_ADMITTED`（失败事实链断裂） | **无**：不存在「补权威事实」的路径；错误消息不给 next | ❌ 实证死锁 |
| 12 | 替换门 `GOAL_CANCELLED_REPLACEMENT_REQUIRED` | 依赖 force-close；force-close 依赖每个任务闭合 → **汇聚底层全部死锁**；终极出口是用户人工 `/plan force-close` | △ 有出口但出口本身依赖断链 |
| 13 | 死 daemon 的 admitted claim（`recoverClaims`） | **写了没接线**：函数已导出，全仓零调用方 | ❌ 孤儿恢复函数 |
| 14 | `reconcileIntegrations`（队列全量对账推进） | **写了没接线**：函数已导出，全仓零调用方（当日另建窄版 810883c） | ❌ 孤儿恢复函数 |
| 15 | resume attempts 耗尽/no-progress | recovery intent `requiredAction:"preserve"` → 交回主 agent → 依赖 #9 证明链 | △ 半出口：绕回同一条断链 |
| 16 | `SUPERVISOR_STEER_NOT_ALLOWED`（yugang 实证，运行中 run 被拒） | **无**：门禁三条件（非 running/非 steerable/epoch 不匹配）坍缩为一个错误码，不带 reason/hint；归因诊断只写内部 trace 不进工具回执；0.80 下 epoch 检查为死代码，实际触发是 status 二次读取的瞬时误判（2026-11-01 事故同类），双源救助不覆盖未注册 broker 的 generic run | ❌ 实证（INV-EXIT 违规；修复=拒绝时携带触发条件与 runtime 事实 + 重试指引，归 Phase B） |

统计：当日暴露无出口语义 **8 处**（#7–#14），已产品化出口 5 处（#1–#6），模范出口仅 1 处（#2）。

## 四、四个结构性缺陷模式

**P1 恢复机制「写了不接线」。** `reconcileIntegrations` 与 `recoverClaims` 都是完整的恢复实现，导出后零调用方。这说明写代码时意识到了需要恢复，但验收只覆盖了拒绝路径，「恢复路径可达」没有进入验收标准。这是打地鼠模式的直接成因之一：恢复代码存在 ≠ 恢复发生。

**P2 组合可达性无人负责。** #7–#11 每个单看都是「合理的设计决策」（debt 防盲重试、proofHash 匹配防伪造、结算关闭 intent 防复活、retry 准入防盲重派）。yugang 死锁是六种「各自正确」在一条链上互相锁门。没有一层验收回答「注入故障后，生命周期是否仍能到终态」。

**P3 同一事实多权威视角。** 证明解析 Host 侧有 provider（异步事实）、coordinator 侧没有（仅 durable record）——导致 #9 的 status/release 说话不一致。数据事实应只有一个权威解析入口，或者两个视角必须收敛到同一持久事实。

**P4 单向结算门。** preserve 结算顺手关闭 resume intent、cancel 结算关闭 queue 项——都是「防复活」的正确直觉，但没有配套的重开或补偿语义。「关闭」类操作的验收同样缺少「关闭后仍可达终态」检查。

## 五、建议的设计不变量

1. **INV-EXIT**：每个新拒绝码/失败落点，必须与恢复 owner 同一变更落地（自动泵 / 工具化收敛 / 文档化运维三选一），拒绝消息含 `next:` 指引——以 `MANAGED_WORKSPACE_STATE` 为格式范本。
2. **INV-WIRING**：恢复机制禁止孤儿化——导出的恢复函数必须同 PR 接线，或干脆不写。
3. **INV-REACH**：任何 durable 状态转移的验收必须包含「从每个失败出口仍能到达终态」的可达性检查（故障注入）。
4. **INV-OWNER-UNIQ**：同一事实只有一个权威解析入口；多视角必须先收敛到同一持久事实再服务。

## 六、改造路线（建议顺序）

- **Phase A 统一收敛通道**：把已验证的专家操作产品化为一个 `recovery`/`reconcile` 运维入口（`service.reconcile` 已有雏形），收编：debt 重投、孤儿对账、后到证明补记、死 claim 回收（接线 `recoverClaims`）。当日全部人工解堵操作都是该通道的规格说明书。
- **Phase B 错误消息合同**：全部拒绝码补 `next:` 字段（#11 是最坏范例）。
- **Phase C 证明权威统一**：coordinator 侧接异步事实持久化（或 Host 送达前落盘），消除 #9 不对称，#7/#8/#10/#15 随之收敛。
- **Phase D 可达性验收**：故障注入矩阵——逐组件挂掉，断言生命周期仍可达终态。这是终结「修一个冒一个」的验收机制：以后每个新拒绝语义都过这道门。

**与 1.5 升级的关系**：两者正交。1.5 是版本迁移（进行中，T0–T6 已绿）；本评估是增强层设计债。Phase A 应在 1.5 合回之后实施，避免候选/主仓分叉扩大。Goal Engine 当前 disabled 是正确时机：Goal 层的 #11/#12 修复依赖底层 #7–#10 先收敛，disable 期间完成 Phase A–C，重新启用前过 Phase D 验收。

## 七、当日事故对矩阵的印证

主仓链（集成阻塞）：#6 → 手工 preserveByBinding 解堵 → #4 → 手动 cherry-pick + discard。yugang 链（Goal 死锁）：schema 互踩（#5 已修）→ proof 落 debt（#7）→ preserve 结算关 intent（#10）→ retry 拒（#11）→ resume 拒（#10）→ force-close 拒（#12 汇聚）→ 替换门拦重建。两条链共用同一结构：**正常路径闭环，异常恢复无闭环**。

本评估不修改任何代码；矩阵中 ❌ 项为后续立项（Phase A–D）的精确范围。
