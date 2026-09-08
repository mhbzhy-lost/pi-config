# Goal Engine R13 fresh Host 验证摘要（2026-09-08）

## 当前结论

**BLOCKED：1-task 真实 RPC binding smoke 仅执行一次即失败；按任务合同及 supervisor 决定，不调试性重跑、不修改 parser，R13 两轮真实三任务 canary 未执行，仍为 Manual Preview。** 未执行 cutover、`git add`、commit、reset、restore、stash 或 raw worktree 操作。

## restart authority TDD

- RED：旧 fixture 仅以 `observeStarted()` 建立 facade record，手写 `status.json/processTerminal`；未注册 `RunAuthorization`，没有 `root-broker.goal-run-binding-authority.v2.json`。重启后 `ownedRuns/goalAuthorities` 为空，`stopGoalOwnedRun()` 正确返回 `OWNED_STOP_IDENTITY_UNKNOWN`。
- GREEN：canary 现通过公开 `createRunAuthorization()` 创建 deep-frozen coding Goal authorization，调用 `registerAuthorizedRun()`、`observeStarted()` 与 `persistGoalBindingAuthority()`。`process-terminal.json` 使用与 upstream `writeAtomicJson` 相同的同目录 atomic write 形状，且只含 official observed failed terminal 字段。
- 重建 Broker 后重新经公开 Host registration 建立 live authorization，`persistGoalBindingAuthority()` 安全重读持久 sidecar；`inspectExecutorProofAsync()` 读取 official terminal，报告 `terminal.outcome === "failed"`。随后 production `stopOwnedRun()` 返回 `observed` 且 runner `exitCode === 1`。
- 独立未注册负例仍断言 `{state:"attention",code:"OWNED_STOP_IDENTITY_UNKNOWN"}`；failed outcome 不会绕过 identity/authority。

## setup 前置与 production entry / 模型门禁

已运行 `npm run setup:subagents-enhanced`：package-local `pi-subagents/node-runtime/index.js` 已生成，且 `node-runtime/src/runs/background/subagent-runner.js` 等 canonical runner JS 已生成；随后 `npm --prefix packages/pi-subagents-enhanced run verify:package` 通过。只生成 ignored `node_modules` artifacts，未手工 copy/symlink。

fresh 临时 Git cwd 和独立 agent/session 同时加载当前 checkout `pi/extensions/goal-engine.ts` 与 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`，没有旧 `.mjs` import 或 final-review stub。临时 settings 显式为 `openai-codex/gpt-5.6-luna`、`timeoutMs=600000`；安全 `ModelRuntime` catalog probe 已确认该精确 provider/model 可用，未读取/打印凭据且未执行 auth 命令。该入口注册 exact-eight；启动前 typed workspace inventory 为零。

## 本次 1-task actual binding smoke（BLOCKED，不重跑）

执行：`node --test --test-name-pattern='真实 Pi RPC root model 完成一任务 Goal dispatch 到 typed subagent binding' test/goal-runtime-real-canary.integration.mjs`。单次运行耗时 25.7 秒并失败，测试临时目录为 `/private/var/folders/54/qnwh6cc92251456c0j780vvc0000gn/T/goal-runtime-rpc-smoke-h3gymu`（finally 已删除）。

失败发生在全部四个真实 tool 事件及其成功结果断言之后：`goal_init`、`goal_status`、`goal_dispatch`、`subagent` 都已存在 start/end，且 end 非 error；`goal_init` content JSON 给出 goalId `r13-one-task-typed-subagent-bind-smoke`，dispatch public content 已通过 `dispatch-ir.v1`、`taskId === <goalId>.rpc-smoke` 和 64 位 contract hash 断言；subagent ToolResult **仅从 exact `result.details`** 读取的 `runId`、`asyncDir` 均已通过 string 断言。因此这一次真实 root model 已完成 dispatch 与 typed subagent binding；没有 facade conflict 断言失败。

随后测试以旧假设路径读取 `<temporary-cwd>/.state/goal-engine/goals/<goalId>/events.jsonl`，报 `ENOENT`。故没有可保存的 ledger executorBinding 比对，也不能宣称 criterion-1 通过；当前 finally 会删除 temp origin/agent/session，故精确 `runId`/`asyncDir` 值不再可取，未伪造或补录。

环境/根路径记录：RPC 使用 fresh temporary cwd、agent/session/workspace dirs、`openai-codex/gpt-5.6-luna`，wrapper 的临时 settings 含 production runtimeHost 与 finalReview 配置。`sanitizedRpcEnvironment()` 仅删除 `PI_SUBAGENT_*`，**不删除 `PI_CODING_GOAL_DIR`**。production `executionScopeFor()` 先取 `ExtensionContext.cwd`，再调用 `resolveGoalStateScope({cwd, env: process.env})` 和 `selectGoalStateRoot()`；后者在未设置 `PI_CODING_GOAL_DIR` 时选择上述 legacy `.state/goal-engine`，设置时则选择 `${PI_CODING_GOAL_DIR}/${cwdNamespace}`。因此当前只读错误假设是：继承的 `PI_CODING_GOAL_DIR` 令真实 Goal ledger 写入全局 namespaced root，而 canary hard-coded legacy origin root。此为待后续独立任务确定性修正的 locator 假设，不在本任务探索其他路径、修改 parser 或重跑。

尚未执行两轮各自独立的 3-task DAG、failed/blocked→resource disposition→amend/resolve/retry、settle/integrate/accept、真实 RPC user approval、production final review、资源 audit 或 T8 快速回归；不得声明 R13 GREEN、provider 结果或资源无债务。

## 快速复核

| 命令 | 结果 |
|---|---|
| `node --test test/goal-runtime-real-canary.integration.mjs` | PASS：3/3（production entry、restart failed proof、unregistered negative） |
| `npm run typecheck` | PASS |
| `npm --prefix packages/pi-subagents-enhanced run verify:package` | PASS |
| `npm run doctor` | PASS（历史 warnings，只分类） |
| `git diff --check && git diff --cached --check` | PASS |

## 资源与 index

- restart/entry fixtures 各自的 temporary cwd/asyncDir/agentDir 在 finally 中删除；entry fixture typed inventory 为零 workspace/zero orphan registration。
- Doctor 的约 154 条 `MANAGED_WORKSPACE_ORPHAN_REGISTRATION` 与 3 条 legacy warnings 属于历史资源；未清理。
- `git diff --cached --name-only | wc -l` 为 **12**，故 `noStagedFiles=false`；未改 index。
