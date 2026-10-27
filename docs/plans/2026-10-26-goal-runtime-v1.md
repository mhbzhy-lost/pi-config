# Goal Runtime v1 实现计划

> **给执行 agent：** 按本文 DAG、Deps、WritePaths 和 Resources 执行；步骤使用复选框记录。只有 F1–F9 全部具备当前版本的通过证据，才能标记本计划执行完成。未达到终态时，在已授权范围内持续 `fix → test（验证）→ 对照终态`。本文编写完成不代表获准执行；执行方式由用户选择。

**目标：** 用户选择执行一份计划后，自动将该计划绑定为活跃目标，由轻量 harness 持续推进、跨 compact 恢复，并以真实验证结果决定完成；无需额外输入 `/goal`。

**架构：** 以计划文件内的结构化契约为需求权威，以 Pi 当前 session 分支的持久化记录为执行进度权威。根 feature 只管理计划、任务和验证状态；通过 `pi-subagents-enhanced` 的新增小型公开适配接口消费既有派发、终局证明、恢复与 Auto Integration，不接管 worktree 或 Git 生命周期。

**技术栈：** Node.js `>=22.19.0`、TypeScript `7.0.2`、Pi `1.4.0` Extension API、`pi-subagents-enhanced@0.1.0`、`pi-subagents@0.80.0`；复用当前依赖，不增加数据库、队列产品或第三方解析器。

**修订基线：** `main`，`8bc4a88f43550c342fbe3318ca295e93f3eb850c`；2026-10-27。已完成用户要求的 Pi 1.4.0 独立只读重审，本版由主会话依据有效意见修订。原 `d819dc5` / Pi `1.0.4` / `pi-subagents@0.75.0` 是初稿历史基线，不作为执行依据。执行前重新记录 HEAD 和相关 diff；当前另有 Playwright、writing-plans 等未提交修改，必须保留。

**计划关系：** 本文是轻量 Goal Runtime v1 的执行合同，取代旧 obligation runtime 作为本次建设依据；`docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 只作历史设计参考，不迁移旧状态、不依赖旧 production 路径，也不把旧 R13 当作本文的前置任务。建设仍由现有 subagent 工具编排，不由旧 Goal Engine 或未验收的新 runtime 执行自身。

## 全局约束

- 用户要求：初版务必考虑收敛成本，不做得过于复杂；能复用通用 managed worktree 的机制就复用，不额外造轮子。
- 执行中的 plan 是 goal 的契约来源；不要求用户重复设置 `/goal`，不另存一份可独立编辑的目标文案。
- 先实现一个 root session、一个活跃计划、一个 v1 schema；不迁移或读取旧 Goal Engine 的业务状态。
- 用户已撤回 resume 换模型需求：沿用 upstream 的原模型恢复，不给 `PlanExecutionService.resume` 或 `plan_retry` 增加 model 覆盖，不把换模作为本计划依赖。
- 用户确认：`context_usage` 保留为上下文使用量观测；退役接近压缩时要求 agent 写 handoff 文件的自定义流程。活动 Goal 用持续 checkpoint、compact 生命周期与确定性恢复接管；普通非 Goal 会话沿 Pi 默认 compaction，不创建虚构的 Goal 或另一套 handoff。历史 handoff 文件和原始 session 不删除、不改写。
- v1 聚焦仓库内 Subagent-Driven 编码计划；Inline、纯对话长期目标、跨 session 所有权转移不在首版。选择不支持的模式必须显式报错，不能降级成普通 prompt 后仍宣称受 harness 保障。
- Node 最低版本固定为 `>=22.19.0`；production 实现使用 `.ts`，并纳入 `tsc --noEmit`。
- `pi/extensions/` 只放 Host 绑定入口；可复用实现放 `src/goal-runtime/` 或所属 package。根 feature 只能通过 package exports 消费 package 能力，不深引其内部源码。
- 所有 workspace、lease、owner、publication、integration、disposition、cleanup 继续由现有 runtime 管理；不新增这些资源的账本、token、状态机或 `git worktree` mutation。
- coding child 自主集成；父层不得调用 integrate 绕过 `CHILD_OWNS_INTEGRATION`。失败资源按现有 typed 工具与当次状态权威处理。
- 不启用旧 Goal Engine 执行、编排或验收本计划。新 runtime 通过全部门禁前也不用于执行自身建设。
- 遵守共享规范中的测试授权边界：新增测试、全新 fixture、真实 provider 实验均标为“建议（待用户授权）”；本次写计划不构成这些操作的授权。
- 不默认 commit、push、发布或切换生产配置；需要这些动作时沿既有授权规则执行。不得为了执行计划自行提交用户 dirty 现场。
- 不读取或输出凭据；验证日志与运行状态不得包含凭据。npm 只使用 `https://registry.npmjs.org/`。
- TUI 只负责展示，不修改 agent 实际收到的原始消息、tool result、event 或 session 内容。
- 未执行、跳过、待批准、provider 不可用、资源债务或检查失效都不等于完成；不得删验收条件来收尾。

## 整体交付终态

在一个真实 Pi Host 中，用户明确开始执行计划后，runtime 能在已授权范围内持续推动其达成终态；compact、reload 和一次同 session 的进程重启不改变契约，不重复派发已知运行，不接受模型自报通过。任何无法证实的恢复停在明确的未完成状态。

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 执行 plan 即激活唯一目标，契约有源文件和版本绑定 | 隔离 Host 调用 `plan_execute`，检查 session custom entry | 无第二次 goal 设置；拒绝坏 DAG、缺终态、另一活跃计划和不支持模式；重复调用不重建执行 | 验收报告中的 session/entry 引用 | T1、T2、T6、T7、T8 |
| F2 | 依赖、资源与并发受到流程约束 | 两个独立前驱和一个后继的受控运行；检查真实派发记录 | ready 任务在容量内并发；后继仅在依赖接受后启动；Wave 不成为屏障 | run 引用、任务状态记录 | T1、T3、T4、T8 |
| F3 | 模型无法直接将终态设为通过 | 当前候选版本运行命令检查；传入伪造完成字段和旧证据 | 只有 harness 产生的有效检查回执能更新通过状态；completion/status 文案不升级为 proof | 检查回执、官方 run/workspace 引用 | T3、T5、T6、T8 |
| F4 | 未满足终态时维持修复与复验闭环 | 受控检查先失败，针对关联任务修复，再运行同一检查 | 失败保持未完成；修复后使旧证据失效；全部必要条件同时满足才完成 | 各轮回执与状态迁移 | T4、T5、T6、T8 |
| F5 | 多次 compact 和同 session 恢复能准确接续 | 两次 compact、一次 reload、一次重启继续同一 session | 恢复原契约、任务、run 引用、决策与未满足条件；已接受任务不重做；不确定 spawn 不重派 | session、checkpoint、恢复检查结果 | T2、T3、T7、T8 |
| F6 | 中断、查询、契约变化和空转有明确语义 | 查询状态、用户 pause/resume、修改契约、模拟无进展 | status 无业务副作用；暂停不偷偷续跑；契约变化阻止派发/完成；无进展停为未完成 | 状态与生命周期记录 | T1、T4、T6、T7、T8 |
| F7 | 通用 runtime 仍是资源权威且原路径不回归 | 既有 workspace、派发、Auto Integration 相关检查与源码依赖审阅 | 无第二套资源账本；不父层 integrate；无 Goal 新建的遗留资源；未启用 feature 时原工具行为不变 | 既有检查输出与资源审计引用 | T3、T6、T8 |
| F8 | 可交付实现有类型、公开边界及行为证据 | 类型检查、package 检查、获授权后的聚焦 Host/RPC 验证 | F1–F7、F9 的必需场景均通过；无用默认 skip 冒充通过；报告明确未执行项 | `docs/summaries/2026-10-26-goal-runtime-v1-verification.md` | T1–T8 |
| F9 | 保留上下文观测，退役阈值触发的手工 handoff | 既有 context usage 检查及隔离 Host 的 Goal/非 Goal 会话；覆盖高占用、unknown、compact 成功/失败 | `context_usage` 仍返回估计量和余量；不再发送“写 handoff”提醒或提供 handoff 路径；活动 Goal 由 checkpoint 恢复，普通会话使用 Pi 默认摘要；不删除历史文件 | context tool schema、session 记录、F5 恢复证据 | T7、T8 |

**完成规则：** F1–F9 必须全部通过；新增行为验证仍待用户授权时，记录验证阻塞，不能将本计划标为完成。真实 provider smoke 是首次启用前的单独建议，不将其默认执行或默认通过。

**未满足时：** 定位失败终态，修复对应范围，重验受影响条件与必要回归。若阻塞来源是权限、环境、未知运行身份或用户中断，保存未完成状态及恢复下一步；可独立推进的工作继续执行。

## 1. 已核对的复用边界

| 能力 | 当前入口或实现证据 | v1 使用方式 |
| --- | --- | --- |
| typed 派发、profile/model 选择、RPC、启动绑定 | `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`operation-tools.ts` | package 内公开一个薄适配接口，委托同一派发闭包；不另写 spawn 路径 |
| 官方终局证明 | 同 package 的 `root-broker-registry.ts`、`terminal-proof-binding.ts` | 只读消费已授权、已绑定 run 的证明；通知仅触发复查 |
| 托管工作区、集成与资源处置 | 同 package 的 `src/workspace/service.ts`、`child-integration-lifecycle.ts`、`integration-queue.ts` | 消费 canonical receipt；coding 接受须集成完成并释放 |
| 偶发故障续跑 | 同 package 的 `recovery-resume-contract.ts`、既有 `subagent_run_resume` | 复用已授权的 resume，记录返回的新 run；不实现恢复 daemon |
| session 所有权保护 | `src/session-owner/extension.ts` 与既有 wrapper | 保持既有保护；Goal 不建立第二个进程锁 |
| 持久化与分支 | Pi `appendEntry()`、`sessionManager.getBranch()` | 用 session custom entry 存业务快照；只从活跃分支恢复 |
| 继续执行边界 | Pi `agent_before_settle` 的 `context.canContinue`、`pendingMessages`、`outcome` | 请求一次续跑，等待子任务时不空转；`agent_settled` 仅观察 |
| compact 恢复 | `session_before_compact`、`session_compact`、`session_compact_failed`、`context` | 持久化检查点并在下一模型请求确定性注入恢复材料；保留 Pi 默认摘要 |
| 状态显示 | 普通 tool result；既有后台活动展示仍归原 owner | 首版不新增 footer、overlay 或后台活动框架 |

**Pi 1.4.0 已核对的事实与修订决策：**

| 当前事实 | 本计划的执行合同 |
| --- | --- |
| `./execution` 尚不存在，package 精确 exports 检查也未包含它 | 这是 T3 的明确新增交付物；同步 manifest、verify-package、既有断言，不将“待新增 API 不存在”本身视为不兼容 |
| 外层 `executeCoding()` 分配 workspace、编译公共输入并取得 Host 授权；内层 `dispatchExecution()` 强制 `worktree:false` | T3 绑定外层完整闭包；内层 false 是避免再分配 workspace，不能将公共 `worktree:true` 直接交给低层 adapter |
| 现有公开 workspace owner scope 为 `standalone-subagent` | 新 plan 仍派普通 coding child，沿用该 owner 和真实 root session；plan/task/attempt 是业务关联，不注入旧 `goal-task` ticket，不扩 owner gate |
| `appendEntry(customType,data)` 返回 `void`，nested tool 调用没有独立 transcript entry | T2 提供串行的状态与证据写入；凭唯一 evidence ID、payload hash 和当前 branch 找到真实 entry ID，T5 不猜 leaf 或 nested transcript ID |
| Pi settings 没有原生 `goalRuntime` 字段 | 使用 extension 自有 `pi/goal-runtime.json`，不修改 Pi SettingsSchema 或本机 enabledModels |
| 当前恢复存在 typed resume 与 integration manual handoff 两条边界 | T3 投影可续跑性；T4 将 manual handoff/unknown 保持 blocked，不自动 resume 或重派 |
| package AGENTS 仍写 `0.79.2`，实际 manifest/compat/verify 固定 `0.80.0` | T3 同步 policy 文本为已安装的 `0.80.0`；兼容入口历史文件名 `pi-subagents-0.75.ts` 不重命名、不据其推断运行版本 |

**当前环境前提：** 初稿曾遇到缺少 RPC session 身份的 `CAPABILITY_NEGOTIATION_FAILED`；本次 1.4 重审 child 已实际成功派发，因此不能继续把那次失败写成当前必现阻塞。另在合法 completed coding child resume 中确认了当前运行时缺陷：新 run 保留 required extensions，却跳过新 PID 的 Host 授权登记及合法 workspace/queue 重绑，导致 `child broker binding身份未就绪`；见 `docs/bugs/2026-10-27-managed-coding-resume-binding.md`。通用恢复接线已落盘并通过类型检查与既有 56 项回归，fresh Host 的真实恢复仍待验证；T3 在取得新进程授权和合法重绑证据前，不得将这类 retained coding workspace 投影成可用 typed-resume；只能明确 blocked，不能复制旧 grant、延长等待或移除 required extension。恢复缺陷归通用 runtime owner，不由 Goal 另建授权或资源账本。本次仍未运行 Goal start/compact/restart；T3/T8 必须取得实际能力证据。

注意：`./host-runtime` 是 physical Host/peer 绑定入口，不提供计划派发服务；`subagent_*` 属于 `model-only`，不能从 `ctx.executeTool()` 嵌套调用。T3 新 facade 在 package 内绑定既有执行闭包和 Host 服务；根 feature 只消费新 export，不深引 private registry。

## 2. 首版范围与收敛原则

1. **一个需求载体。** 在同一 plan Markdown 内增加一个 JSON 契约块，正文供人阅读；契约块中的目标、约束、任务和终态是机器执行权威。`writing-plans` 编写与自检时保证正文和契约一致；不尝试编写通用 Markdown/NLP 解析器。
2. **一个业务状态载体。** session custom entry 保存契约快照、任务状态与证据引用。日志输出与长材料留在既有工具/产物系统；不复制 workspace、进程或集成队列事实。
3. **一个正常闭环。** 激活 → 调度 → 接受可信结果 → 检查终态 → 失败关联修复 → 重新验证 → 完成。没有后台常驻 scheduler、oracle 注册中心、repair episode 或自动 amendment 协议。
4. **一个透明恢复出口。** 同 session 已知运行可重新核对；启动是否成功不可判定时阻塞而不重派。v1 不追求跨进程 spawn 的 exactly-once，也不以新造分布式事务解决它。
5. **受限终态检查。** v1 支持由已声明命令产生确定结果的必要条件；自然语言标准仍须转化为可执行检查。无法机械验证的必要条件必须报告不支持，不能静默省略或改为模型自评。独立语义 reviewer、人类签署条件留给后续明确需求。
6. **不重写现有安全规则。** Goal 工具的入口仍经过 Host tool hooks；下游派发保持原模型准入、权限和 workspace 规则。命令验证经过原 `bash` 工具和安全 hook，不用直接 `spawn` 绕过。Goal 不是 OS sandbox，不承诺拦截任意 shell 对文件的写入。

首版不做：旧事件格式兼容、全局 Goal registry、跨会话转移、多目标优先级、长期用户记忆、自动删任务/降低终态、自动 reviewer 终审、第二套资源预算/租约/工作区恢复。无新第三方依赖；设计增量集中在根 feature 和一个 package 适配边界。

## 3. 文件结构与责任

以下 `新增` 路径是计划交付物，并非当前已存在的 API。

| 路径 | 类型 | 责任 |
| --- | --- | --- |
| `src/goal-runtime/contract.ts` | 新增 | v1 类型、JSON 严格解码、单契约块读取、语义 hash、DAG/资源/检查引用校验 |
| `src/goal-runtime/session-state.ts` | 新增 | session 分支快照、同会话串行更新、revision 校验、恢复检查点 |
| `src/goal-runtime/policy.ts` | 新增 | ready set、资源容量、继续/等待/阻塞/验证决策；纯函数 |
| `src/goal-runtime/runtime.ts` | 新增 | 将派发回执、终局事实、任务重试与终态检查组成单闭环 |
| `src/goal-runtime/verification.ts` | 新增 | 候选版本指纹、受控命令验证、Host 回执与证据失效 |
| `src/goal-runtime/continuity.ts` | 新增 | compact/reload 恢复、决策/来源记录、确定性上下文投影 |
| `src/goal-runtime/index.ts` | 新增 | 本 feature 公开入口，注册工具与生命周期；不承载第二状态机 |
| `src/goal-runtime/config.ts` | 新增 | extension 自有配置的严格解码；缺文件默认关闭 |
| `pi/goal-runtime.json` | 新增 | 非敏感配置示例兼默认配置，`enabled:false`；不属于 Pi settings |
| `pi/extensions/goal-runtime.ts` | 新增 | 从 `PI_CODING_AGENT_DIR/goal-runtime.json` 读取配置、绑定真实 Host 与 package 适配器；child 中不启用 |
| `packages/pi-subagents-enhanced/src/execution/index.ts` | 新增 | package 对外执行适配接口、root session 绑定和只读运行事实投影 |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | 修改 | 将现有派发/控制闭包接入执行适配器；不改变原工具协议 |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts` | 必要时修改 | 在既有 proof delivery/release 异步结果可见后发事实失效提示，不增加权威或轮询 |
| `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` | 修改 | 注入真实 Broker、workspace、session 能力；绑定和释放适配器 |
| `packages/pi-subagents-enhanced/package.json` | 修改 | 新增 `./execution` 公开出口 |
| `packages/pi-subagents-enhanced/scripts/verify-package.ts` | 修改 | 同步精确 exports 清单与发布闭包 |
| `test/pi-subagents-enhanced-package.test.mjs` | 修改既有断言 | 同步合法公开出口，无新增测试案例 |
| `tsconfig.json` | 修改 | 将根 feature 和入口纳入既有类型检查 |
| `skill-overrides/writing-plans/SKILL.md` | 修改 | 输出结构化契约、执行入口及一致性自检 |
| `pi/AGENTS_GLOBAL.md` | 修改 | 获准执行结构化 plan 时调用 `plan_execute`；普通任务沿原路径 |
| `packages/pi-subagents-enhanced/README.md` | 修改 | 说明新增公开边界及复用关系 |
| `packages/pi-subagents-enhanced/AGENTS.md` | 修改 | 将落后的 upstream policy 版本同步为实际 `0.80.0`，保留 owner/兼容入口边界 |
| `pi/extensions/context-usage.ts`、`src/context-usage/snapshot.ts` | 修改 | 保留只读观测及 output schema，移除 handoff 策略字段和提醒生命周期 |
| `src/context-usage/reminder.ts` | 删除 | 消费者清零后删除 handoff 专属提醒实现 |
| `docs/context-usage-handoff.md` | 修改 | 说明只读观测、Pi 默认 compaction 和 Goal checkpoint 分工，移除手工 handoff 要求 |
| `test/context-usage.test.mjs`、`test/context-usage-extension.test.mjs`、`test/context-usage.integration.test.mjs` | 修改既有断言 | 同步观测 schema 和不再提醒的合同；不新增案例或 fixture |
| `docs/architecture/goal-runtime-v1.md` | 新增 | 用户流程、边界、状态、恢复和失败语义 |
| `docs/summaries/2026-10-26-goal-runtime-v1-verification.md` | 新增 | 实测版本、检查、场景、资源证据与限制 |

建议新增测试仅三份，均待用户具体授权：`test/goal-runtime-contract.test.mjs`、`test/goal-runtime-runtime.integration.mjs`、`test/goal-runtime-rpc.integration.mjs`。优先复用现有 deterministic provider、temporary arena、RPC helper，不新建通用测试框架。

## 4. 冻结的 v1 数据与工具合同

### 4.1 计划内契约

文件仅允许一个 `<!-- goal-runtime-contract:start -->` 至 `<!-- goal-runtime-contract:end -->` 区块，内部是一个标准 JSON fence。解码器只处理该块，不从 prose 推断条件。未知版本、字段、循环依赖、重复 ID、缺少检查、未知资源、空修复归属等均在产生副作用前拒绝。

核心类型如下；T1 落实这些名称并严格解码，后续任务以同一模块为权威；package 的运行引用类型归其公开出口所有，根 feature 只作结构兼容，不让 package 反向依赖根模块：

```ts
import type { ExtensionToolContext, FileEntry } from "@earendil-works/pi-coding-agent";

export type GoalCheck = {
  id: string;
  statement: string;
  command: { executable: string; args: string[]; timeoutSeconds: number };
  repairTaskIds: string[];
};
export type GoalTask = {
  id: string;
  agent: string;
  task: string;
  deps: string[];
  writePaths: string[];
  resources: string[];
  acceptance: { criteria: string[] };
  checkIds: string[];
};
export type PlanContract = {
  schema: "goal-runtime.plan.v1";
  objective: string;
  constraints: string[];
  resources: Array<{ id: string; capacity: number }>;
  checks: GoalCheck[];
  tasks: GoalTask[];
  terminalCheckIds: string[];
};
export type PlanBinding = {
  planPath: string;
  contractHash: string;
  repositoryRoot: string;
  sessionId: string;
  sessionFile: string;
};
export type GoalSubject = {
  repositoryRoot: string;
  head: string;
  contentHash: string;
};
export type GoalCheckpoint = {
  taskId?: string;
  decisions: string[];
  sourceRefs: string[];
  nextAction: string;
};
export type CheckReceipt = {
  checkId: string;
  contractHash: string;
  subject: GoalSubject;
  command: GoalCheck["command"];
  outcome: "passed" | "failed" | "stale" | "blocked";
  exitCode: number | null;
  toolCallId: string;
  resultRef: string;
  outputHash: string;
};
export type TaskState = {
  status: "pending" | "running" | "verifying" | "accepted" | "blocked";
  attempt: number;
  dispatchKey: string | null;
  workspaceId: string | null;
  run: { runId: string; workspaceId: string; rootSessionId: string } | null;
  terminalProofRef: string | null;
  integrationReceiptRef: string | null;
  blocker: string | null;
};
export type GoalState = {
  planId: string;
  revision: number;
  binding: PlanBinding;
  contract: PlanContract;
  status: "active" | "paused" | "blocked" | "completed" | "cancelled";
  tasks: Record<string, TaskState>;
  receipts: CheckReceipt[];
  checkpoint: GoalCheckpoint;
  pauseReason: string | null;
  lastProgressHash: string;
  noProgressTurns: number;
};
export type GoalCheckEvidence = {
  evidenceId: string;
  sessionId: string;
  contractHash: string;
  subjectBefore: GoalSubject;
  subjectAfter: GoalSubject;
  results: Array<{
    checkId: string;
    command: GoalCheck["command"];
    toolOutcome: Awaited<ReturnType<ExtensionToolContext["executeTool"]>> | null;
    blockedReason: string | null;
  }>;
};
export type GoalSessionDiskReader = (
  sessionFile: string,
) => Promise<readonly FileEntry[]>;
export type EvidenceWriter = (
  evidence: GoalCheckEvidence,
) => Promise<{ entryId: string }>;
export type CaptureSubject = (repositoryRoot: string) => Promise<GoalSubject>;
export type VerifyChecks = (input: {
  contract: PlanContract;
  binding: PlanBinding;
  checkIds: string[];
  toolCallId: string;
  ctx: ExtensionToolContext;
  writeEvidence: EvidenceWriter;
}) => Promise<CheckReceipt[]>;
```

约束：所有任务是 coding，`writePaths` 必须非空并遵从原派发文法；`task` 完整保存任务说明、输入产物/来源和停止条件，不只写 Task 编号。任务级 checks 可以为空，避免重复现有 child 验收；每个任务引用的 check，其 `repairTaskIds` 必须包含该任务自身，保证依赖已满足时至少有一个可达的修复入口，不能只能靠等待该任务 accepted 的下游修复。终态 checks 可关联多个已交付任务。终态 checks 不能为空，每个必要条件都有实际 check 和修复归属。修复只能引用契约内任务，不扩大路径；尚未授权的新检查不能进入可执行契约。

语义 hash 对完整解码契约做 canonical JSON + SHA-256；checkbox、排版不影响 hash。正文与契约冲突时停止并指出差异，不能选择较宽松的一边。v1 由编写自检和一次 plan 审阅核对语义一致性，不声称代码能自动理解全部正文；关键要求必须完整进入契约。

### 4.2 package 执行适配接口

新增 `pi-subagents-enhanced/execution`，由 package 的真实 Host 入口绑定。接口只开放已具备的动作与事实，以下名称是本计划新增合同：

```ts
export type PlanRunRef = {
  runId: string;
  workspaceId: string;
  rootSessionId: string;
};
export type PlanRunFacts = {
  run: PlanRunRef;
  terminal: "pending" | "succeeded" | "failed" | "unknown";
  terminalProofRef: string | null;
  integration: "pending" | "completed" | "blocked" | "not-applicable";
  integrationReceiptRef: string | null;
  workspaceState: string;
  recovery: "none" | "typed-resume" | "manual-integration" | "unknown";
  wakeup: "subscribed" | "unavailable";
  blocker: string | null;
};
export interface PlanExecutionService {
  start(input: {
    dispatchKey: string;
    request: { agent: string; task: string; writePaths: string[];
      acceptance: { criteria: string[] }; worktree: true; cwd: string };
    ctx: import("@earendil-works/pi-coding-agent").ExtensionToolContext;
    onAllocated: (workspaceId: string) => Promise<void>;
    onBound: (ref: PlanRunRef) => Promise<void>;
  }): Promise<PlanRunRef>;
  resume(input: {
    previous: PlanRunRef; dispatchKey: string; message: string;
    ctx: import("@earendil-works/pi-coding-agent").ExtensionToolContext;
    onBound: (ref: PlanRunRef) => Promise<void>;
  }): Promise<PlanRunRef>;
  inspect(ref: PlanRunRef): Promise<PlanRunFacts>;
  subscribe(listener: (runId: string) => void): () => void;
}
export function getPlanExecutionService(
  pi: object, rootSessionId: string
): PlanExecutionService | undefined;
```

`ctx` 使用 Pi 1.4 的真实 `ExtensionToolContext`；它本身不是授权凭据。服务由 package 主 Host 入口绑定到当前 root session 和 session manager；`start` 将完整扁平 coding 公共输入交给现有 `compileDispatchIR()` → `executeCoding()`，Host 内部继续生成 `AuthorizedDispatch`、选模、校验 profile/writePaths、分配 standalone workspace 并注册 proof authority。模型不能传入 authority、ticket 或 capability，也不能直接调用底层 `createCodingDispatchAdapter()` 跳过外层流程。所有新增 plan 工具仍经过 Pi tool hooks；复用路径不得跳过当前运行时自身的授权检查。

`start` 在原 ensureAllocated 返回后、RPC ping/spawn 前 await onAllocated，使已分配工作区可追溯；start/resume 在原授权与 workspace run binding 完成后 await onBound，先保存业务绑定再返回。不能把 async 保存回调塞进原同步 onBinding 并丢弃 Promise。调用失败不推断未启动。

启动协议：先写 `dispatchKey = planId/taskId/attempt` 的业务 intent，再调用原闭包。重复 intent 已绑定时返回同 run；已确认未发生副作用时才允许重新启动。若崩溃发生在 spawn 与业务绑定之间、现有权威资料不能恢复精确 run，则标记 `unknown` 阻塞；不得为保证“自动恢复”盲目新开 child。不新增跨 store 事务日志。

`inspect` 只在 package 内通过当前 root broker 的 canonical execution proof、同 owner 的 workspace service 和 repository coordinator 查询，再返回上面的只读 facts。必须同时校验 root session、run/workspace 绑定和 `standalone-subagent` owner；根 feature 不取得 raw broker、ledger、owner token 或 private coordinator 句柄。`released` 本身不证明已集成，必须核对匹配的 integration receipt；合法 no-payload 回执按现有 runtime 语义处理。

`resume` 的准入和返回证明分成两个时间点：inspect 的 `recovery:"typed-resume"` 只证明旧 attempt 已终止、owner/合同匹配、合法 pending resume intent 有效，且当前 Host 接线具备执行恢复的能力；新进程尚未产生，不能要求此时证明它已授权。实际 resume 复用原控制闭包及 supervisor/owner gate，message 非空；只有本次新 PID 的 Host 授权登记与 workspace/queue 合法重绑完成后，才 await onBound 并返回新引用。失败保持 blocked/unknown，upstream resumable、RPC 回执、旧 grant 或历史成功测试均不能替代本次后置证明。stopped、身份不明和 manual takeover 不放行。`subagent-integration-handoff` 仍为集成人工接管通知；服务撤销按实例精确比较，旧代不得删除新服务。

`subscribe` 是事实失效通知，不是 proof：覆盖 allocation/binding、terminal proof delivery、integration receipt/release 的最终结果可见以及失败/人工接管。T3 在现有 Host 异步闭包完成后发失效提示，必要时在 `root-broker-server.ts` 的 proof/release 完成处接一个轻量通知；不引入轮询器或新资源权威。订阅建立后立即 inspect/reconcile 已知引用一次以补竞争窗口。`wakeup:"subscribed"` 只用于确认有现存处理者且最终变化已被该订阅覆盖的 pending 工作；不能确认处理者或通知来源则 unavailable，并报告 blocked/现有 typed 诊断下一步，不能无限等已消费的 terminal 通知。

### 4.3 业务状态与工具

任务状态只保留 `pending / running / verifying / accepted / blocked`；Goal 只保留 `active / paused / blocked / completed / cancelled`。恢复是否完成、检查是否运行以局部字段表示，不扩成第二套生命周期枚举。

session 快照使用一个 `goal-runtime.state.v1` custom type，保存 binding、不可变契约、revision、任务 attempt/run 引用、checks 回执引用、结构化交接记录、暂停/阻塞原因及无进展计数。读取不写 checkpoint，不签发动作 token。更新串行化并校验 expected revision；异步回执按 task/attempt/contractHash 去重，重放旧回执无副作用。

模型工具仅五个，不恢复旧 exact-eight：

| 工具 | 参数要点 | 作用与禁止项 |
| --- | --- | --- |
| `plan_execute` | `plan_path`、`mode:"subagent-driven"` | 在用户已选择执行后绑定契约并启动 ready 任务；不能自行推定用户已同意执行 |
| `plan_status` | 无参数 | 只读展示当前契约、进度、等待原因和未满足条件，不推进执行 |
| `plan_checkpoint` | `task_id?`、`decisions`、`source_refs`、`next_action` | 记录结构化交接事实；不得设置 accepted/passed/completed |
| `plan_retry` | `task_id`、非空 `message`、`expected_revision` | 修复失败 check 关联任务，或恢复权威 facts 已确认失败且具有合法恢复路径的当前 attempt；后一类不要求 check 回执；不改变原合同 |
| `plan_verify` | `check_ids?` | 运行契约内检查并记录真实回执；不接受 command、passed 或 evidence 覆盖 |

**工具执行合同：** 五个工具使用 `executionMode:"sequential"`，`plan_execute/retry/verify/checkpoint` 使用 `exposure:"model-only"`，防止通过 codemode/嵌套执行绕过流程；`plan_status` 可保持 direct 只读。`plan_verify` 的 `reachesTools` 声明 bash，真实命令仅通过 `ExtensionToolContext.executeTool()` 调用当前可调用的 bash。顺序执行工具不阻止已派发 child 并行；长运行仍由原 runtime/完成通知驱动。

另外注册用户命令 `/plan pause`、`/plan resume`、`/plan cancel`、`/plan status`，只管理已激活计划，不要求 `/goal`。显式用户命令直接记录控制状态；普通新消息/steer 暂停自动续跑以便处理用户意图，主 agent 可说明并由用户恢复。不用另一个模型或正则猜测任意自然语言是否构成范围变更。cancel 记录 cancelled 并停止新调度，已有 run/workspace 引用继续保留；不等于停止 child 或清理资源，这些动作仍走原 typed 权限路径。cancelled 实例仍有 live/unknown run 时拒绝启动替代计划；确认闭合后可重新 plan_execute 新契约。pause/resume 不改变契约，cancel 不计为完成。

## 5. 正常执行与失败处理

### 5.1 调度与接受

- `plan_execute` 成功绑定后计算 ready set，在 `maxConcurrentTasks` 容量内派发所有资源兼容任务；资源按 plan 声明的容量计数，不创建全局资源服务。派发 task 正文由固定模板组合全局 objective/constraints、当前任务全文、依赖产物及证据引用；原样保留精确约束，不依赖 child 继承父会话历史，不擅自追加 commit/测试授权。
- 每次可信终局变化后刷新 run facts；只有原 runtime 证明 coding child 成功、集成完成且 workspace 已释放，任务才进入 `verifying`。子任务说明中的 acceptance 是执行要求，不替代 Goal checks。
- checkIds 为空时，按可信交付事实直接 accepted；非空时进入 verifying，检查实际执行期间计入本任务的计划资源。检查失败即转 blocked 并记录失败引用，结束本次检查的计划资源占用；随后合法 plan_retry 可重新获取资源。只有现实仍有 live/unknown run 或 integration 债务时，才按 adapter facts 保留相应占用，不能因业务 blocked 擅自释放真实资源，也不能在 workspace 已释放且检查结束后继续用 verifying 锁死修复任务。
- 依赖任务 accepted 仅说明对应产物已交付；后续合法修改会使最终 checks 失效，但不一律把所有历史任务退回 pending。最终终态始终基于当前候选版本重新检查。
- 无 active run、所有必要任务 accepted 后，执行全部 `terminalCheckIds`。只有本轮所有结果有效通过、无未处理运行/集成债务、源契约未变，才能写 completed。

### 5.2 `fix → test` 闭环

- 验证失败时，回执明确指出 check、实际结果和 `repairTaskIds`；主 agent 先判断失败原因，再通过 `plan_retry` 提供针对性指导，不机械重复相同命令。
- `plan_retry` 有且只有两种准入：其一，失败 check 的 `repairTaskIds` 关联任务；其二，adapter 的权威 terminal facts 已确认当前 attempt 失败、无 live attempt，且现有 runtime 提供合法恢复路径的原任务。第二种覆盖验证前失败及 `checkIds:[]` 的任务，不要求先产生 check 回执。二者均校验 revision、原 contractHash/attempt、非空指导和原 writePaths/依赖/资源/profile，不新造任务或扩大 DAG。
- 恢复既有 run 时仍须 T3 证明 typed resume 的新进程授权与资源重绑；新 attempt 仅在原 runtime 明确允许、旧运行和资源事实已闭合时使用，不能用 fresh start 绕过 unknown、stopped、身份不明或 manual-integration 阻塞。检查失败不自动证明 child 可恢复，child 失败也不伪造检查失败回执。
- 修复任务成功后重验其 checks 和受影响终态；最终完成前统一重跑 terminal checks，首版不做路径级精细失效图。
- 已是 accepted 的关联任务可打开新修复 attempt；依赖结构不变，已有下游产物保留，但 final 证据失效。同任务同时只能有一个 live attempt。
- 子任务失败且尚有受管 workspace 时，复用现有 resume 与 typed 处置流程；Goal 不直接清理，不以失败通知授权 discard/preserve。
- 环境、身份或权限错误按 blocked 记录，不归类为代码错误而自动无限重试；其余独立 ready 任务仍可推进。

### 5.3 候选版本和真实检查

`captureSubject(repositoryRoot)` 仅在验证批次和完成判定时运行，不在每个 context/status 请求中扫描仓库；使用 Git 列出的 tracked 和未忽略 untracked 路径，计算 HEAD、路径/文件类型/内容摘要的统一 hash；符号链接只记录 link target，不跟随到仓库外。只保存摘要，不保存文件内容。既有忽略规则继续决定 runtime 私有文件不进入交付候选；不自动更改 `.gitignore`。

`verifyChecks` 每批检查共用一次前/后 subject 捕获；批次中发生候选漂移则整批 stale。最终 terminal checks 仅在本计划全部 child 已终止并完成集成后运行；任务级 checks 可与其他隔离 child 并行，但验证期间不发新任务，并在记录回执时拒绝发生候选漂移的结果。检查后立即重新计算 ready set，不等待其他同 Wave 任务；不能以全局验证锁把整个 DAG 串行化。

调用使用 Pi 1.4 真实签名 `ctx.executeTool("bash", {command,timeout}, {signal:ctx.signal})`，先确认 bash 在 `ctx.tools` 中。`command` 只由固定契约的 executable/args 和 repository root 经正确 shell quoting 组成；不传 bash schema 中不存在的 cwd 字段，不直接 spawn 绕过 hooks。返回值是 `AgentToolCallOutcome`，校验 `outcome.isError`、`outcome.result.isError` 与 `outcome.result.structuredContent.exit_code`；只有非错误、完整且 exit_code 为 0 的实际结果才可记 passed。超时、中断、permission block、缺码均不通过。

嵌套 bash 不产生独立 transcript entry。T5 生成 `GoalCheckEvidence`，通过 T2 注入的 `writeEvidence` 与状态更新共用短写队列，append `goal-runtime.check-result.v1`。`appendEntry()` 返回 void：写入前分配唯一 evidenceId，写入后从当前 branch 查找 customType、sessionId、evidenceId、payload hash 全部匹配的唯一真实 entry；不能盲读最后 leaf。上述 branch 匹配只完成条目身份定位，后续文件核验成功后才返回 entry ID 并提交 receipts/passed。其他 extension 即使插入 entry，也不能冒充该 evidence。append 或关联核验失败时保留 blocked/stale，不发布内存通过状态。

确认条目身份后还必须核对它已存在于当前 `binding.sessionFile`，才可返回 entry ID 或提交 passed。`appendEntry()` 抛错时，Pi 1.4 可能已先更新 SessionManager 内存索引；因此 branch 唯一匹配只证明身份，不证明写盘。T2 对本实例设置持久化失败 latch，阻止新派发/修复/完成；不靠再次读取同一 branch 清除，也不 append 补偿记录或回滚原 session。

回执保留 check ID、contractHash、subject、精确命令、退出码、父 plan_verify toolCallId、实际 session/entry 引用和输出摘要；原 tool outcome 放在该证据 entry 和父工具 details 中，不为 TUI 改写。业务状态和证据仍使用同一 Pi session，不增加另一个存储服务。

检查写入 tracked 或未忽略 untracked 产物导致 subject 变化时，结果标为 stale 而不是通过；需要此类产物的计划应先在任务中生成，再使用只读验证命令核对。验证前后或记录 completed 前发生版本变化，终态全部待重验。首版采用全候选失效，省去 adapter/environment/stability oracle 图。

收尾顺序固定为：先写仓库内报告与计划步骤记录 → 冻结这些交付写入 → 捕获候选并运行只读终态检查 → evidence/completed 仅写 session → 对话引用最终 receipt。报告可引用前序实测，最终候选的完成权威在 session；不要把每轮最新 receipt 再写回候选报告，制造 hash 无限变化。若必须再改报告，改完重新验证一次，此后停止写入。checkbox 只不影响 contractHash，仍影响 contentHash；不能为收敛排除整个 docs 或另建存储。

### 5.4 继续、等待和暂停

`agent_before_settle` 读取 `event.context.canContinue`、`event.context.pendingMessages`、`event.outcome` 和前序 handler 的 `event.continue`，使用 `{entries?,continue?}` 返回合同。已有 continuation 或队列能推动下一请求时不重复插入。根据真实状态处理：

1. 用户中断、`outcome` 为 aborted/error、paused、契约漂移或恢复失败：不请求自动 continuation，保留未完成与下一步。
2. 有既有 pending messages：优先 Pi 原队列，不额外插入同一轮继续消息。
3. 权威失败 attempt 有合法恢复路径（即使无 check 回执）：请求主 agent 提供针对性指导并调用 plan_retry，不等待模型猜测。检查失败同样走已有 repairTaskIds；资源已闭合且无 live 时不继续停在 verifying。
4. 有 ready 任务：只请求一次 continuation，明确调用 plan_execute 推进同一实例；重入同 planPath/contractHash/session 仅 advance。任务待检查或必要证据 stale 时明确调用 plan_verify。派发只在这些真实工具入口发生，通知/settle hook 不直接 start。
5. pending 工作有真实处理者且 facts.wakeup 为 subscribed：等待对应事实变化，无轮询/空转；只有终止通知却尚未交付 proof/integration/release 的情形仍由 T3 的后续通知唤醒。没有处理者/唤醒来源、unknown、manual integration、权限或存储阻塞则明确 blocked，列事实、引用与现有 typed status/人工处置下一步，不假称完成。
6. 需要补 checkpoint/决策或尚待验证时，canContinue 为 true 才请求一次明确动作，否则记录未完成。全部终态通过才 completed，不再续跑。

上述规则由 `decideNextAction(state,facts)` 返回最小的 advance/retry/verify/wait/blocked/done 决策与具体 task/check/reason。T6 在同代订阅回调中先 refreshRuns，再核对决策；真正 idle 后才到达的可执行事实变化，通过一次 `pi.sendMessage(...,{triggerTurn:true,deliverAs:"followUp"})` 沿现有队列唤醒主 agent，内容明确要调用哪个 plan 工具，不能直接派发。用同一实例的待续跑标记及有效事实指纹去重，已有消息/continuation 时不重复注入；暂停或用户队列优先，不借通知恢复用户暂停。订阅后立即 reconcile 一次，覆盖已经完成的状态。

无进展保护只统计 Goal 自己请求的 continuation，以一次完整自动推进后的稳定结果为采样点；排除正常 child/资源等待与已有用户队列。比较已接受成果、候选内容（仅复用既定验证点的 subject）和有效检查结论；相同失败指纹下 running→verifying→blocked 的往返、时间戳/receipt ID/重复 status 不算进展。连续 3 次无进展暂停为未完成，不新增 settle 时仓库扫描，也不自动降低终态。

## 6. compact、reload、重启与契约变化

- 每次产生任务/检查变化立即 append session 状态，不等 context 将满才保存。
- `session_before_compact` 持久化当前状态和交接引用；保存失败明确 `cancel:true`，不得只 throw 后假设压缩被阻止。
- `session_compact` 成功后设置内存恢复标记；`session_compact_failed` 解除该次压缩的临时标记，不清除真实业务阻塞。
- `session_start` 先区分正常空会话：当前 branch 无 Goal entry、无 user/assistant conversation，且 SessionManager 指向尚未创建的持久 session 文件时，restore 返回 null，不创建 Goal、不设置失败 latch；首次 plan_execute 仍须把真实 intent 写入文件并确认后才派发，不主动创建空文件或调用私有 persist。
- 存在 Goal entry 或已有 conversation 的恢复才按当前 branch 定位候选，并核对同 session 文件 header/sessionId、Goal state/evidence 的 ID/parentId/payload hash 与引用链；不能从磁盘其他分支取“最新”。reload 复用原 Manager，只有内存 Goal entry、已有文件异常丢失、解析/引用不完整均 blocked；`--no-session` 不支持 Goal。
- `PlanBinding.sessionFile` 由 Host 取得，不能由 plan JSON/模型指定。T2 只读同一 JSONL，标准行解码核验 header 与所需记录，不调用私有写方法或新建 journal/index/数据库。恢复时核对完整当前分支；正常串行提交仅确认本次新条目及其引用，复用本代已核验事实；status/context 不反复读全文件。不能用宽松“跳过坏行”掩盖缺证据。
- append 或读盘核验失败后，本 store 保持不可写；后续初始化只能凭实际 session 文件核验重新恢复。该确认表示文件中存在完整记录，不额外承诺 fsync/断电事务保证。
- 下一次 `context` 请求前，确定性恢复目标、全局约束、未满足终态、当前任务完整合同、run 引用、决策/来源和 next_action。正文长材料通过明确路径引用按需读取；权威约束不只放进可再次摘要的旧消息。
- `context` hook 只生成模型请求投影，不篡改历史消息、工具结果或 UI 数据。恢复读取失败时置 blocked；tool gate 阻止 Goal 的派发/修复/完成操作，仍允许只读诊断。
- reload/重启后先用 adapter 核对已知 run；活跃则等待、成功则继续验收、不明则 blocked。不把 status-only、超时或 Host 退出当作终局证明。
- 存在非终态 Goal 或仍未闭合的 run 时禁止 fork/tree 回到旧业务状态；session_before_fork、session_before_tree 明确返回 cancel，说明可先 pause 诊断、完成或 cancel 并核实资源闭合后再导航。普通 session switch 不转移计划，切回原 session 才恢复；旧 generation 取消订阅，不误写新 session。
- `session_before_switch` 在仍属于旧 session 时保存状态；普通 `/new` 或 `/resume` 不转移 Goal，也不擅自停止 child。保存失败返回 `cancel:true`，成功后由 shutdown 撤销旧订阅，切回原 session 才恢复。
- `session_shutdown` 幂等撤销该实例的订阅和内存绑定；不把退出等同于 child 已终止或 workspace 已释放。每个异步回调捕获 session ID、manager 实例和 generation，写入前重核；旧回调不得 append 到新 session。
- 首版不支持原地 amendment。契约 hash 变化时暂停，保留旧证据，先由用户处理 live run，再用 /plan cancel 结束旧执行并重新授权新版本；旧状态不迁移成新契约已完成。

### 6.1 配置与上下文观测迁移

- Goal 配置归 extension 所有，路径是可信 `PI_CODING_AGENT_DIR` 下的 `goal-runtime.json`（本仓 `pi/goal-runtime.json`）；缺文件视为关闭，存在但非法则报告配置错误并不注册执行能力。不得读取 `~/.pi` 猜路径或向 Pi settings 写未知字段。
- 固定 v1 配置为 `{ "enabled": false, "maxConcurrentTasks": 2, "maxNoProgressTurns": 3 }`；仅允许这三个字段，两个计数为正整数。新增 `src/goal-runtime/config.ts` 的 `readGoalRuntimeConfig(agentDir)` 返回该类型；主 Host 入口在 `PI_SUBAGENT_CHILD === "1"` 或 `PI_SUBAGENT_FANOUT_CHILD === "1"` 时立即退出。缺 trusted agentDir 时 fail closed。
- `context_usage` 保留 `tokens/contextWindow/percent/remainingTokens/remainingRatio/estimated/note` 及 `known|unknown` 观测状态；去掉 `handoffPath`、`tokensBeforeHandoff`、`tokensBeforeUrgentHandoff`、两个 should* 和 prepare/urgent-handoff 枚举，不把预算观测伪装成 compact 精确阈值。
- 删除 `agent_end` handoff 提醒、compact 后提醒去重重置、对应 reminder 实现和 promptGuidelines 中写 handoff 的要求。只改当前工具 schema/实现/文档和既有断言；不重写历史 tool results/session、旧计划或 handoff 文件。
- 活动 Goal 的状态变化立即持久化，compact 前保存现有 checkpoint，不再要求模型临时编写 `.pi/handoff/context-handoff.md`。无活动 Goal 时 continuity handlers pass through，普通会话依靠 Pi 默认摘要；保留观测不意味着保留旧手工 handoff 协议。
- F5 的实际恢复与 F9 的观测迁移必须分别有证据；仅移除 reminder 或 tool 字段不能证明 Goal 恢复已完成。

## DAG

```text
T1 契约/公共类型 ──> T2 session 状态 ──> T4 调度/修复 ──> T6 工具/执行入口 ──> T7 恢复/控制 ──> T8 验收
       ├─────────> T3 package 适配 ──────┘                  ↑                     ↑
       └─────────> T5 验证/证据 ──────────────────────────┘                     │
                        T7 的传递依赖已包含 T2/T4，不再增加重复边
```

边及其产物：T1→T2 是业务类型；T1→T3 是派发/运行事实接口；T1→T5 是 check/subject/回执接口；T2、T3→T4 是持久化入口和执行服务；T4、T5→T6 是执行闭环和可信验证；T6→T7 是包含 store/runtime 的 Host 注册点；T7→T8 是可启动的完整 Host 功能。

## Waves

- Wave 1：T1。
- Wave 2：T2、T3、T5（接口冻结后并行；WritePaths 分离）。
- Wave 3：T4（消费 T2/T3；无需等待独立进行的 T5）。
- Wave 4：T6（消费 T4/T5）。
- Wave 5：T7。
- Wave 6：T8；新增测试和真实 smoke 各自按授权执行。

**关键路径：** T1 → T3 → T4 → T6 → T7 → T8；若 T2 更晚交付则其成为 T4 的前置瓶颈。Wave 仅帮助阅读，ready 任务按真实依赖立即推进。

## Task T1：冻结一个可执行的计划契约与最小接口

**Deps：** `none`。

**WritePaths：** `src/goal-runtime/contract.ts`、`docs/architecture/goal-runtime-v1.md`。

**Resources：** `none`。

**Files：** Create：上述两个路径。

**接口契约：** Consumes：本文 §4 和当前扁平 coding dispatch 公共输入（无 version 字段；内部 dispatch-ir 由 package 编译，不从公有字段推断内部版本）。Produces：§4.1 的 `PlanContract`、`GoalTask`、`GoalCheck`、`PlanBinding`（含 Host 绑定的 sessionFile）、`GoalState`、`TaskState`、`CheckReceipt`、`GoalCheckpoint`、`GoalSubject`、`GoalCheckEvidence`、`GoalSessionDiskReader`、`EvidenceWriter`、`CaptureSubject`、`VerifyChecks`；以及 `readPlanContract(filePath): Promise<{contract:PlanContract;contractHash:string}>`、`decodePlanContract(value:unknown): PlanContract`、`hashPlanContract(contract): string`。`VerifyChecks` 使用真实 `ExtensionToolContext` 并注入 `writeEvidence`，T5 无需依赖 T2 实现即可编译。package 自有运行引用类型，根模块不成为其反向依赖。禁止下游各自猜字段。

**终态关联：** F1、F2、F6、F8。

**验收标准：** 精确拒绝未知格式、坏 DAG、重复/丢失引用、无必要终态、非法写路径或资源容量；读取只做文件与纯结构验证；正文无效不从模型猜测补全。

- [ ] 核对真实 `dispatch-ir` 和本文接口；记录新增与已有 API 的区别。
- [ ] 实现唯一 marker/fence 提取、JSON 解码、跨引用与 DAG 校验、canonical hash；任务级 check 必须包含该任务为修复入口，拒绝只有被自身 accepted 阻挡的下游才能修复的合同；不扫描整篇 Markdown 猜任务。
- [ ] 在 architecture 文档写一个可直接 JSON.parse 的真实小型契约例子：两个独立任务及一个依赖任务，每项映射到实际的命令检查；不用未定义 ID。
- [ ] 运行 `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node src/goal-runtime/contract.ts`；T6 纳入 include 前以此显式覆盖新模块，不把 root 检查漏掉新模块的成功算成通过。
- [ ] 建议（待用户授权）：在三份建议测试中的 contract 文件覆盖上述公开解码行为；测试编写集中到 T8，不由本任务另加 helper。

## Task T2：复用 session 的持久化业务状态

**Deps：** `T1`（消费 `GoalState` 和 checkpoint 类型）。

**WritePaths：** `src/goal-runtime/session-state.ts`。

**Resources：** `none`。

**Files：** Create：该路径。

**接口契约：** Consumes：T1 类型、Pi 1.4 的 `getBranch(): SessionEntry[]`、当前 `getSessionFile()` 和 `pi.appendEntry<T>(customType,data): void`。Produces：`readPersistedGoalEntries: GoalSessionDiskReader`；`restoreGoalState({branch,sessionId,sessionFile,readPersistedEntries}): Promise<GoalState|null>`；`createGoalStateStore({sessionId,sessionFile,readBranch,appendEntry,readPersistedEntries})`，返回 `restore()`、`read()`、`update(expectedRevision,change)`、`checkpoint(value)`、`writeEvidence: EvidenceWriter` 和 `assertWritable()`。restore 完成前及持久化失败 latch 生效时，assertWritable 拒绝业务副作用；read 只返回最后已核验状态，诊断附加本实例的真实存储阻塞，不伪造持久化 blocked 快照。change 为类型化纯状态转换，不接受任意 JSON patch。证据引用仍来自当前 branch 中唯一匹配的 entry ID，并由同一 session 文件确认。

**终态关联：** F1、F5、F6、F8。

**验收标准：** 同一 session 更新串行化；版本冲突和旧 attempt 回执拒绝；append 失败不发布事实且不被同 Manager reload 绕过；正常无 Goal 的未落盘新空会话可返回 null，首次派发仍要求 intent 实际写入；恢复当前分支的 state/evidence 与引用链均有文件记录；不创建第二份状态文件、全局 registry 或进程锁。

- [ ] 实现 v1 快照严格解码与只读 session 核验；正常尚未落盘的新空会话且无 Goal/conversation 时返回 null，不锁死首次执行。恢复现有 Goal 时校验 Host file/header/sessionId、contractHash、分支 Goal entry 与引用链；缺持久事实保持 blocked。
- [ ] 用一个短 Promise 队列串行提交；提交前校验 revision，append 返回且 branch 身份/文件持久化均核验后发布新快照。`writeEvidence` 依据 evidenceId/customType/session/payload hash 定位真实 entry ID，再确认写盘；零个或多个匹配拒绝。长派发/检查在队列外，结果回来后重核身份。
- [ ] append/核验失败设置不可写 latch，后续 assertWritable 拒绝派发/修复/完成；不改写 SessionManager 内存索引、不补 journal、不调用私有写方法。reload 的新 store 重新从实际文件核验，不能凭旧 Manager 内存清除阻塞。
- [ ] 对 corrupt/foreign state 返回明确 blocked 原因；不存在与不可读不混为一谈。
- [ ] 运行 `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node src/goal-runtime/session-state.ts`；检查状态写入只走 Pi public API。

## Task T3：为通用 runtime 增加薄公开执行适配器

**Deps：** `T1`（消费冻结的请求与回执接口；package 对外类型由 `./execution` 自有，不反向 import 根 feature）。

**WritePaths：** `packages/pi-subagents-enhanced/src/execution/index.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`packages/pi-subagents-enhanced/package.json`、`packages/pi-subagents-enhanced/scripts/verify-package.ts`、`packages/pi-subagents-enhanced/README.md`、`packages/pi-subagents-enhanced/AGENTS.md`、`test/pi-subagents-enhanced-package.test.mjs`。

**Resources：** `none`；真实 Host 起停另归 T8，避免实现过程中混跑真实子任务。

**Files：** Create：`src/execution/index.ts`（相对 package）；Modify：其余所列文件。既有 package 测试只调整 export 断言，不新增案例。

**接口契约：** Consumes：现有 `compileDispatchIR` → `executeCoding` 的完整公共输入和 Host 授权闭包、typed control/resume 闭包、Root Broker official proof、同 `standalone-subagent` owner 的 workspace/coordinator receipt。Produces：§4.2 的 `getPlanExecutionService`、`PlanExecutionService`、`PlanRunRef`、`PlanRunFacts`（含 recovery/wakeup/blocker）；新增 package export `"./execution":"./src/execution/index.ts"`。新出口内的 bind/unbind 仅由 package Host 使用，根 feature 不获得裸服务 authority。

**终态关联：** F2、F3、F5、F7、F8。

**验收标准：** 原 `subagent_*` 工具注册与 schema 不变；Goal 与原工具使用同一闭包。start/resume 保留全部原有模型和权限规则；inspect 不将 completion/status 当 proof；coding completion 同时核对官方 proof、匹配集成回执、released。服务按真实 root session 注册，reload 对旧 owner 的清理不删除新实例。

- [ ] 将当前 `createTypedSubagentExtension` 已持有的 coding/control 闭包绑定为 adapter，保留 Host 内部签发 `AuthorizedDispatch` 的路径，不直接调用低层 `dispatchExecution` 充当完整 start。onAllocated/onBound 在对应原异步步骤后 await，不能复用同步通知回调假装已持久化。不复制 RPC、进程管理或 worktree 分配逻辑；绝不注入 goal-task owner 或新增 capability。
- [ ] 在现有 root Host 的 session 生命周期绑定/释放服务；同一 manager/root identity 校验用于 start、resume、inspect，旧实例仅能撤销自己。未启用 Goal 的普通路径不依赖根 Goal 模块。
- [ ] `inspect` 从 package 内已绑定的 broker/service/coordinator 取 facts，校验 run、workspace、owner 和 receipt 对应关系。保留 child-owned integration 与 no-payload 语义，不把 released/status/通知单独当成功。无法取权威 proof 时返回 unknown/blocked，不扩 owner service。
- [ ] `resume` 前置证明旧终态、有效 owner/pending intent 与当前接线能力；本次新 PID 授权/重绑是返回 onBound 前的后置证明，不作为 inspect 的循环前提。manual takeover/stopped/unknown 不自动恢复。`subscribe` 在现有 binding/proof delivery/integration/release 异步闭包最终结果可见后发失效提示；建立订阅后立即 reconcile 一次，缺可信处理者或唤醒则 facts.wakeup=unavailable 并 blocked，不造轮询器。
- [ ] 同步 package exports、verify-package 的精确清单、README、AGENTS 的已安装版本 `0.80.0` 与既有测试断言；不升级依赖、不重命名历史 compat 文件。
- [ ] 运行 `npm run typecheck:subagents-enhanced`；根据副作用审计运行现有的 `test/subagent-execution-contract.test.mjs`、`test/subagent-auto-integration-plan.test.mjs` 和 package 元数据聚焦检查。不调用真实 provider。

## Task T4：实现依赖调度和受限修复闭环

**Deps：** `T2`（状态 store）、`T3`（执行服务）。

**WritePaths：** `src/goal-runtime/policy.ts`、`src/goal-runtime/runtime.ts`。

**Resources：** `none`。

**Files：** Create：上述两个路径。

**接口契约：** Consumes：T1 类型、T2 store、T3 `PlanExecutionService`。Produces：`readyTasks(state,capacity)`、`decideNextAction(state,facts)`；`createGoalRuntime({store,execution,verify,captureSubject})`，返回 `activate(binding,contract)`、`advance(ctx)`、`refreshRuns()`、`retryTask(taskId,message,expectedRevision,ctx)`、`recordCheckpoint(checkpoint)`。verify/captureSubject 消费 T1 已冻结的函数类型并做依赖注入，不 import T5 的未完成实现。

**终态关联：** F2、F4、F6、F8。

**验收标准：** 所有资源兼容 ready 任务在容量内推进；不等待整 Wave；同 task 无并行 attempt；只有 proof/集成完成后才验证；检查失败关联修复与验证前 child 失败恢复均有合法准入；不扩大 DAG/writePaths 或创建资源清理机制。

- [ ] 实现纯调度与资源计数，外部资源状态仅引用 adapter facts，不写回自造 receipt。任何业务副作用前调用 store.assertWritable，恢复未完成或存储已失败时仅允许只读诊断。
- [ ] 持久化 dispatch intent，调用 adapter，保存绑定；明确“已绑定”“已证实未启动”“启动结果不明”三种处理，不盲目重试 unknown。
- [ ] 实现 running→verifying→accepted；任务 check 失败即 blocked，结束检查的计划资源占用，保留现实 live/unknown/integration facts 对占用的约束。§5.2 两类 retry 均有明确下一工具与可达入口；unknown/stopped/manual-integration/owner或proof冲突不放行。
- [ ] 实现稳定进展指纹与暂停理由；重复 status/时间戳不重置无进展计数。
- [ ] 运行 `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node src/goal-runtime/policy.ts src/goal-runtime/runtime.ts`；不将源码字符串检查当成调度行为证据。

## Task T5：实现 Host 运行的检查与全候选证据失效

**Deps：** `T1`（check、subject、receipt 合同）。

**WritePaths：** `src/goal-runtime/verification.ts`。

**Resources：** `none`；验收期命令验证以 repository candidate 独占执行，不和本计划 live writer 并行。

**Files：** Create：该路径。

**接口契约：** Consumes：T1 类型、真实 `ExtensionToolContext`/`AgentToolCallOutcome` 以及注入的 `EvidenceWriter`；不 import T2 实现。Produces：`captureSubject(repositoryRoot): Promise<GoalSubject>`；符合 T1 `VerifyChecks` 的 `verifyChecks({contract,binding,checkIds,toolCallId,ctx,writeEvidence}): Promise<CheckReceipt[]>`；`receiptsAreCurrent(receipts,subject,contractHash): boolean`。

**终态关联：** F3、F4、F8。

**验收标准：** 只能执行固定契约中已有检查，所有命令走原 bash hooks；以 structured exit code 取证。before/after subject 变化为 stale；旧契约、旧版本、缺结果和 caller 自带 passed 都不能通过。命令超时/中断不标通过；输出不因 UI 精简而被改写。

- [ ] 实现 Git 路径清单与内容指纹，覆盖删除、rename、untracked、符号链接；不跟随 symlink，不读取仓库外文件，不把输出日志放进候选目录。
- [ ] 正确 quoting 参数和 repository root，按 `{command,timeout}` 调用 bash；核对 bash 在 `ctx.tools`、signal 传递及 `outcome.result.structuredContent.exit_code`，不使用旧签名、`details.exit_code` 或不存在的 cwd 参数。生成批次 `GoalCheckEvidence` 后经注入的 writer 保存真实结果，再用其 entryId 形成回执；append 未确认时不提交 passed。
- [ ] 检查前后核对 subject；记录结果后、completed 前再次检查当前 subject；保留失败与过期历史但不用于当前完成判定。
- [ ] 运行 `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node src/goal-runtime/verification.ts`，并核对所有可执行调用都经过原工具入口，没有新增直接 subprocess 执行验证的旁路。

## Task T6：接入五个工具和 plan 执行入口

**Deps：** `T4`（runtime/policy）、`T5`（真实验证）。

**WritePaths：** `src/goal-runtime/index.ts`、`src/goal-runtime/config.ts`、`pi/extensions/goal-runtime.ts`、`pi/goal-runtime.json`、`tsconfig.json`、`skill-overrides/writing-plans/SKILL.md`、`pi/AGENTS_GLOBAL.md`。

**Resources：** `none`。

**Files：** Create：`src/goal-runtime/index.ts`、`src/goal-runtime/config.ts`、`pi/extensions/goal-runtime.ts`、`pi/goal-runtime.json`；Modify：其余所列文件。自有配置提交默认 `enabled:false`，不修改本机 `pi/settings.json` 或其 enabledModels。

**接口契约：** Consumes：T1–T5 public 接口、package `./execution`。Produces：`GoalRuntimeConfig = {enabled:boolean;maxConcurrentTasks:number;maxNoProgressTurns:number}`、`readGoalRuntimeConfig(agentDir): Promise<GoalRuntimeConfig>`、`installGoalRuntime(pi,options)`。options 包含配置（默认 false/2/3）和执行服务 resolver；将 store.writeEvidence 注入 verify/runtime。入口只读取 §6.1 的 extension 自有配置，关闭时不注册 plan 工具或执行 hooks；不读取旧 goalEngine 配置，也不假设 Pi SettingsSchema 接受 goalRuntime 字段。

**终态关联：** F1、F3、F4、F6、F7、F8。

**验收标准：** 用户仍先按 GLOBAL 选择执行方式；支持的结构化计划走 `plan_execute`，不另输 `/goal`；错误模式与缺少执行服务显式拒绝。plan_status 不改变 revision。模型无直接 complete/pass setter，修复与验证均受来源绑定约束。

- [ ] 实现 `readGoalRuntimeConfig`：只读可信 agentDir 下的自有 JSON，严格拒绝未知字段和非正整数计数；缺文件返回 false/2/3，非法文件或身份缺失不注册执行能力。提交默认关闭配置并安装 child guard，不向 Pi settings 增加字段。
- [ ] 工具 schema 使用单 object 根与未知字段拒绝，按 §4.3 声明 exposure、sequential 和 reachesTools；只有局部版本更新工具要求 revision，不引入每步 action token。工具执行经过原 Host hooks，派发 authority 只能由 T3 内部取得。
- [ ] 实现工具入口对 session、Host sessionFile、当前契约、store.restore/持久化失败 latch 与并发的校验；plan_retry 同时支持两种已冻结准入，不以缺 check receipt 拒绝权威失败 attempt 的合法恢复；不改变普通任务权限。
- [ ] 实现 §5.4 的穷举下一动作、一次 continuation 与 idle 事实变化唤醒。失败 child 无 check 也明确 retry；pending 仅在有处理者/订阅时 wait，其他情况给 blocked 及 typed 诊断。共享同代待续跑标记与指纹，已有队列或用户暂停不重复唤醒，通知/settle 不直接 start；普通会话 pass through。
- [ ] 更新 writing-plans 的契约块模板、终态到 command 的映射与一致性自检，维持新增测试授权规则；不能机械改写历史计划。
- [ ] 更新 GLOBAL 的执行入口说明，仅当 Goal 工具已注册且 feature 已启用时进入 plan_execute；关闭时保留原执行路径并如实说明没有 Goal 流程保障。保持首次计划审阅与用户执行方式选择，不将当前编写此计划解释为执行授权；启用后若执行服务缺失则显式阻塞，不静默降级。
- [ ] 将 feature/入口加入 tsconfig，运行 `npm run typecheck`；检查入口默认关闭与 child guard。

## Task T7：完成交接、compact 与暂停恢复

**Deps：** `T6`（消费其 Host 注册点；该产物已包含 T2 store 与 T4 runtime 的公开接口，不再重复声明传递依赖）。

**WritePaths：** `src/goal-runtime/continuity.ts`、`src/goal-runtime/index.ts`、`docs/architecture/goal-runtime-v1.md`、`pi/extensions/context-usage.ts`、`src/context-usage/snapshot.ts`、`src/context-usage/reminder.ts`、`docs/context-usage-handoff.md`、`test/context-usage.test.mjs`、`test/context-usage-extension.test.mjs`、`test/context-usage.integration.test.mjs`。

**Resources：** `none`。

**Files：** Create：`continuity.ts`；Delete：handoff 提醒消费者清零后的 `src/context-usage/reminder.ts`；Modify：其余所列文件。T6 与 T7 共享工具/生命周期注册点，T7 消费该成品后接续；只更新现有 context 测试的合同断言，不新增测试或 fixture。

**接口契约：** Consumes：当前 branch state、checkpoint、runtime.refreshRuns、Pi 1.4 生命周期和原 context usage 观测入口。Produces：`buildRecoveryContext(state)`、`reconcileGoalSession(ctx,runtime)`、`installGoalContinuity(pi,runtime)`；注册 §6 的 compact/context/session hooks 和 `/plan` 命令。`context_usage` 保留观测 schema，按 §6.1 去掉 handoff 专属字段/提醒；不依赖 Goal 才能查询使用量。

**终态关联：** F5、F6、F8、F9。

**验收标准：** 默认摘要不被替换；每次压缩后下一请求能恢复完整权威约束。保存失败返回 cancel；compact 失败不会遗留假恢复锁。paused/blocked 与 completed 不混用；活跃计划不能通过 fork/tree 回滚业务事实；switch/reload/shutdown 的旧回调不写新 session。无 Goal 时不创建 checkpoint 或请求 continuation；高占用不再要求 agent 写手工 handoff。

- [ ] 实现原始来源与决策 checkpoint 的持久化，恢复时注入目标/约束/未满足条件和当前合同；不再摘要权威字段。
- [ ] 安装 `session_before_compact/session_compact/session_compact_failed` 成对处理，覆盖 manual/threshold/overflow 及 willRetry；保存失败明确返回 `{cancel:true}`。session_start/reload 先 await store.restore 的磁盘核验，再核对状态与已知 run；同 Manager 内存含未落盘 Goal entry 时保持 blocked，只读诊断仍可用。
- [ ] 实现 pause/resume/cancel/status、用户 steer 暂停和 fork/tree 门禁；加入 `session_before_switch` 保存、`session_shutdown` 幂等失效及 session_start 重建。旧 session/generation 异步回调不得写入新 session；cancelled 但资源未闭合的实例不能被新计划覆盖。
- [ ] 按 §6.1 将 context usage 收敛为只读观测，去掉 handoff 策略/提醒及其 promptGuidelines，更新现有 schema/提醒断言与当前使用文档，消费者清零后删除 reminder 模块；保留历史 session 和 handoff 文件。
- [ ] 将契约漂移、unknown spawn/run、manual integration takeover 的恢复说明写进 architecture，说明哪些需要人工消除阻塞；不要求模型在压缩前写 handoff，不把集成接管通知误删。
- [ ] 运行 `npm run typecheck`、`node --test test/context-usage.test.mjs test/context-usage-extension.test.mjs test/context-usage.integration.test.mjs`；手工核对每个 hook 的 1.4 返回值，不以 throw 代替 cancel。

## Task T8：完成聚焦验证与交付证据

**Deps：** `T7`（消费已接好 T6 工具入口的恢复闭环；T6 由传递依赖保证）。

**WritePaths：** `docs/summaries/2026-10-26-goal-runtime-v1-verification.md`；以下三份仅在获具体授权后加入写范围：`test/goal-runtime-contract.test.mjs`、`test/goal-runtime-runtime.integration.mjs`、`test/goal-runtime-rpc.integration.mjs`。

**Resources：** `goal-runtime-acceptance` 独占 1；隔离 temporary repo/session/state/socket root；不碰用户现有 workspace。

**Files：** Create：验收报告；Suggested Test（待用户授权）：上述三份。不新增 pressure test、通用 helper 或新真实 provider fixture。

**接口契约：** Consumes：T1–T7 public 接口、现有 deterministic provider/RPC/temporary arena；Produces：逐项 F1–F9 的实证报告，保留 HEAD、contractHash、session/run/receipt 引用、命令结果、失败与未验证范围。

**终态关联：** F1–F9。

**验收标准：** 聚焦场景覆盖正常路径与关键失败出口；状态/文案不冒充 proof；无 skip 充数；新机制与旧 runtime 不互相污染。新增测试未获授权时，只做已授权检查与报告，并将缺少行为证据写成验证阻塞。

- [ ] **本地静态与既有回归：** 先审计副作用。运行 `npm run typecheck`、`node --test test/subagent-execution-contract.test.mjs test/subagent-auto-integration-plan.test.mjs test/context-usage.test.mjs test/context-usage-extension.test.mjs test/context-usage.integration.test.mjs`；package 元数据用 `node --test --test-name-pattern='publishable pinned package contract' test/pi-subagents-enhanced-package.test.mjs`。此层只能证明对应类型/局部合同，不记作 F1–F9 的真实 Host 门槛通过。
- [ ] 既有 workspace/Auto Integration 回归选用 `test/managed-workspace-contract.test.mjs`、`test/managed-workspace-terminal-proof-handoff.integration.mjs`、`test/subagent-auto-integration-lifecycle.integration.mjs`、`test/subagent-auto-integration-recovery.integration.mjs`。每套执行前审计临时资源与 cleanup 行为，不运行真实 5-child probe 代替聚焦检查。
- [ ] **网络 package 闭包：** `npm run verify:subagents-enhanced` 会 npm pack、访问官方 registry 和临时 npm 目录；与本地静态检查分别报告，仅在适用授权和网络满足时运行。未运行不能宣称发布闭包通过，不以此替代 Host 行为验证。
- [ ] 建议（待用户授权）：在三份新测试中覆盖公开入口的契约拒绝/幂等激活、DAG 并发与资源容量、官方 proof+集成接受、旧证据/伪造通过拒绝、失败修复闭环、验证前 child 失败且没有 check 回执时的合法 retry、重复通知/新 run resume、unknown/manual-integration 阻塞、两次 compact+reload+同 session 重启、底层 append 写盘失败但 Manager 已插入内存 entry 后的 reload/restart 差异、switch/shutdown 旧回调隔离、暂停/队列优先、契约漂移、无进展和默认关闭。写盘失败场景不能只用“未改内存就抛错”的 mock。F9 复用已有 context/RPC 场景，不新增第四份测试。
- [ ] **真实 Host 生命周期：** 获新增行为验证授权后，优先复用现有 deterministic provider 驱动真实 Host/RPC。fake 模型仅提供可控响应；spawn、proof、workspace、Auto Integration、证据 entry、compact 和恢复仍走真实实现。覆盖 checkpoint append 失败取消压缩、compact 成功/失败、manual/threshold/overflow、两次 compact、reload/restart、用户队列与 switch/shutdown，不能 mock 出“已成功”代替集成证据。
- [ ] 建议（待用户授权）：首次启用前做一次真实 provider 的两任务 smoke，包含一次失败检查后的修复和一次 compact。与修复派发分开，失败保留现场、记录首次偏离点，不边跑边改、不自动重跑。该 smoke 不扩成旧 R13 两轮全矩阵。
- [ ] 组合场景补充（仍待新增行为验证授权）：共用容量1资源时任务检查失败→释放计划占用→本任务可重修；错误修复依赖在解码时拒绝；验证前无check失败明确retry；terminal先到但proof/integration/release后完成仍能唤醒；正常空session未建文件仍可首次execute；报告冻结→最终验证→仅session完成能收敛。复用三份建议文件，不增加新测试框架。
- [ ] 对照 F1–F9 记录通过、失败、过期或未执行；失败继续 fix→test，真实阻塞报告。用户没有授权的成果 review 不自动派发；不手工 commit/push、不修改默认启用状态；受管 coding workspace 的 runtime 必需 publication 仍按既有 Auto Integration 规则处理。

## 7. 实施与验收记录规则

- 本文 checkbox 只记录任务步骤；F1–F9 的证据表决定计划执行是否完成。
- 实现发现能力缺口，先判断能否用既有 public API 或小适配解决；不能借机恢复旧 Goal Engine 的全套抽象。
- 发现异常先记录来源、首个偏离点和完整调用链，区分生产可达、测试制造和来源未证实；不能因 fixture 异常添加 production fallback。
- 每轮以 Goal checkpoint 记录当前 HEAD/diff、已交付任务、未满足终态、真实 run/workspace 引用和下一动作；长材料保留来源引用，不再维护压缩阈值触发的手工 handoff 文件。
- 只有完整通过后才能建议启用；默认关闭、未获授权的测试或未完成的 smoke 均按实际状态说明。

## 8. 1.4.0 审阅处置与计划状态

本节记录计划修订，不表示 T1–T8 已执行或 F1–F9 已通过。

- 已完成用户明确要求的独立 Pi 1.4.0 只读审阅；本版由主会话修订，不自动追加新一轮 reviewer。后续复审仍需用户逐轮授权。
- 采纳：版本/HEAD rebaseline、自有配置来源、真实 ExtensionToolContext/executeTool/appendEntry 合同、resume/manual integration 边界、switch/shutdown 及分层验收。
- 澄清：`./execution` 缺失是明确待实现交付物，不单独作为设计否决理由；低层 worktree:false 是复用已分配 workspace 的正确行为；v1 仍派 standalone coding child，无需扩大 Goal owner service 或引入旧 Goal tickets。
- 按用户最新范围加入 F9/T7：保留 context usage 观测，退役接近压缩时的手工 handoff；非 Goal 会话使用 Pi 默认摘要，集成失败的人工接管通知保留。
- 计划自检实际通过：8 项任务完整字段、DAG 无环、F1–F9 终态表、Markdown fence/占位/空白检查，以及两段 TypeScript 接口声明经当前 `tsc` 静态类型检查。临时声明文件已清理，未新增测试。TypeScript 7 在仓库有 tsconfig 时显式指定文件必须带 `--ignoreConfig`，已根据实测 TS5112 修正 T1/T2/T4/T5 命令；全项目检查仍用 `-p`。
- 这些检查只验证计划结构与接口声明；真实 Host/RPC、compact/reload/restart 与 package closure 尚未执行，必须在 T8 取证。当前没有创建 Goal runtime、切换配置或新增测试。
- 首轮最终结论为“修订后可执行”，原文保存于 `docs/reviews/2026-10-27-goal-runtime-v1-review-1.md`。主会话已补齐两项 High：无 check 回执的失败 attempt 恢复准入；branch 可见与 session 文件已写入事实的区分。接口、T2/T4/T6/T7 和 T8 矩阵同步调整，仍只保留五工具与同一 session 存储。
- 二审已完成，原文 `docs/reviews/2026-10-27-goal-runtime-v1-review-2.md`，结论为“修订后闭环”。主会话已补齐：check 失败释放计划占用与本任务修复可达性、无 check 失败的明确 retry/异步最终事实唤醒、resume 前后置证明分开、正常新空 session 分支；并固定报告冻结收尾、无进展采样及增量磁盘确认，保持八任务/五工具/同一 session 存储。
- 本轮修订没有自动派发第三审，也没有启动 Goal 实现。
- 当前修订版尚未取得执行方式选择；新增测试/fixture/真实 provider smoke 仍待具体授权。未选择执行方式前不启动本计划实现。

下一步由用户选择 Subagent-Driven / Inline 开发方式，或授权额外一轮计划复审。这里的 Inline 是开发本 feature 的执行方式，不是 v1 产品支持 Inline plan。
