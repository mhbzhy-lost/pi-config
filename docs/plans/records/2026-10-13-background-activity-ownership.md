# 单Host事件与闭包生命周期合同（F0 静态记录）

**性质：** 统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md` F0 与 footer 子计划 P0 的静态证据记录与实现合同。本文只做静态阅读 + 记录：不改代码、不启动真实 Host、不运行测试、不读 settings/auth/credential/真实 session 正文/authority/state 正文。实现归 F2b（subagent activity provider），发现接线归 F6。

**taskId:** F0（dispatch-1980f490）　**status:** verified（静态事实；真实事件序列 fixture 验证归 F2b，见 §10）
**resources:** static-evidence（无 unit-runner / 无真实 Host / 无网络）

---

## 证据来源（本仓锁定版本现场读取，行号为 2026-10-13 现场行号）

| 文件 | 说明 |
| --- | --- |
| `node_modules/@earendil-works/pi-coding-agent/docs/{extensions.md,tui.md,rpc-extension-ui.md}` | SDK 公开文档（全文已读） |
| `node_modules/@earendil-works/pi-coding-agent/docs/{configuration.md,environment-variables.md}` | 目录约定与 `PI_CODING_AGENT_DIR` 语义 |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js` | 扩展发现/加载、`pi.events` 包装、runtime invalidate |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js` | ExtensionRunner.invalidate |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` | reload / dispose / session_start-shutdown 事实 |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` | `getSessionId()` / `getSessionFile()` |
| `node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-H33F2TZD.js` | DefaultResourceLoader / DefaultPackageManager 发现与 noExtensions 边界（bundle 内源码） |
| `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/...` | 上游 pi-subagents 0.75.0 事件 emit 与投递所有权源码 |
| `packages/pi-subagents-enhanced/extensions/custom-footer.ts` | 实际 footer 订阅与闭包 token |
| `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` | entry 的 `resolveSessionId` / `lifecycleSessionId` 接线 |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/{extension.ts,runtime-membrane.ts}` | membrane 诊断身份、`lifecycleSessionIdentity` |
| `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts` | enhanced 侧 `readSessionIdentity` / `resolveCurrentSessionId` |
| `packages/pi-subagents-enhanced/src/tui/session-browser.ts` | browser roster 字段与 started/complete 接受逻辑 |

---

## 1. 事件通道与发出点（bus 事实）

| 事实 | 证据 |
| --- | --- |
| 事件通道常量：`subagent:async-started` / `subagent:async-complete` / `subagent:foreground-complete` | 上游 `src/shared/types.js:11,12,14` |
| `pi.events.on(channel, handler)` 返回 unsubscribe，且被 runtime 追踪；`pi.events.emit(channel, data)` 直通 `eventBus.emit` | loader.js:417-428 |
| runtime invalidate 时**批量退订全部 `pi.events.on` 订阅**（`eventBusUnsubscribers` 逐个调用后清空） | loader.js:145-160、runner.js:482-485 |
| eventBus 是**每 session runtime 一份**（`createAgentSessionServices` 每次新建 `DefaultResourceLoader`，其 `eventBus = options.eventBus ?? createEventBus()`），不是进程全局单例 | bundle chunk-H33F2TZD.js：`createAgentSessionServices` 构造 `new DefaultResourceLoader(...)` 并 `await resourceLoader.reload(...)`；DefaultResourceLoader 构造器 `this.eventBus=options.eventBus??createEventBus()` |
| 上游 async/complete 事件经 `ctx.pi.events.emit` 在**父进程父 runtime 的 bus** 发出；child 是独立进程，通过 asyncDir 结果文件由父侧 result-watcher 转化为 complete 事件 | async-execution.js:1409/1986、result-watcher.js:473-535 |

**推论（F6 协议边界）：** `pi.events` bus 的作用域 = 当前 session runtime。正常独立 Host 一进程一 runtime 一 bus；「人为同进程多 Host 共享 bus」不是 SDK 默认接线，明确 unsupported。bus 事件无 sender 身份字段（见 §2），协议只能以注册时核对的 scope（token/hostKey/manager/sessionId）为界，不能声称识别无 identity 字段的任意 bus 发送者。

## 2. started / complete / foreground 实际字段表（不虚构）

所有发出点均为现场读取；`?` 表示条件展开字段。

### 2.1 `subagent:async-started`

| 发出点 | 字段 |
| --- | --- |
| async-execution.js:1409（workflow） | `lifecycleArtifactVersion, id, pid, sessionId, completionOwnerId, mode, agent, agents, task?（PROMPT_REDACTED）, goal?, chain, chainStepCount, parallelGroups, workflowGraph, cwd, asyncDir, sessionRoot?, timeoutMs?+deadlineAt?, usageBudget?, capabilityCeiling?, parentWorkflowRunId?, workflowKey?, nestedRoute` |
| async-execution.js:1986（single async） | 同上减 `agents/chain/parallelGroups/workflowGraph`，`mode:"single"`，新增 `launchContractDigest?, launchResolvedExtensions?` |
| subagent-executor.js:5134（workflow 经 foreground executor） | `lifecycleArtifactVersion, id, asyncDir, cwd, sessionRoot?, pid:process.pid, sessionId（currentSessionId ?? undefined）, completionOwnerId, mode:"workflow", agent:"workflow", goal?, timeoutMs?+deadlineAt?` |

- `sessionId` 取自 `ctx.currentSessionId`（§3）：async/tool 派发路径 `resolveCurrentSessionId(ctx.sessionManager)` **不可用时直接 throw**（asyncCtx 构造，subagent-executor.js:1014），生产派发必非空；唯一例外是 subagent-executor.js:5134 的防御式 `?? undefined`。
- `task/goal` 携带 `PROMPT_REDACTED`，不是原始 prompt。
- membrane `decorateLifecycle` 仅为**经 membrane api 代理**的 emit 追加可选 `title`（started）/`presentation`+可选 `title`（complete）；上游 bootstrap 用原始 pi，footer 收到的是原始 payload + 可选显示字段。footer 对 `event.title` 只读可选消费（custom-footer.ts:433-435）。

### 2.2 `subagent:async-complete`

| 发出点 | 字段 |
| --- | --- |
| result-watcher.js:517（结果文件投递主路径） | `...data`（结果文件内容：含 `sessionId, completionOwnerId, asyncDir, state, success, summary, results…`）+ `runId, triggerTurn, intercomDelivered, nestedChildren?, results（规范化）` |
| subagent-executor.js:2908（awaited workflow child） | `id, runId, sessionId（status?.sessionId ?? importedPublication?.sessionId ?? state.currentSessionId）, completionOwnerId, asyncDir, agent, mode:"single", state, success, timestamp, triggerTurn:false, awaitedByWorkflow:true, parentWorkflowRunId` |
| workflow-detach-reconcile.js:260（detached workflow 收敛） | `id, runId, source:"async", mode:"workflow", agent:"workflow", success, state, workflowReceipt?, workflowResolution?, terminalOutcome?, recovery, summary, reconciledFromDetachedChild, results, sessionId（plan.status.sessionId）, completionOwnerId, scheduleOrigin?, timestamp, triggerTurn:true` |

**上游投递门禁（在 emit 之前，不是 footer 过滤）：** result-watcher.js:115-120 `ownsCompletion` 要求 `deliveryActive && epoch===deliveryEpoch && activeSessionId===state.currentSessionId && ownsResult(sessionId, completionOwnerId)`；默认 `ownsResult` = `sessionId===state.currentSessionId && completionOwnerId===state.completionOwnerId`（result-watcher.js:109-112）。即进入 footer 的 complete 事件已被上游按「当前 session + completionOwner」过滤。

### 2.3 `subagent:foreground-complete`

发出点：subagent-executor.js:580。字段：`id:`${runId}:${index}``（复合 id，不等于 runId）、`runId, source:"foreground", mode, agent, success, summary, exitCode?, state, interrupted?, stopped?, processSignal?, timedOut?, turnBudgetExceeded?, timestamp, cwd, sessionFile（child 的 session 文件）, sessionId（派发时父 session 身份）, taskIndex`。

- 发出门禁（subagent-executor.js:578）：`input.notify===false || !input.sessionId || input.sessionId !== state.currentSessionId` 任一成立则**不发出**（stale session 有意丢弃，不路由给替换后的 runtime）。
- 注意 `sessionFile`（child 身份）与 `sessionId`（父 session 身份）是两个不同字段，不得混用。

### 2.4 无 generation 字段（禁止虚构）

三个事件通道的**任何发出点 payload 均无 generation 字段**（§2.1–2.3 全量字段核对）。F2b 不得实现「按 event.generation 过滤」；事件侧只允许 §4 的 session 字段判定，世代信息只能存在于本地闭包 token（§5）。

## 3. session 身份链：两套 `resolveCurrentSessionId`（关键差异）

| 实现 | 语义 | 证据 |
| --- | --- | --- |
| 上游 `resolveCurrentSessionId(sessionManager)` | **`getSessionFile() ?? getSessionId()`**，两者皆空 throw `"Current session identity is unavailable."` | 上游 `src/shared/session-identity.js:1-6` |
| enhanced compat `resolveCurrentSessionId(sessionManager)` | **仅 `getSessionId()`（UUID）**，缺失 throw | `src/compat/pi-subagents-0.75.ts:18-35`（`readSessionIdentity().sessionId`） |
| dispatch 侧 `lifecycleSessionIdentity(session)` | `sessionFile ?? sessionId`（对象形态，RPC 能力协商用） | `src/subagent-dispatch/extension.ts:263-268` |
| entry 侧 `lifecycleSessionId` | `readSessionIdentity(manager).sessionFile ?? resolveCurrentSessionId(manager)`（child ceiling 注册） | `extensions/subagent-runtime.ts:354` |
| membrane `getHostIdentity().hostSessionId` | `notificationState.currentSessionId`，其值来自 enhanced compat `resolveSessionId`（**UUID 形态**），仅用于 `PI_SUBAGENT_DISPATCH_TRACE_FILE` 诊断 trace 的 ownership-match/mismatch 判定，**不是生产过滤路径** | extension.ts:1961-1963、1819-1825；`diagnosticSink` 仅在 `PI_SUBAGENT_DISPATCH_TRACE_FILE` 存在时创建（subagent-runtime.ts:237-241、extension.ts:132） |

**事实推论（F2b 不得盲用 UUID）：** 事件 `sessionId` 的真实形态是上游语义 `sessionFile ?? UUID`。持久化 session 中它是**绝对路径**，不是 `manager.getSessionId()` 的 UUID。两形态可在线切换：session 文件在首条 user/assistant 消息落盘时才创建（session-manager.js:786 注释），此后每次 resume/management 派发重新解析（subagent-executor.js:1568），`state.currentSessionId` 可能从 UUID 翻转为 sessionFile；上游 index.js:822 在每次 `session_start` 也重解析。因此事件 sessionId 与当前 manager 身份的比对必须同时接受两种形态（同属当前 session），而非仅比对 UUID。

## 4. 当前 session 事件接受表（F2b 合同）

| 输入 | 判定 | 依据 |
| --- | --- | --- |
| started/complete：`event.sessionId` 非空且 `=== manager.getSessionFile()` **或** `=== manager.getSessionId()`（两者取当前 manager 实测值） | 接受 | §3 双形态事实；异 session 的 file/UUID 均不同，不引入误收 |
| `event.sessionId` 非空且与两者皆不等 | 拒绝（异 session 事件） | 计划要求「其它 session 事件拒绝」 |
| `event.sessionId` 缺失/空/非 string | **拒绝**（缺字段 fail closed） | 计划 P0「缺sessionId拒绝」。注意：当前 browser `trackStarted` 对缺 sessionId 不拒绝（session-browser.ts:219-244 缺失时仅省略字段），这是现状与 F2b 合同的差异点，F2b 按本表实现拒绝，不改动 browser 原行为 |
| foreground-complete：同上表；另注意 `id` 是 `${runId}:${index}` 复合值，身份关联用 `runId` 字段 | 接受/拒绝同上 | §2.3 |
| complete 事件到达 footer 前，上游已按 `ownsCompletion`（session + completionOwner + delivery epoch）过滤 | F2b 不重复实现 completionOwner 校验，不新建第二 owner authority | §2.2 门禁 |

**注：** 比较目标必须是「事件到达时刻」对当前 `ctx.sessionManager` 实测的 `getSessionFile() ?? getSessionId()`，不能缓存派发时刻的快照去比对后来事件（同一 session 内 `state.currentSessionId` 会在 resume 派发时重解析，§3）。

## 5. 闭包 token 与事件 generation 边界

- token = footer/provider 在每次 `session_start` 闭包内创建的**本地对象/闭包元数据**（现状：custom-footer.ts 的 `owner = ctx`（ctx 对象身份）+ `sessionEpoch` 闭包计数，custom-footer.ts:418-431、340-347；子计划 T1 的 `HostScope.token` 为每次 session_start 的新对象）。token **只存在于本地闭包/注册作用域**，不写入事件、不写入 session entry、不跨 extension 广播。
- 事件 payload 无 generation（§2.4）。旧事件不能被事件自身字段识别为「旧代」；「旧闭包失效」由两层机制保证（§6），不是事件过滤。
- 不得引入新 owner authority：F2b 消费 browser 事实与 §4 判定，不复制 completionOwner、不读取私有 owner Symbol（现状 `SUBAGENT_STATUS_STORE` Symbol 仅 footer 自有缓存，session-browser hydration 消费其持久 children，非公共 API）。

## 6. 旧 unsubscribe / token invalid（SDK 层 + 扩展层双保险）

| 场景 | SDK 层 | 扩展层现状 |
| --- | --- | --- |
| reload（同一 AgentSession） | `session_shutdown{reason:"reload"}`（agent-session.js:2935）→ `oldRunner.invalidate()`（2936）→ **旧 runtime 全部 `pi.events.on` 订阅自动退订**（loader.js:145-160）→ resourceLoader.reload 重跑工厂（bundle：`reload(){this.loaded&&clearExtensionCache();…loadFinalExtensionSet}`）→ `session_start{reason:"reload"}` 于新 runner（2961） | footer `session_start` 先 `teardown(event?.reason==="reload")`（custom-footer.ts:418-420）：`sessionEpoch += 1`、显式 `eventUnsubscribes.forEach(unsubscribe)`（346，对已自动退订的句柄重复调用安全：tracked unsubscribe 有 `active` 幂等闸，loader.js:151-159） |
| session 替换 new/fork/resume/switch | `emitBeforeSwitch` → `teardownCurrent`：abort → `session_shutdown{reason,targetSessionFile}` → `session.dispose()` → `_extensionRunner.invalidate(...)`（agent-session.js:999）→ 同上自动退订 → `createRuntime` 新 services/工厂重跑 → `session_start{reason:"new"\|"resume"\|"fork", previousSessionFile}` | 同上；新 session 是新 SessionManager 对象 + 新 sessionId（F4g 记录 §1 同源事实） |
| 进程 shutdown | `session_shutdown` 处理器 teardown（custom-footer.ts:452-454） | token 失效先于清理（计划 F6 顺序要求，此处仅记录现状一致性） |

**合同：** F2b provider 订阅必须 (a) 经 `pi.events.on` 取 unsubscribe 并保存；(b) 处理器先核对本地当代 token（owner/epoch 或 HostScope token 身份）再消费；(c) teardown 显式退订且幂等；(d) 不假设旧闭包仍收到事件（SDK 已自动退订），也不假设显式退订是唯一防线。

## 7. same-session reload 合法 complete 保持

- reload 不更换 SessionManager 对象与 sessionId（agent-session.js:2932-2965 仅重建 runner；F4g 记录 §1 已核同源事实）。
- 上游 `session_start{reason:"reload"}` → `resetSessionState`：`resultDeliveryOwnership.claimPredecessor(previousSessionFile, previousRuntimeSessionId)`（index.js:821，sessionFile===旧 currentSessionId 时成立）→ `state.currentSessionId = resolveCurrentSessionId(manager)`（822，同 sessionFile 值不变）→ `transitionResultDelivery()`（新 delivery epoch、activeSessionId=当前值，result-watcher.js:736-742）。**派发于 reload 前、投递于 reload 后的 complete 仍满足 `sessionId===state.currentSessionId`**，合法重发/续投。
- footer 现状：reload 时 `teardown(true)` → `browser.clear({preserveRuns:true})`（custom-footer.ts:348、session-browser.ts:384-389）保留 roster；新闭包重新订阅 + 500ms `reconcile` 轮询 `readBrowserRunStatus` 重新观察（custom-footer.ts:439-441）。
- **合同（F2b）：** reload 后 (a) 已跟踪任务不得被虚构 generation 拦截（§2.4）；(b) 相同 session 的 started/complete 事件按 §4 继续接受；(c) provider 的 roster/分区恢复仅依赖 browser 既有事实，不新增扫描器、不宣称补齐 fresh-Host 恢复缺口（计划全局约束）。

## 8. root 入口自动发现与禁用边界（不含 settings 内容）

| 事实 | 证据 |
| --- | --- |
| agent dir 默认 `~/.pi/agent`，`PI_CODING_AGENT_DIR` 覆盖；`<agent-dir>/extensions/` 是用户扩展自动发现目录 | configuration.md「Agent directory」表；environment-variables.md:81 |
| 本仓 `pi/` 即活动 agent dir（目录实体含 settings.json/sessions/extensions 等，本次仅列目录未读内容）→ F6 的 `pi/extensions/background-activity.ts` 将被**自动发现，无需改 settings** | 现场 `ls pi/`、`ls pi/extensions/`（bash-async.ts/task-scheduler.ts 等同层先例） |
| 生产发现路径：`DefaultResourceLoader.reload` → `packageManager.resolve()` → `addAutoDiscoveredResources`：用户 `<agentDir>/extensions` 恒加入（受 settings 覆盖 pattern 启用过滤），项目 `.pi/extensions` 仅 projectTrusted 后加入 | bundle：`addAutoDiscoveredResources(...)`，`addResources("extensions", collectAutoExtensionEntries(userDirs.extensions), userMetadata, userOverrides.extensions, globalBaseDir)`；项目侧包在 `projectTrusted&&(…)` |
| 目录内发现规则 `collectAutoExtensionEntries`：根 package.json `pi.extensions` manifest 或根 index.ts/js 优先；否则逐项——直接 `*.ts`/`*.js` 文件、子目录经 `resolveExtensionEntries`（package.json `pi.extensions` manifest 或 index.ts/index.js）；跳过点开头与 node_modules，遵守 .gitignore | bundle：`collectAutoExtensionEntries`、`resolveExtensionEntries`；manifest 读取 `dist/core/pi-manifest.js:7-26`（仅 `pi.extensions/skills/prompts/themes` 字符串数组） |
| settings 禁用机制：resolved path 逐条经 `isEnabledByOverrides(path, patterns, baseDir)`（`!` 排除、`+` 强制包含、`-` 强制排除），禁用 = 不进 enabled 列表，文件仍在盘 | bundle：`isEnabledByOverrides`；`getEnabledPaths(resolvedPaths.extensions)` |
| `--no-extensions` / `-ne`：`extensionPaths = noExtensions ? cliEnabledExtensions : mergePaths(cliEnabledExtensions, enabledExtensions)` → **仅 CLI `-e` 显式源**（temporary scope、恒 enabled），自动发现与 settings packages 全部不加载 | bundle：`no-extensions"||arg==="-ne"`、`extensionPaths=(this.noExtensions?cliEnabledExtensions:…)` |
| package standalone：`-e <本地包目录>` → `resolveLocalExtensionSource` → `collectPackageResources` 按 package.json `pi.extensions` manifest 逐条加载（本仓 package 声明 `./extensions/subagent-runtime.ts` 与 `./extensions/custom-footer.ts`）；`-e <文件>` 直接单文件加载 | bundle：`resolveLocalExtensionSource`；`packages/pi-subagents-enhanced/package.json` 的 `pi.extensions` |
| 直连 SDK 导出的 `discoverAndLoadExtensions`（loader.js:663-694）规则略异（项目 `cwd/.pi/extensions` + agentDir/extensions + 显式 paths；**无** dotfile/node_modules 跳过与 .gitignore 规则）；CLI 生产路径不走它 | loader.js:591-673 vs bundle collectAutoExtensionEntries |

**结论：** 「受控 `PI_CODING_AGENT_DIR/pi/extensions` 自动发现新 root 入口」成立（F6 无需 settings 写入）。禁用 extensions 的 standalone 边界 = `--no-extensions` 时仅显式 `-e` package/文件；不得以修改 settings 或删除文件方式达成禁用。本任务未读取 settings.json 内容。

## 9. 多 Host 隔离边界（unsupported 声明）

- 正常独立 Host：一进程一 runtime 一 eventBus（§1）。footer/provider 的 scope 判定（manager/sessionId/token/hostKey）在该范围内成立。
- 人为同进程共享 bus 的多 Host：SDK 默认接线不产生此形态；本合同不承诺检测「无 identity 字段的任意 bus 发送者」。协议实现按子计划：发现第二个不同 manager 的 owner 与同 bus 接线冲突时拒绝该组合并报告，仅此而已。
- child runner 是独立进程（binding.pid），其事件经结果文件/watcher 转化，不经进程间 bus；F2b 不为跨进程事件通道扩展。

## 10. T2b 精确范围与 fixture 正反例（冻结）

**接口：** `createSubagentActivitySource({browser, renderDetail, subscribe}): ActivitySource`（协议来自 package `src/tui/background-activity.ts`，T1 冻结）；事件订阅闭包受本地 token 保护；snapshot 为 browser 纯投影；detail 仍走 package trusted native 读（root 不读 sessionFile 正文）。

**合法 fixture 正例（全部为显示/事件 fixture，标明非 production 数据）：**
1. 当前 session started（sessionId=当前 manager 的 sessionFile 形态）→ 接受并入 roster。
2. 当前 session complete（sessionId=当前 manager 的 UUID 形态，模拟未持久化/翻转前派发）→ 接受并终态化对应 runId。
3. `source:"foreground"` 事件：按 `runId` 关联身份，`id` 复合值不作 runId 使用。
4. reload（同 sessionFile）：roster 保留、新闭包 re-subscribe 后旧任务 complete 仍被接受（§7）。
5. 缺 `title` 的 started：显示层回退（titleRegistry/label），不拒绝事件。

**反例（必须拒绝且不写 roster）：**
1. `sessionId` 为另一 session 的 file/UUID。
2. `sessionId` 缺失/空/非 string（注意：与现状 browser 行为不同，见 §4）。
3. 携带伪造 `generation` 字段的事件：字段不存在于真实 payload（§2.4）；fixture 若注入该字段，provider 必须忽略之，不得据此实现过滤。
4. 旧闭包 token 下的迟到事件（SDK 自动退订 + 本地 token 双保险下应不可达；fixture 直接调用旧 handler 验证 token 守卫）。
5. 声称支持「同进程共享 bus 双 Host」的用例：不作为成功标准，按 §9 拒绝组合并报告。

**明示不做：** 不跑真实 subagent、不读真实 session 正文、不修改上游/membrane、不新建 owner authority、不宣称覆盖直接 CLI/无扩展 SDK 入口。

## 11. 记录元数据

```json
{
  "taskId": "F0",
  "dispatch": "dispatch-1980f490",
  "status": "verified",
  "evidenceLinks": [
    "docs/plans/2026-10-13-remaining-runtime-execution.md#F0",
    "docs/plans/2026-10-13-background-activity-footer.md#task-p0",
    "docs/plans/records/2026-10-13-scheduler-observer-contract.md"
  ],
  "commands": [
    { "command": "git diff --check", "exitCode": "recorded-below" }
  ],
  "unverified": [
    "真实 Host 事件序列/卸载时序（归 F2b fixture 与 F6 集成验证，本任务禁止启动真实 Host）",
    "settings.json 内容（任务禁读；禁用 pattern 仅按源码机制描述）"
  ],
  "nextAction": "F2b 按 §4/§5/§7/§10 实现 createSubagentActivitySource；发现字段与本文矛盾时停止并上报，不扩公共 owner API"
}
```
