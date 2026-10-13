# 异步 Bash 工具实现计划

> **执行记录：** 用户已选择 Inline；T1–T6 的 Bash 专属实现与验收完成，尚未提交。全仓回归存在4项HEAD可复现失败和一次独立重跑通过的broker超时，不能称为全仓GREEN。本计划不包含 scheduler、Playwright、Exa 或其他运行时任务。

**目标：** 新增 `bash_async`，复用 Pi 原生 `createBashToolDefinition(...).execute()` 的命令执行、cwd、shell、超时、输出截断和进程树清理语义；工具调用立即返回 launch receipt，命令完成后将 terminal receipt 通过单一 Host custom-message 出口送入当前会话队列并触发后续 turn。

**架构：** `src/bash-async/` 持有 session-scoped job controller 和公开入口；`src/bash-cwd/` 提供同步 Bash 与异步 Bash 共用的 cwd-aware definition factory；Pi extension 只做 Host API 绑定、工具注册、生命周期和 security-gates 接线。异步 controller 在 launch 时快照 session/generation/branch 与原生 Bash options，后台只 await 原生公开 definition 的 `execute`，不复制 shell spawn、输出截断、超时或 kill tree；完成只从 controller 的单一 terminal transition 发送一个 `bash-async-complete` custom message。

**技术栈：** Node `>=22.19.0`、原生 TypeScript、Pi public Extension API、Node `node:test`、现有根 `tsc --noEmit`。不引入 MCP、daemon、持久 job ledger、subagent 内部模块或新的第三方依赖。

## 全局约束

- 最低 Node `>=22.19.0`；production/CLI 代码使用 `.ts`；新增 TypeScript 必须纳入 `tsc --noEmit`。
- 必须复用 Pi 官方公开 `createBashToolDefinition`/`ToolDefinition.execute`；不得 deep import Pi `dist/**`、`packages/**/node_modules/**`、subagent internal background/completion 模块或复制原生 Bash 实现。
- `bash_async` 必须经过与 `bash` 相同的 `security-gates` shell policy；新增工具名不能绕过敏感命令、cwd、trust、Git/worktree 和 shell policy 门禁。
- 异步工具不是 read-only，不提供沙箱；命令拥有 Pi 进程的 OS 权限，文档必须明确。
- 不通过 `&`、`nohup`、`setsid`、自建 daemon 或独立 Pi 子会话实现异步；用户命令自行逃逸出的进程不承诺可清理。
- launch receipt 只表示“已接受/已开始后台调度”，不能表示已成功 spawn、命令成功或已完成；terminal receipt 必须区分 success、non-zero、timeout、aborted、spawn/error。
- 原生 Bash 的 stdout/stderr 顺序、末尾 2000 行/50KiB 正文、完整输出文件、1MiB structured output、空输出和 `isError` 语义必须保留；异步层不为 TUI 截断或改写 agent 原始结果。
- completion 只从一个 terminal transition 发送一次；不能同时走 `sendMessage`、`sendUserMessage`、scheduler、async-progress 或 subagent 通知通道。
- 常规存活、同 session/generation/branch 且未被清队列时，承诺最多一次 completion；不承诺进程崩溃、clear queue、退出、跨 branch 或 reload 后 durable exactly-once。不得伪造 ACK 或声明已入队成功。
- print/json one-shot 模式执行前拒绝 `bash_async`，原生executor零调用；支持长生命周期TUI/RPC，不后台悬挂进程以伪造持久化能力。
- 不读取 credentials/settings/models/真实 session，不提交 commit；不触碰已有 scheduler dirty files。

## 文件结构与职责

| 文件 | 职责 |
|---|---|
| `src/bash-async/contracts.ts` | feature public 类型、receipt、outcome、controller 接口 |
| `src/bash-async/index.ts` | feature public entry：controller factory、tool definition、生命周期接口 |
| `src/bash-async/controller.ts` | session-scoped job map、generation/branch guard、AbortController、single terminal transition、completion delivery |
| `src/bash-cwd/index.ts` | 新增公开 cwd-aware Bash definition factory；同步 Bash 和 async Bash 共用 |
| `src/bash-cwd/extension.ts` | 只做现有实现的最小导出重构，保持原同步 Bash 行为 |
| `pi/extensions/bash-cwd.ts` | 绑定 Host API、注册 `bash`/`bash_async`、生命周期注册；不承载 job 实现 |
| `src/security-gates/extension.ts` | 将 shell gate 的精确匹配范围从 `bash` 扩为 `bash` 与 `bash_async`，规则逻辑不复制 |
| `tsconfig.json` | 精确纳入 `src/bash-async/**/*.ts` 与新增公开入口 |
| `test/bash-async.test.mjs` | schema、receipt、controller、single-send、错误与同步 Bash 回归契约 |
| `test/bash-async-runtime.integration.mjs` | Host-backed session、busy/idle、compaction/tree/switch/reload/shutdown、真实短 fixture 命令 |
| `test/bash-cwd-extension.test.mjs` | cwd-aware factory 重构后的既有同步回归 |
| `test/security-gates-extension.test.mjs` | `bash_async` 与 `bash` 共享 gate 的零 spawn 证据 |
| `docs/architecture/bash-async.md` | 工具契约、使用场景、生命周期、失败/丢回执边界；不写凭据或默认 shell 命令 |

## 公开接口合同

```ts
export type BashAsyncRequest = {
  command: string;
  timeout?: number;
  cwd?: string;
};

export type BashAsyncLaunchReceipt = {
  kind: 'bash-async-launch';
  jobId: string;
  toolCallId: string;
  sessionId: string;
  generation: number;
  branchEpoch: number;
  command: string;
  cwd: string;
  acceptedAt: string;
};

export type BashAsyncTerminalReceipt = {
  kind: 'bash-async-complete';
  jobId: string;
  toolCallId: string;
  sessionId: string;
  generation: number;
  branchEpoch: number;
  outcome: 'succeeded' | 'failed' | 'timed-out' | 'aborted' | 'spawn-error' | 'execution-error';
  exitCode?: number;
  signal?: string;
  elapsedMs: number;
  output: unknown; // 原生 Bash result 的原始 content/details/structuredContent 投影，不做展示截断
  completionDelivery: 'attempted' | 'accepted' | 'suppressed-stale' | 'suppressed-shutdown' | 'suppressed-unsafe-context' | 'delivery-error';
};

export type BashAsyncController = {
  launch(toolCallId: string, request: BashAsyncRequest, context: ExtensionToolContext, signal?: AbortSignal): Promise<BashAsyncLaunchReceipt>;
  cancel(jobId: string): Promise<{ jobId: string; accepted: boolean }>;
  start(sessionId: string): Promise<void>;
  cancelAll(): Promise<void>;
  invalidateBranch(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  snapshot(): { active: BashAsyncLaunchReceipt[]; completed: BashAsyncTerminalReceipt[] };
};
```

- `jobId` 是 feature 内部关联 ID，不是 PID；PID 不输出。
- `command` 与输出沿用已授权原生Bash语义，不额外写入普通日志或为了TUI改写。必须避免credential-bearing命令和敏感stdout；新工具不承诺自动识别/脱敏任意输出。native raw result只在terminal custom message及有界会话内诊断快照保存。
- `completionDelivery: accepted` 只代表 `pi.sendMessage` 同步调用未抛异常，**不代表 Host 已消费/持久化**；这必须写入文档和测试语义。
- 默认 terminal custom message 使用 `deliverAs: 'followUp', triggerTurn: true`；不调用 `sendUserMessage`，不伪造用户输入。
- tool result 只返回 launch receipt；terminal completion 不是第二个 `tool_result`，不能假称它经过原始工具生命周期的 afterToolCall。
- 一个 job 只有一次 terminal transition。非零退出是 `failed`，原生 timeout/abort 抛错分别归类；不能把所有异常改成 exit code 1。
- completion 不自建 pending/retry 队列：一次 terminal transition 直接调用 Host `sendMessage`，由 Host 自己处理 streaming/followUp 路由。调用未抛异常只能记为 `accepted`，不代表消费 ACK；调用失败记为 `delivery-error`，不自动重发。
- 不宣称 controller 能观察 Host `clear_queue` 或 tree/compaction 的内部队列；已经交给 Host 的 completion 可能被 clear queue 清掉。Host crash、session exit、branch replacement、reload 后可能丢失；不持久化重放。
- 发送前只检查 controller 自己的 session/generation/branch/shutdown guard和公开ctx的活跃状态；不依赖不存在的 tree-success/clear-queue 事件。状态不明时 suppress，不自行等待或轮询。
- tree开始前保守取消旧jobs、前移branchEpoch，即使其他handler拒绝tree也不恢复旧job；但不永久暂停新launch。独立compaction（无活跃turn signal）开始同样保守取消，普通active run自动compaction由Host路由。被拒switch/fork不取消；成功replacement通过session_shutdown取消旧代。
- custom message content是独立metadata前缀加原生content blocks；details保存完整native result/error，不为展示改写。async launch不继承native outputSchema/renderResult，后台不调用launch的onUpdate。

## DAG

```text
T1（Bash公开API/生命周期事实） ──> T2（contracts与单元harness） ──┬──> T3（cwd factory与async tool实现） ──┐
                                                                  └──> T4（Host-backed集成fixture） ──────┴──> T5（Host/security接线） ──> T6（最终验收）
```

依赖理由：T1 固定可使用的 public API 与 Host 生命周期事实；T2 产出 contracts 和 fake executor；T3/T4 消费同一合同且写入不同文件，分别实现 production 与 Host-backed fixture；T5 等待实现和集成 fixture 后接线；T6 只在所有接线完成后验收。T4 的完整 security/lifecycle 验收由 T5/T6 完成，不在 T4 之前宣称通过。没有真实 scheduler/Playwright 依赖。

## Waves

- Wave 1：T1（公开 API、原生 Bash、Host 生命周期核对）
- Wave 2：T2（contracts 与 fake executor）
- Wave 3：T3、T4（production 实现与 Host-backed fixture 可并行，WritePaths 不重叠）
- Wave 4：T5（extension/security-gates 接线）
- Wave 5：T6（最终回归、Host 行为验收和文档一致性）

**关键路径：** T1 → T2 → T3 → T5 → T6；T4 是并行支线，必须在 T5/T6 前完成。

---

### Task 1：冻结原生 Bash 与 Host 生命周期契约

**Deps：** `none`

**WritePaths：** none（只读调查，不修改仓库）

**Resources：** 只读本地已安装 Pi package docs/types/source；不访问 settings/models/凭据，不启动长命令。

**Files：** Read Pi public docs/types、`src/bash-cwd/**`、`src/security-gates/**`、`src/async-progress/**`、相关测试；输出任务输入事实。

**接口契约：**
- Consumes：公开 `createBashToolDefinition`、`ToolDefinition.execute`、`ExtensionToolContext`、`pi.sendMessage`、lifecycle hooks。
- Produces：T2 使用的原生 result/error/abort/timeout/cwd/schema、Host message routing 和 stale generation contract。

**验收标准：**
- [x] 已确认原生 execute 可被外层 await，但直接 await 会阻塞 Host；只能由外层 controller 持 Promise 后立即返回。
- [x] 已确认原生使用 AbortSignal、detached process group、kill tree、输出 tail/structured/full-output 语义；异步层不复制这些实现。
- [x] 已确认 `bash_async` 必须进入 security-gates；只匹配 `bash` 会绕过门禁。
- [x] 已确认 `sendMessage` 无消费 ACK；计划不承诺 durable exactly-once。

---

### Task 2：定义 job/receipt/controller 与测试隔离合同

**Deps：** `T1`（理由：消费原生执行与 Host routing 事实）

**WritePaths：**
- `src/bash-async/contracts.ts`
- `test/bash-async.test.mjs`

**Resources：** fake Bash definition、in-memory custom-message sink、隔离 temp cwd；不启动真实长命令。

**Files：**
- Create：`src/bash-async/contracts.ts`、`test/bash-async.test.mjs`
- Test：fake native result fixtures 覆盖 success/non-zero/timeout/abort/spawn-error、原生截断/details/structuredContent

**接口契约：**
- Consumes：Task 1 原生 `ToolDefinition.execute` 与 delivery/lifecycle contract。
- Produces：`BashAsyncRequest`、launch/terminal receipt、`BashAsyncController` 签名、fake native result fixtures 和 single terminal transition 的测试合同。`launch` 必须显式接收本次 `ToolDefinition.execute` 的 `toolCallId` 与 `AbortSignal`，不能从 `ExtensionToolContext` 猜测。

**验收标准：**
- [x] launch 在 fake execute 尚未结束时立即返回 `bash-async-launch`；测试用独立 promise 证明调用方可继续执行后续事件。
- [x] 终态只允许一次；重复 settle、重复 abort、late native result 不重复发送 completion。
- [x] 结果完整保留原生 content/details/structuredContent 语义；不把 timeout/abort/spawn exception 改写成虚假 exit code。
- [x] sessionId/generation/branchEpoch 不匹配时抑制 terminal delivery，并保留 suppressed reason；同代同分支只调用一次 `sendMessage`。
- [x] delivery throw/关闭状态可观察，不伪造 `accepted`；clear queue 只记录为 Host 侧可能清除，不声称 controller 可观察；不实现持久重放。
- [x] `cancel(jobId)` 只 abort 该 job 的 controller；未知 job、已终态和其他 session 不影响现有 job。
- [x] 所有测试只使用 fake executor/sink，不调用真实 Bash、scheduler、MCP、settings 或凭据。

---

### Task 3：实现 cwd-aware 原生 Bash 复用与异步工具定义

**Deps：** `T2`（理由：消费 controller/receipt contract）

**WritePaths：**
- `src/bash-cwd/index.ts`
- `src/bash-cwd/extension.ts`
- `src/bash-async/index.ts`
- `src/bash-async/controller.ts`

**Resources：** 隔离临时 cwd；只允许短、无网络、无凭据 fixture 命令。

**Files：**
- Create：`src/bash-cwd/index.ts`
- Modify：`src/bash-cwd/extension.ts`，导出同步/异步共用的 cwd-aware definition factory，保持同步 `bash` 行为不变
- Modify：`src/bash-async/**`，调用 public Bash definition execute

**接口契约：**
- Consumes：`BashToolOptions`、cwd policy、Task 2 controller。
- Produces：`createBashCwdToolDefinition(options)`与`prepareBashCwdExecution(options, {cwd}, ctx, transformOptions)`公开入口；同步Bash保留原definition，async复用prepare后的native execute。`bash_async` schema保持原生command/timeout加cwd；controller launch明确传本次toolCallId/signal。

**验收标准：**
- [x] 不复制 shell spawn、输出 accumulator、timeout、kill tree 或 commandPrefix 逻辑；同步 bash 现有测试保持通过。
- [x] launch 时一次性解析/校验 cwd、shell options、trust 和环境快照；后台不重新读取 session/settings。
- [ ] 不用 `&`/nohup/daemon；原生 AbortSignal 负责 timeout/cancel；command 自行逃逸进程不作清理保证。
- [ ] launch receipt 不包含 PID、不声称 spawn/command 成功；terminal receipt 保留原生结果事实。
- [x] 不调用 `ctx.executeTool('bash')` 作为 detach 实现，不产生 nested-call 半残记录。
- [x] `bash_async` 工具注册在完整 Host pipeline 中，原生 `bash` 的 schema/行为/工具名不改变。

---

### Task 4：建立测试 fixture 与 Host-backed 集成验证

**Deps：** `T2`（理由：消费 contracts 与 fake executor；完整 Host/security 验收留到 T5/T6）

**WritePaths：**
- `test/bash-async-runtime.integration.mjs`

**Resources：** 一个隔离临时 cwd、短 fixture child process、in-memory SessionManager/fake provider；禁止真实长构建、真实网络、真实 credentials。

**Files：**
- Create：`test/bash-async-runtime.integration.mjs`

**接口契约：**
- Consumes：Task 2 controller contract 与 Task 1 Host lifecycle facts。
- Produces：隔离的 Host-backed fixture，验证 launch/terminal 时序和 lifecycle 输入；不在 T4 单独判定尚未接线的 security gate 或全部 Host lifecycle 已通过。

**验收标准：**
- [x] launch receipt 在短 fixture 未完成时返回，主测试可执行独立事件，terminal custom message 最终只出现一次。
- [x] 覆盖 success/empty output/nonzero/timeout/abort/非法 timeout/null exit code/输出文件故障/超出50KiB或2000行/structured output边界，并保留原生语义；新增 `execution-error`，不把非 spawn 异常归类为 spawn-error。
- [ ] 覆盖 launch 时 cwd/prefix/trust 事实快照；security gate 的零 spawn 断言由 T5/T6 接线后完成，不在 T4 预先宣称通过。
- [ ] 覆盖 busy/idle 和快速完成早于 tool result；普通 streaming 只验证一次 Host `sendMessage` 调用，由 Host 自己路由 followUp。
- [ ] 对 compaction/tree/clear_queue 只验证 controller 的 stale/shutdown guard 和“不自建重试”；不假设公开 API 能观察 Host 内部清队列或 tree 被拒事件。
- [x] 覆盖 reload/switch/fork/session replacement/quit 的 controller shutdown 输入：旧 job 取消或 suppress completion，不唤醒新 session/新 branch；区分成功 replacement 与被拒切换的输入。
- [x] 真实Host测试 `clear_queue`清掉已提交followUp后无自动重发；print/json原生零启动，不悬挂daemon。
- [ ] 全部使用隔离 Host/cwd/fake process，不触碰用户 session/settings/models/凭据，不调用网络。

---

### Task 5：Host 注册与 security-gates 接线

**Deps：** `T3`、`T4`（理由：实现和测试已固定）

**WritePaths：**
- `pi/extensions/bash-cwd.ts`
- `src/security-gates/extension.ts`
- `tsconfig.json`
- `test/bash-cwd-extension.test.mjs`
- `test/security-gates-extension.test.mjs`
- `docs/architecture/bash-async.md`

**Resources：** none

**Files：**
- Modify：Host extension，注册 `bash_async` 与 lifecycle cleanup；同步 `bash` 注册保持原样
- Modify：security gate，精确把 `bash_async` 加入与 `bash` 相同的 shell policy 分支，不复制策略
- Modify：tsconfig，纳入 `src/bash-async/**/*.ts` 与新 public entry
- Create：架构/使用文档和回归断言

**接口契约：**
- Consumes：Task 3 public feature entry、Task 4 lifecycle tests。
- Produces：可发现的 `bash_async` model-only tool、`/bash-async-cancel <jobId|all>`（使用controller API）和一致security gate。

**验收标准：**
- [ ] 工具说明明确场景：测试套件、类型检查、产物构建、包含网络请求的长耗时操作；同步 bash 用于需要立即消费结果的短命令。
- [ ] 明确后台执行不隔离、不继承 completion durable guarantee；成功必须看 terminal receipt 的 outcome/exitCode。
- [x] 默认支持 TUI/RPC 长生命周期；print/json 执行前拒绝，不提供虚假持久后台。
- [ ] Host reload/shutdown 注册幂等，关闭时先禁止 delivery、abort job、等待原生 promise 收束并清理 listener/map。
- [ ] security-gates 对 `bash_async` 与 `bash` 使用同一 shell policy；测试证明 deny 时 native execute 未调用。
- [x] 不加入 `async-progress`、`session-owner`、subagent background provider 或 MCP；不修改 `scripts/` 和 `scripts/lib/`。

---

### Task 6：最终专项回归与静态审计

**Deps：** `T5`（理由：所有实现、接线、文档和集成测试完成）

**WritePaths：** none（验收任务只读；报告如需生成，写入由验收 harness 创建的私有临时路径，不纳入仓库）

**Resources：** 无真实网络/凭据/用户 session；短临时 fixture。

**Files：** Read all changed paths; output a temporary acceptance report.

**验收标准：**
- [x] `npm run typecheck:root`
- [x] `node --test test/bash-cwd-policy.test.mjs test/bash-cwd-extension.test.mjs test/security-gates-extension.test.mjs test/bash-async.test.mjs`
- [x] `node --test test/bash-async-runtime.integration.mjs`
- [x] `git diff --check`
- [ ] `rg` 审计不存在 MCP/deep import/subagent internal/daemon/`&`异步实现；原生 bash shell policy 仍唯一门禁。
- [x] 证明普通 `bash` 行为无回归、`bash_async` launch 不阻塞、terminal completion 单出口/单次、已知 clear_queue/crash/one-shot 边界没有被错误描述成可靠持久队列。
- [ ] 若任何测试显示 completion 在 source/branch/generation 不明时仍发送，判失败并停止，不增加盲目重试或 fallback。

## 使用场景与明确限制

推荐使用 `bash_async`：

- 测试套件和长时间类型检查；
- 产物构建、打包和生成；
- 包含网络请求的长耗时命令；
- 允许主会话继续读代码、做无冲突调查的独立任务。

继续使用同步 `bash`：

- 需要立即读取结果的短命令；
- 后续命令依赖当前输出的操作；
- 需要严格按当前 tool call 生命周期完成的命令。

限制：异步不等于 sandbox、不等于独立 durable worker、不等于跨 session 持久；同一 cwd 的并发写入仍由调用者负责；命令中自行 detach 的子进程不保证清理；网络请求可能继续产生副作用；terminal receipt 可能因 clear queue、崩溃或 Host 退出而丢失。

## 执行验收记录

- [x] Bash 专项类型检查通过。
- [x] Bash/cwd/security/async 单元与 Host 集成共 **46/46** 通过；真实 Host 集成 **12/12** 通过。
- [x] `git diff --check` 通过；静态审计未发现 MCP、deep import、subagent internal、daemon 或 shell `&` 异步实现。
- [x] 已验证同步 bash 既有 cwd/renderer 行为未回归；bash_async 与 bash 共用 security gate。
- [ ] 全仓 `npm test` 未全通过：当前4项已知 HEAD 基线失败；root broker 在全套运行中曾超时，但精确重跑通过。无关失败未修复，不能宣称全仓 GREEN。
- [x] 变更尚未提交；当前工作区另有 scheduler dirty 文件，未在本计划中修改。

## 计划自检

- 规格覆盖：已覆盖原生 Bash 复用、立即返回、完成回执入队、测试/构建/网络场景、security gate、cwd、输出/错误/超时/取消、busy/idle、branch/reload/shutdown、print/json、清队列和不丢保证边界。
- 不重复实现：计划不复制 Pi shell spawn、输出 accumulator、kill tree、MCP 或 subagent completion 内部。
- 类型一致性：`BashAsyncRequest`、receipt、controller 与 Host registration 的签名在 Task 2–5 中一致；`createBashCwdToolDefinition` 是同步/异步共享入口。
- DAG 审核：T1→T2→(T3、T4)→T5→T6；T3/T4 写路径不重叠，T4 的完整 Host/security 断言只在 T5/T6 之后验收；既有 scheduler dirty 文件不在任何任务中。
- 安全审计：新增 tool 名、cwd、环境、custom completion、cancel 和 lifecycle 均有对应任务与验收，不把 `sendMessage` void 当 ACK，不把 TUI 摘要当 raw payload。
