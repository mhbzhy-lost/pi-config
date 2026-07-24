# Pi 长目标执行社区方案采纳评估

> 文档性质：调研结论与候选能力清单，不是实施计划。
>
> 调研对象：Claude Code `/goal`、Pi 社区 goal/loop/planner/pipeline/capsule 项目，以及 Taskflow、Babysitter、pi-gauntlet、agent-execution-harness 等相邻方案。
>
> 结论标记：`[已核实]` 表示已通过官方资料、源码、发布记录或本地实现确认；`[合理判断]` 表示有证据支撑但仍需在引入前复核边界；`[待验证]` 表示只适合作为后续调研方向。

## 1. 调研目标

当前 Plan Runner 已经具备一组相对独特的能力：

- 批准计划 hash；
- 独立 Plan Session；
- 独立 Git worktree capsule；
- Parent lease 与顶层运行生命周期；
- append-only event log；
- Task DAG 与 attempt binding；
- 多层完成门禁；
- 与具体提交绑定的 `validatedHead`。

本次调研不是寻找一个项目整体替换 Plan Runner，而是回答：

1. 社区项目分别解决了什么问题；
2. 哪些能力值得吸收到现有架构；
3. 应复用源码、协议、测试，还是只借鉴产品交互；
4. 哪些能力会和现有状态机形成重复事实来源；
5. 如何形成一个能长期执行、抵抗偏航、可恢复且不能自证完成的系统。

## 2. 总体结论

没有发现一个项目完整覆盖现有 Plan Runner 的组合能力。推荐采用“保留现有执行内核，按层吸收成熟能力”的策略：

```text
Goal Contract
    ↓ 目标批准
Taskflow Definition
    ↓ 确定性编译
Frozen FlowIR
    ↓ capsule 执行
Plan Runner Event Log
    ↓ attempt artifacts / evidence
Deterministic + Plan Audit + External Review
    ↓ 独立完成判定
Validated Head
```

各项目最值得吸收的能力如下：

| 项目 | 主要采纳点 | 推荐复用方式 | 优先级 |
|---|---|---|---|
| Taskflow | FlowIR、canonical hash、fingerprint、stale frontier | vendor `taskflow-core` 源码与原测试 | P0 |
| `@capyup/pi-goal` | Goal drafting、目标落盘、独立 auditor | 深入复核后局部移植协议或模块 | P0 |
| Claude Code `/goal` | 独立 evaluator、条件续轮、恢复与完成清理 | 对齐产品语义，不存在可直接 vendor 的本地内核 | P0 |
| `@narumitw/pi-goal` | 稳定续轮和生命周期安全 | 提取 loop controller，不采用其完成语义 | P1 |
| `lnilluv/pi-ralph-loop` | 长循环预算、停止、恢复和运行控制 | 借鉴协议与失败语义 | P1 |
| `pi-gauntlet` | 对抗式审查和修复后重审 | 接入 external-review / task-review 门禁 | P1 |
| Babysitter | durable checkpoint、阶段状态、人工审批点 | 借鉴 checkpoint 与 resume manifest | P1 |
| `agent-execution-harness` | attempt artifact manifest、执行证据组织 | 借鉴 artifact schema 和证据边界 | P1 |
| `smileynet/capsule` | 隔离执行环境的产品边界 | 用作 capsule 完整性检查表 | P2 |
| `pi-code-planner` | Planner、Executor、Reviewer 角色隔离 | 借鉴角色边界和计划审阅流程 | P2 |
| `pi-tasks` | 持久任务状态与人类可见性 | 只借鉴状态视图，不引入第二套存储 | P2 |
| `pi-pipelines` | 声明式阶段组合 | 只借鉴组合界面，不替换状态机 | P3 |

## 3. 采纳原则

### 3.1 不整体替换现有 Plan Runner

现有 worktree、Parent lease、event sourcing、attempt binding 和 `validatedHead` 是项目已投入大量测试形成的核心资产。社区项目可以补充目标定义、循环控制和完成审计，但不应建立第二套运行控制平面。

### 3.2 复用成熟实现，而不是只复述设计思想

满足以下条件时优先局部 vendor：

- 模块边界独立；
- 许可证允许；
- 上游 commit/tag 可固定；
- 原始测试可以一同保留；
- 失败语义明确；
- 本地 wrapper 可以 fail-closed；
- 不要求修改 vendored core。

如果项目没有稳定模块边界，则复用单位退化为：协议、状态转换、不变量、测试向量和失败分类。

### 3.3 每层只保留一个事实来源

| 信息 | 唯一事实来源 |
|---|---|
| 目标、Scope、Non-Goals、DoD | Goal Contract |
| 静态执行图 | Frozen FlowIR |
| 生命周期、Task、attempt、Gate 状态 | Plan Session event log |
| worker 运行结果 | subagent runtime artifacts |
| 提交身份 | Git commit / `validatedHead` |
| 完成证据 | Evidence ledger + gate results |
| 人审展示 | 从上述事实来源生成的只读视图 |

不得同时维护 Markdown DAG、FlowIR DAG 和另一套 Task store。

## 4. Taskflow：FlowIR 内核

### 4.1 值得吸收的能力

`[已核实]` Taskflow 的核心价值不是通用 workflow UI，而是 `taskflow-core` 提供的稳定 FlowIR 内核：

- 规范化编译；
- canonical hash；
- condition 规范化；
- phase fingerprint；
- declared/observed dependency 处理；
- stale frontier；
- replay/recompute 所需的失效传播语义；
- malformed flow 的结构化 diagnostics；
- 面对 shared context、subflow、`join:any` 等情况的安全降级。

推荐固定：

```text
Repository: https://github.com/heggria/taskflow
Package: packages/taskflow-core
Tag: v0.2.4
Commit: 3b805248a59b27ec8c7a143e93e316794af2d5a7
License: MIT
```

### 4.2 推荐复用方式

完整 vendor `packages/taskflow-core` 及对应测试，不只复制 `canonical-hash.ts`。本地只维护：

- Pi Plan / Taskflow Definition adapter；
- Plan Runner fail-closed policy wrapper；
- capsule identity 绑定；
- adapter contract tests。

### 4.3 不吸收的部分

不让 Taskflow runtime 接管：

- Parent lease；
- worktree 创建与保留；
- subagent dispatch；
- Plan Session event log；
- Gate 生命周期；
- `validatedHead`。

FlowIR 是静态执行输入，不是动态状态存储。

## 5. `@capyup/pi-goal`：目标起草与独立审计

### 5.1 值得吸收的能力

`[已核实]` 相比只负责自动续轮的 goal 插件，该项目更强调：

- 执行前整理目标；
- 目标 artifact 落盘；
- 目标在会话之外可恢复；
- 使用独立 auditor 判断目标是否满足。

这正好填补 FlowIR 上下游的两个空白：

```text
模糊用户目标 → Goal Contract → FlowIR
FlowIR 执行结果 → Goal Auditor → Completion Verdict
```

### 5.2 推荐复核内容

在决定是否局部 vendor 前，需要进一步核对：

- Goal artifact schema；
- drafting prompt；
- auditor prompt；
- auditor 输出是否结构化；
- auditor 是否能引用具体证据；
- auditor 与 executor 是否真正隔离；
- 缺失证据时是否 fail-closed；
- 测试是否覆盖错误完成声明和目标偏航。

### 5.3 推荐边界

吸收 Goal Contract 和 auditor，不采用其完整 runtime。现有 Plan Runner 继续负责执行和状态；Goal Contract 负责目标真相；auditor 负责最终语义覆盖判断。

## 6. Claude Code `/goal`：产品语义基准

### 6.1 值得吸收的能力

`[已核实]` 官方 `/goal` 的关键点包括：

- goal 是 session-scoped condition；
- agent 每轮工作后由独立 evaluator 判断；
- 条件未满足时自动继续；
- 支持恢复；
- 条件满足后清理 goal 生命周期。

最重要的不是“自动多跑几轮”，而是执行者和判断者分离。

### 6.2 推荐吸收方式

将其作为 Plan Runner 的产品语义基准：

- executor 不能自行产生最终完成判定；
- evaluator 只能读取 Goal Contract、FlowIR 和证据；
- evaluator 不得修改目标或执行图；
- evaluator 未通过时必须给出结构化缺口；
- 缺口必须重新进入 Task、repair 或 amendment 流程；
- 最终完成仍需绑定当前 HEAD。

Claude `/goal` 是行为参考，不是可直接 vendor 的本地实现。

## 7. `@narumitw/pi-goal`：循环生命周期内核

### 7.1 值得吸收的能力

`[已核实]` 该项目主要解决：

- evaluator 未通过后的稳定续轮；
- session 生命周期注册和清理；
- 防止重复 loop；
- 停止、取消和异常退出处理；
- 避免循环逻辑散落在 prompt 中。

### 7.2 明确不足

它没有提供完整的：

- Scope 和 Non-Goals；
- Definition of Done；
- requirement-to-evidence 映射；
- 独立确定性 verifier；
- 与不可变提交绑定的完成结论。

因此只能作为 loop controller 候选，不能作为 Goal Contract 或 Completion Gate。

### 7.3 推荐接入点

```text
Plan Session authorize
    → worker execute
    → collect runtime result
    → evaluate progress
    → continue / block / verify
```

任何 loop 状态都不能绕过 Plan Runner 的 Gate 和 `validatedHead`。

## 8. `lnilluv/pi-ralph-loop`：长循环运行控制

### 8.1 值得吸收的能力

`[已核实]` 上游已发布 `v2.0.0`；作者在 2026-07-10 至 2026-07-12 集中完成并发布该版本。官方 npm `latest` 为 `2.0.0`，当前内部镜像仍可能停留在 `1.8.0`。

建议重点吸收其长期循环的操作层经验：

- 最大迭代次数；
- 最大运行时长；
- 停止与取消；
- 连续失败退出；
- 无进展退出；
- 状态展示；
- 恢复入口。

### 8.2 建议形成统一 Loop Budget

```json
{
  "maxIterations": 20,
  "maxDurationMs": 7200000,
  "maxConsecutiveFailures": 3,
  "maxNoProgressIterations": 2
}
```

“无进展”不能由模型自由解释，至少应观察以下确定性信号之一：

- HEAD 变化；
- accepted Task 增加；
- blocker 被移除；
- 新 evidence 被接受；
- Gate finding 数量下降。

### 8.3 引入限制

内部 registry 同步滞后时，不应把内部镜像版本直接作为核心依赖。优先复核 `v2.0.0` 源码和测试，再决定复制小模块还是只吸收协议。

## 9. `pi-gauntlet`：对抗式审查

### 9.1 值得吸收的能力

`[合理判断]` 其价值在于把 review 视为主动寻找失败条件，而不是一次性确认：

```text
Implementation
    → deterministic verification
    → adversarial review
    → structured findings
    → repair
    → stale gates rerun
```

建议吸收：

- reviewer 与 executor 隔离；
- reviewer 主动寻找反例、遗漏和回归；
- findings 采用结构化 severity；
- Critical/Important 阻断；
- 修复改变 HEAD 后旧 review 自动 stale；
- reviewer 不直接修改代码。

### 9.2 与 plan-audit 的边界

| Gate | 回答的问题 |
|---|---|
| deterministic | 命令和测试是否通过 |
| task-review | 单个 Task 的实现是否可接受 |
| external-review / gauntlet | 代码是否存在 bug、风险或回归 |
| plan-audit | FlowIR 和 Goal Contract 是否被完整覆盖 |
| final-completeness | 所有证据是否绑定当前 HEAD 且工作区干净 |

不能用 external review 替代 plan-audit。

### 9.3 待验证内容

需要进一步检查其 reviewer contract、finding schema、重试策略和测试覆盖，再判断是否存在可局部复制的模块。

## 10. Babysitter：持久检查点与人工审批

### 10.1 值得吸收的能力

`[合理判断]` 可借鉴的是长期 workflow 的 durable checkpoint：

```json
{
  "phase": "implementing",
  "currentNode": "task-3",
  "lastCompletedCheckpoint": "task-2-reviewed",
  "waitingFor": null,
  "nextAction": "dispatch-task-3"
}
```

以及显式人工审批点：

- Goal Contract approval；
- FlowIR approval；
- Scope amendment；
- 不可逆操作；
- 外部权限或环境选择；
- completion override。

### 10.2 推荐边界

现有 event log 已经是运行状态的唯一事实来源，因此 checkpoint/resume manifest 必须是 event log 的可再生投影。不得新增一份可以独立修改的 workflow state。

### 10.3 待验证内容

需要继续核对 Babysitter 的 checkpoint schema、恢复失败语义、人工审批绑定和状态迁移测试。当前只建议吸收设计模式。

## 11. `agent-execution-harness`：执行证据清单

### 11.1 值得吸收的能力

`[合理判断]` 每次 attempt 应产生稳定、可校验的 artifact manifest，而不只保存自然语言结果：

```json
{
  "attemptId": "attempt-plan-task-1-1",
  "flowIrHash": "ir:...",
  "nodeId": "task-1",
  "nodeFingerprint": "phase:...",
  "inputHead": "...",
  "outputHead": "...",
  "commands": [],
  "artifacts": [],
  "logs": [],
  "exitStatus": "succeeded",
  "evidenceHash": "..."
}
```

它可以加强：

- crash recovery；
- task review；
- plan audit；
- evidence replay；
- stale 判断；
- “worker 声称成功但没有证据”的 fail-closed 行为。

### 11.2 推荐边界

artifact manifest 补充现有 `attempt.bound`、`attempt.settled` 和 subagent runtime artifacts，但不复制原始日志，也不成为新的生命周期状态源。

### 11.3 待验证内容

需要复核上游实际 manifest、artifact ownership、hash 方式、失败状态以及恢复测试，避免仅根据项目定位自行设计新 schema。

## 12. `smileynet/capsule`：执行隔离检查表

### 12.1 值得吸收的能力

`[合理判断]` 现有 Plan Runner 已经具备 capsule，但可以用该项目检查以下边界是否完整：

- capsule identity 是否绑定全部执行条件；
- 输入 artifact 是否不可变；
- base 环境是否可重建；
- 输出、日志和证据是否集中保存；
- 失败后是否保留现场；
- cleanup 是否显式且可审计；
- capsule 是否可能污染 origin workspace。

### 12.2 推荐 capsule identity

```text
flowIrHash
+ goalContractHash
+ baseHead
+ runnerVersion
+ gatePolicyVersion
+ executionProfile
```

### 12.3 推荐边界

不替换现有 Git worktree capsule。只吸收边界检查和 artifact ownership 经验。

## 13. `pi-code-planner`：角色隔离

### 13.1 值得吸收的能力

`[合理判断]` 重点是 Planner、Executor、Reviewer、Auditor 之间的职责分离：

| 角色 | 允许做什么 | 不允许做什么 |
|---|---|---|
| Planner | 将 Goal Contract 转成 Taskflow Definition | 宣布实现完成 |
| Compiler | 确定性生成 Frozen FlowIR | 推断业务目标 |
| Executor | 执行一个已批准 IR node | 修改 Goal Contract 或 FlowIR |
| Reviewer | 审查单 Task 或代码变更 | 直接修复代码 |
| Auditor | 判断目标与计划覆盖 | 改写目标以让审计通过 |
| Plan Runner | 调度、持久化状态、运行 Gate | 自行放宽批准合同 |

### 13.2 当前最直接的改进点

当前 executor prompt 不能只携带 Task 标题和 Files。未来应从 FlowIR node 提供完整任务语义、约束和节点级验收条件。

### 13.3 推荐边界

借鉴角色和审阅流程，不引入另一套 planner runtime 或计划存储。

## 14. `pi-tasks`：Task 可见性

### 14.1 值得吸收的能力

`[合理判断]` 可借鉴面向用户的 Task 状态视图：

- pending；
- runnable；
- dispatch-requested；
- active；
- awaiting-review；
- accepted；
- blocked；
- stale。

状态页面还应展示：

- 当前 FlowIR hash；
- 当前 HEAD；
- 最近 attempt；
- blocker；
- 缺失 evidence；
- 下一可执行节点；
- Gate stale 原因。

### 14.2 推荐边界

只吸收 UX，不引入第二套 Task 数据库。全部状态从 Plan Session event projection 生成。

## 15. `pi-pipelines`：声明式组合界面

### 15.1 值得吸收的能力

`[待验证]` 可借鉴面向用户表达执行阶段的方式：

```text
compile
→ execute DAG
→ deterministic
→ plan audit
→ external review
→ final completeness
```

### 15.2 不建议吸收的部分

不采用其 pipeline runtime 作为第二控制平面，否则会和以下机制重复：

- Plan Runner event reducer；
- Task DAG；
- Gate state；
- stale propagation；
- recovery；
- Parent lease。

该项目优先级最低，除非未来需要开放用户可配置的 pipeline profile。

## 16. 推荐的综合架构

```text
┌──────────────────────────────────────────────┐
│ Goal Definition                             │
│ Capyup-style drafting + durable contract    │
└──────────────────────┬───────────────────────┘
                       │ approve
┌──────────────────────▼───────────────────────┐
│ Static Execution Contract                   │
│ Taskflow Definition → Frozen FlowIR         │
└──────────────────────┬───────────────────────┘
                       │ bind hash + base HEAD
┌──────────────────────▼───────────────────────┐
│ Existing Plan Runner Capsule                │
│ worktree + Parent lease + event log         │
└──────────────────────┬───────────────────────┘
                       │ dispatch under budget
┌──────────────────────▼───────────────────────┐
│ Loop and Attempts                           │
│ Narumi/Ralph controls + runtime artifacts   │
└──────────────────────┬───────────────────────┘
                       │ collect evidence
┌──────────────────────▼───────────────────────┐
│ Verification                                │
│ deterministic + task review + gauntlet      │
│ + plan audit + final completeness           │
└──────────────────────┬───────────────────────┘
                       │ independent verdict
┌──────────────────────▼───────────────────────┐
│ Completion                                 │
│ Goal auditor + validatedHead                │
└──────────────────────────────────────────────┘
```

## 17. 分阶段采纳顺序

### P0：先建立静态合同与完成语义

1. vendor Taskflow `taskflow-core` 和原始测试；
2. 定义 Goal Contract 与 FlowIR 的职责边界；
3. 深入复核 `@capyup/pi-goal` 的 drafting/auditor；
4. 让 plan-audit 真正接收 Goal Contract、FlowIR 和 evidence；
5. 明确独立 completion evaluator 的结构化输入输出。

### P1：补齐长期执行稳定性

1. 复核 `@narumitw/pi-goal` loop controller；
2. 复核 `pi-ralph-loop v2` 的预算、取消和恢复；
3. 引入 attempt artifact manifest；
4. 引入对抗式 external review；
5. 增加 checkpoint、amendment 和人工审批状态。

### P2：改善 capsule 完整性和使用体验

1. 检查 capsule identity；
2. 增强 Task/status/open/recover 视图；
3. 强化 Planner、Executor、Reviewer、Auditor 权限边界。

### P3：按需求评估声明式 pipeline

只有在确实需要多种可配置执行 profile 时，再继续评估 `pi-pipelines`。在此之前，固定的 Plan Runner gate policy 更容易审计。

## 18. 明确不采纳的方向

- 不引入任一项目的完整 orchestrator 替换 Plan Runner；
- 不把自动续轮当作完成证明；
- 不允许 executor 自己宣布最终完成；
- 不允许 evaluator 修改 Goal Contract 或 FlowIR；
- 不同时维护 Markdown DAG、FlowIR DAG 和 Task store；
- 不让 Taskflow runtime 管理 Parent lease 或 Gate；
- 不把自然语言 reviewer 输出直接当作结构化通过；
- 不使用“测试通过”证明所有 evidence lane；
- 不在内部 registry 版本滞后时直接依赖未复核版本；
- 不在没有上游测试和失败语义的情况下仅凭 API 外观局部复制。

## 19. 后续源码复核清单

### 19.1 `@capyup/pi-goal`

- [ ] 固定 repository、tag、commit 和 license；
- [ ] 定位 Goal artifact schema；
- [ ] 定位 drafting prompt 和 auditor prompt；
- [ ] 确认 auditor 输出是否结构化；
- [ ] 检查缺失证据、目标冲突和 evaluator 失败语义；
- [ ] 盘点可直接保留的测试；
- [ ] 判断可 vendor 模块边界。

### 19.2 `@narumitw/pi-goal`

- [ ] 定位 loop controller；
- [ ] 核对重复注册、session shutdown 和 cancel 行为；
- [ ] 核对 evaluator error 与 unmet 的区别；
- [ ] 盘点生命周期测试；
- [ ] 判断是否值得复制小模块。

### 19.3 `lnilluv/pi-ralph-loop v2`

- [ ] 固定 `v2.0.0` commit；
- [ ] 核对 iteration/time/failure budget；
- [ ] 核对 no-progress 判断；
- [ ] 核对恢复和取消；
- [ ] 检查内部 npm 镜像同步后再评估依赖方式。

### 19.4 `pi-gauntlet`

- [ ] 定位 reviewer contract；
- [ ] 核对 finding schema 和 severity；
- [ ] 核对 repair 后重审；
- [ ] 核对 reviewer 是否能意外修改 workspace；
- [ ] 盘点 adversarial review 测试向量。

### 19.5 Babysitter

- [ ] 定位 checkpoint 和 resume schema；
- [ ] 核对人工审批绑定；
- [ ] 核对 crash recovery；
- [ ] 核对 uncertain 状态是否 fail-closed；
- [ ] 判断哪些状态可由现有 event log 投影。

### 19.6 `agent-execution-harness`

- [ ] 定位 execution manifest schema；
- [ ] 核对 artifact ownership；
- [ ] 核对 hash 和 provenance；
- [ ] 核对失败、超时、中断和部分产物语义；
- [ ] 盘点恢复与证据测试。

## 20. 当前决策摘要

- **[整体策略]**：是否寻找一个社区项目整体替换 Plan Runner
- **推荐**：不替换，保留现有执行内核并按层吸收，因为没有单一项目覆盖现有 capsule、lease、event、Gate 和 `validatedHead`
- **不选原因**：整体替换会丢失已经验证的生命周期和恢复语义
- **选错代价**：执行、恢复和完成判定发生系统性回归时暴露，修复代价高

- **[首批深入项目]**：下一批源码复核投入在哪里
- **推荐**：优先 `@capyup/pi-goal` 和 `pi-gauntlet`，因为它们分别补齐目标定义/完成审计和对抗式验证
- **不选原因**：继续研究更多 orchestrator 的边际价值较低
- **选错代价**：完成语义仍依赖弱审计时暴露，修复代价中到高

- **[复用策略]**：其他项目是否也像 Taskflow 一样直接 vendor
- **推荐**：先验证模块边界、许可证和原测试，再决定；没有稳定边界时只吸收协议、不变量和失败语义
- **不选原因**：无测试的片段复制无法继承上游踩坑积累
- **选错代价**：升级和异常路径出现行为漂移时暴露，修复代价中

## 21. 当前认知边界

本文可以说明哪些项目值得继续投入、各自应该补哪一层，以及哪些边界不应越过；但当前尚不能证明：

- `@capyup/pi-goal` auditor 可以直接局部 vendor；
- `pi-gauntlet` 已有适配当前 Gate schema 的稳定模块；
- Babysitter 和 `agent-execution-harness` 的 schema 可以原样复用；
- `pi-ralph-loop v2` 在当前 Pi runtime 和内部 registry 环境中可直接运行；
- 综合架构的所有状态转换已经形成完整形式化模型。

在做任何代码引入前，应按第 19 节固定上游版本、读取源码、保留原测试，并分别写出“复用边界与失败语义”结论。