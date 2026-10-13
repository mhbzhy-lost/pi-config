# 契约围栏下的独立测试与计划锚定

**状态：** 设计提案（2026-10-13）。尚未实施；实施路径见 §8。
**适用范围：** `pi-subagents-enhanced` runtime、`writing-plans` skill、以及围绕 dispatch/workspace/merge-queue 的外围建设。

## 目的

解决两个问题：

1. 要求 coding agent 在实现过程中遵循 TDD，产出大量与实现同义反复的无用测试，且无法阻止其通过改测试来"通过测试"（reward hacking）。
2. 测试完全外包给人或事后补写，又丢失了 agent 开发中最有价值的验证循环。

本设计把回归测试的**作者身份**从实现任务中剥离，交给信息隔离的 test 派发；把整套策略**锚定到实现计划的结构化字段**，由 harness 机械执行，任何环节脱离计划即拒绝运行（fail-closed）。

## 非目标

- 不改变 pi 本体（subagent 能力全部经 `pi-subagents-enhanced`）。
- 不追求测试覆盖率数字；覆盖率仅作盲区发现。
- 不为每个 diff 强制全流程；按风险分级（见 §8 阶段一）。
- 不消灭实现侧的临时自检测试；只是默认不使其进入回归套件。

## 背景：为什么"要求 agent 严格 TDD"失效

- TDD 实证研究的收敛结论：当对照组是**迭代式 test-last**（同样小步开发）时，test-first 的质量优势消失；真正起作用的是短而稳定的开发节奏（Fucci 等；Santos 等 2020 十二实验族）。Rafique & Mišić（IEEE TSE 2013）元分析：外部质量仅小幅正效应，工业场景生产率常下降。
- 对 agent 更关键的是**相关性错误**：同一会话、同一上下文里先写实现再写测试，测试会编码实现的同一个误解，全绿是虚假信号。CodeT（Chen 等，2022）的统计验证：实现与测试**独立采样**时，错误实现各自错得不同，同时骗过测试与兄弟实现的概率很低；同源生成则错误相关。
- METR 2025 评测记录了前沿模型在压力下直接修改测试/评分代码（含 `sys.exit(0)` 式假通过）。因此"禁改测试"必须机械强制，不能依赖 prompt。

## 核心不变量与原则

**不变量：验证必须与被验证物因果独立。**

由此推导四条设计原则：

1. **信息隔离 ≠ 算力隔离。** 围栏的本质是 testing 上下文看不到实现（信息），不是它自己能跑测试（算力）。"写"与"跑"可以分离：重工具链栈里测试由 executor 批量跑，红证明延后获得。
2. **状态驻留 artifact，不驻留 session。** testing 侧的全部记忆 = 契约 + 测试 + 测试注释/设计记录 + 工单。不在 artifact 里的状态等于不存在。修测试 = 一次新的围栏派发（无状态重放），不是会话接续。分离的是**信息策略**，不是实例身份。
3. **分离上下文 ≠ 分离阶段。** testing 先于实现（RED 在前），杜绝 vacuously passing tests；避免"实现完成后扔过墙"的传统 QA 失败模式。
4. **能力从计划机械推导。** 计划的结构化字段（Type/WritePaths/契约节）是派发授权的唯一来源；软性 prose 不承载任何授权。

## 架构总览

### 派发拓扑

```
计划阶段（主会话 + 人审）
  → 产出 contract/：spec.md（验收标准汇编，逐条编号）
                    stubs（真实路径、NotImplementedError 骨架）
  → 提交为契约基座 C（执行授权时刻，见 §7.4）

test 派发（tester profile，workspace 锚定 C）
  → 对 stub 写行为测试，确认 RED
  → 证据：红输出 + 用例↔spec 条款映射

impl 派发（executor profile，workspace 从 C 出发）
  → 把既有测试写绿；禁写 tests/、contract/
  → 证据：全绿 + WritePaths 内 diff

validation（只读执行 + 三分类分诊，不修改任何文件）
  ├─ 实现错  → 回 impl 派发（附带禁改测试约束）
  ├─ 测试错  → 新 test 派发（输入为去实现化工单）
  └─ spec 歧义 → 上浮人工

review + mutation probe
  → reviewer（计划执行后偏差检查）提出变异候选
  → probe 脚本机械 apply→run→revert，报告存活者
```

### 物理围栏：双分支 + 契约锚定 workspace

- `feat/x`（impl 侧）从契约基座 C 出生：天然拿到红测试作为验收标准。
- tester 的 workspace 锚定 C：实现物理上不存在，不是"嘱咐别读"。
- tester 可见的是"功能诞生之前的世界 + 契约"——它需要代码库背景（测试框架、既有约定），不需要新实现。
- sync 经 merge；冲突只可能出现在 tests/（tester 侧地盘）。

### 修复路由与工单 schema

- 工单（落 `executor_input.md`）**去实现化**：spec 条款引用 + got/expected + 分诊结论；**禁止**贴实现 diff 或代码。got/expected 仅用于复现；判定预期值的唯一权威是 spec——防止把"实现现状"合理化成"预期行为"。
- 有界重试：编译/运行失败回传 tester ≤ 2 轮，超限升级人工。
- 契约本身歧义时，tester 输出 `SPEC_QUESTION` 而不是猜。

### 证据 schema

- test 派发 terminal proof：红证据（对 stub/base 的失败输出）+ 用例↔条款映射。
- impl 派发 terminal proof：全绿 + diff ⊆ 声明 WritePaths。
- 经 `submit_acceptance_evidence` 入库，merge-queue 在同一契约 baseCommit 上登记校验。

## 重工具链适配（iOS 等客户端栈）

按"跑起来需要什么"分层，围栏逐层降级但信息隔离始终保留：

| 层 | 内容 | 围栏内能力 | 红证明 |
|---|---|---|---|
| 纯逻辑包（SPM，无 UIKit） | 计价/规则/解析/reducer | 写+编译+运行 | 对 stub 天然红 |
| 协议化 VM 层 | 依赖全 protocol | 写+编译 | executor 对 stub/base 跑一次 |
| UI 流程（XCUITest） | 关键旅程 | 只写（契约=交互契约：Accessibility ID/屏幕/动作） | 对 base 构建跑一次，期望红 |
| 视觉/动效 | 布局、动画手感 | 不写测试 | 截图 diff + 人审 |

工程前提：测试发现必须文件级（SPM 优先；app 工程用 XcodeGen/Tuist 声明式生成，测试按目录发现，pbxproj 手工注册 = 围栏在合并时破产）。UI 组件 stub 用三段式（骨架组件 → 测试得到有意义断言失败 → 填实现），避免 module-not-found 假红。

## 落地映射：pi-subagents-enhanced

现有能力对照——本设计**不新增机制，只新增策略**：

| 本设计需要 | 体系已有 |
|---|---|
| 物理围栏 | 统一 workspace service（分配/绑定/dispose、owner token、ledger；禁止 raw git worktree） |
| 写权拦截 | child entrypoint 注入机制（`acceptance-evidence.ts` 为范本）+ RunAuthorization 能力模型 |
| 集成硬闸 | merge-queue integrate blocker + conflict digest + baseCommit barrier |
| 状态驻留 | `.pi-subagents/artifacts/` executor_input/output + durable ledger |
| 无状态重放 | 每次派发即独立 child |
| 计划前审/执行后偏差检查 | reviewer profile 既有语义 |

策略层增量（五项）：

1. **契约锚定分配**：dispatch-ir 增加 `baseRef`（或等价字段）；tester 派发的 workspace 锚定契约基座。属公开合同 `./dispatch-ir` 的演进，需走兼容与验收流程。退化方案：派发前由可信 Host 在契约 commit 上预登记 barrier baseCommit。
2. **write-fence child extension**：照 `acceptance-evidence.ts` 模式实现（如 `write-fence.ts`），从该次派发的授权读写白名单，拦截 `write`/`edit`。白名单 = 任务声明 WritePaths 按角色过滤。
3. **WritePaths 集成闸**：coding 派发 integrate 时要求 diff ⊆ 声明 WritePaths。"零测试改动"不需要特例——impl 任务 WritePaths 天然不含 tests/。
4. **证据 schema 化**：按角色校验 terminal proof（红+映射 / 绿+diff 报告）；工单 schema 化到 `executor_input.md`。
5. **mutation probe**：`scripts/probes/mutation-audit.ts`，照 `repository-merge-queue-acceptance.ts` 先例。reviewer 提候选，probe 机械执行；含 revert-the-fix（bug 修复场景撤销修复必须红）。

Profile 层新增 `tester`（系统提示词承载围栏规则：spec 唯一权威、只动 tests/、红确认、SPEC_QUESTION、设计动机落盘）。profile 名称不授予任何能力——围栏完全由第 1–3 项承载，与既有哲学一致。

## 计划锚定

### 语义升级

计划文档已是 harness 消费的工件（Deps/WritePaths/接口契约/验收标准均为结构化字段，WritePaths 已用于并发隔离）。本设计将：

> **WritePaths 从"并发隔离提示"升级为"写权边界"；任务获得 Type 属性；测试作者身份变成任务类型而不是执行步骤。**

### writing-plans SKILL.md 修改（五处）

1. **概述**：撤掉执行器侧 TDD 默认 → "回归测试由 `test` 型任务（tester 角色派发、契约围栏内）产出，实现任务消费测试而非编写测试；探索性脚手架测试不入回归套件。"
2. **计划头部新增契约节**：BaseCommit（执行授权时填充）、contract 路径（spec.md + stubs/）、写权拓扑（tests/** 仅 test 型任务可写；contract/** 仅计划修订可写）、按角色的证据要求。
3. **任务模板加 `Type` 字段**：`contract | test | impl | integration | explore`。DAG 规则新增：每个 impl 任务必须依赖一个 test 任务，Consumes 指向其红测试套件；test 任务依赖 contract 任务，WritePaths 限定 tests/ 子集。依赖链：**contract → test → impl**。共享 fixture/mock/test helpers 归 test/contract 任务所有。
4. **impl 任务步骤改造**：删除"编写失败测试"作者步骤，改为"运行 T-k 契约测试确认 RED（测试只读）→ 最小实现 → GREEN → 回归"。
5. **计划自检加两条**：契约完整性（每条验收标准有条款号且有对应 test 任务）；写权归属（无 impl 任务声明 tests/ 或 contract/ 路径——与 harness 校验互为镜像）。

### harness 硬保证（fail-closed 链）

```
人批准计划（既有授权门禁时刻）
  → 计划结构化字段（Type/WritePaths/契约节）成为该 feature 的能力授予源
  → dispatch-ir 校验：coding 派发必须携带 plan_ref + task_id + role   ← 无则拒绝
  → workspace 分配：baseRef = 契约节 BaseCommit                        ← 物理围栏
  → write-fence：白名单 = 任务 WritePaths 按角色过滤                   ← 工具级拦截
  → integrate blocker：diff ⊆ 声明 WritePaths                          ← bash 逃生口终局兜底
  → submit_acceptance_evidence：按角色校验 schema                      ← 红/绿证明入库
```

- **bash 逃生口**：write/edit 拦不住 `echo >`；终局兜底是集成闸的 diff 校验。write-fence 提高事故成本，blocker 保证下限。
- **契约完整性**：首次派发把 contract/ 内容哈希随 leaseId 入 ledger；实现侧触碰契约要么过不了 blocker，要么哈希不符。计划修订 = 新版本 + 作废在途 lease（复用处置状态机）。
- **授权链闭环**：人只批一次计划；此后每道闸从其字段机械推导。接既有哲学："RunAuthorization 是唯一授权来源，不能以 generic 自由文本绕过"。

### 不变量处理：no-default-commit

SKILL.md 规定计划编写不得默认 commit。契约基座需要一次 commit——放在**执行授权时刻**（用户选择执行方式后的第一个 harness 动作）。计划编写仍零 commit；授权语义更完整：人批准的不只是计划文本，还有由它派生的整个围栏拓扑。

## 实施路径

**阶段一（最小闭环，单个 feature 验证）**
契约节 + Type 字段 + dispatch 的 plan_ref 校验 + WritePaths 集成闸。write-fence 可后置（blocker 已兜底）。

验证信号：
- 硬保证：impl 派发 diff 是否严格落在 WritePaths 内。
- 有效性：test 任务用例↔条款映射在 triage 时是否降低"test 错/spec 歧义"误判成本；同义反复测试产出率是否下降。

**阶段二**
write-fence child extension + 证据 schema + 工单 schema 化 + reviewer 执行后清单扩展（变异候选 + 盖住实现读测试的同义反复检查）。

**阶段三**
mutation probe 脚本 + 契约哈希 ledger + 计划修订/lease 作废流程 + 重工具链分层适配（如项目涉及）。

风险分级（避免全面铺开的成本）：bug 修复与核心域逻辑走全流程；普通功能 RED→GREEN + 抽查变异；琐碎改动跳过（类型检查 + CI 兜底）。

## 风险与开放问题

1. **dispatch-ir 合同演进**（`baseRef`）：唯一触碰公开 API 的改动，需兼容层与完整验收。退化方案见 §6。
2. **tester 平庸测试**：独立性消除相关性错误，但不保证测试有牙齿——靠变异 probe 审计，不靠信任。
3. **工单去实现化的执行纪律**：validation 分诊输出由 LLM 生成，schema 校验（禁实现代码模式）+ 抽查。
4. **流程成本**：全链路 token 开销显著（参照同类实践的自述）。风险分级是必要缓解，不是优化项。
5. **探索性/原型工作**：不适合本流程。判定信号：接口签名写不出（计划不具体）→ 先 explore 任务，产出决策后再立契约。

## 参考

- Rafique & Mišić, *The Effects of TDD on External Quality and Productivity: A Meta-Analysis*, IEEE TSE 2013.
- Fucci et al., *What Do We (Really) Know about TDD?*, IEEE Software.
- Santos et al., *A Family of Experiments on TDD*, EMSE 2020.
- Chen et al., *CodeT: Code Generation with Generated Tests*, ICLR 2023（独立采样 + 双重执行一致）.
- METR, *Recent Frontier Models Are Reward Hacking*（测试修改行为的实测记录）.
- Correctless（agent 分离 + 阶段门禁的工程实践）、agentpatterns "Red-Green-Refactor Agents"（context pollution 概念）.
