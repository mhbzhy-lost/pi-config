# subagent control `resume` 显式 `model` 选择器：只读调研与补设计（2026-10-14）

## 0. 产物与证据边界

- 性质：**只读源码分析 + 设计报告**。未实现、未修改任何 production/test 代码、未启动 Host/任务/provider/网络、未运行测试、未 stage、未 commit。
- 关联缺陷登记：`docs/bugs/2026-10-14-subagent-resume-model-override.md`（下称 bug record）。
- 现场版本锚点：
  - 本仓 HEAD `a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`（2026-10-13 `docs(testing): 记录合同围栏测试规范`）；工作区 dirty（既存改动），**index 无 staged 文件**。
  - 上游 `pi-subagents@0.75.0`，实体路径 `packages/pi-subagents-enhanced/node_modules/pi-subagents/`（本 package `bundleDependencies`，版本按 `packages/pi-subagents-enhanced/AGENTS.md` 固定）。
  - SDK `@earendil-works/pi-coding-agent@1.0.4`（根 `node_modules/`）。
- 证据模式：全部为**现场静态源码核对**，逐条给出 `文件:行`。凡未由源码直接支撑的判断，一律标注为「推断」或「未验证」，不冒充事实。
- 未读取真实 auth / models.json / settings.json / authority store / session 正文；引用的 run id 与模型字符串全部来自 bug record 已登记内容，本调研未新增任何真实运行观测。
- 主管裁定（本轮）：bug record §3/§5 存在一处**实质**源码不符，按方案 A 处理——仅在本文件独立章节更正，保留精确源码位置/版本与原断言对比，不扩大 writePaths，旧记录由父层后续统一更正。

---

## 1. 结论摘要

1. **首个偏离点确认**：上游 `pi-subagents/src/extension/rpc.js:423-440` 的 `resumeParams()` 以显式白名单重建 resume 参数，`model` 在此被**静默丢弃**（无 error、无 warning、无 invalid_params）。bug record 的定位在现场源码上完全成立。
2. **不是一处阻断，而是三道独立阻断**。即使 `resumeParams` 放行 `model`，上游仍有：
   - 管理层显式拒绝守卫 `subagent-executor.js:1553-1558`；
   - revive 启动层**从不读取** `input.params.model`，只用 `recoveryDescriptor?.model ?? target.model`（`:1889`）；
   - workflow `runs.run({resume})` 参数构造同样是白名单且不含 `model`（`:4348-4404`）。
   → **「让 resume 真正换模型」在不修改上游的前提下不可行**，且需要上游至少 3 处协同改动，不是单点补丁。
3. **本仓可独立完成的最小闭环是「契约诚实化」**：在 `executeControl` 的 resume 分支对 `model !== undefined` 做 pre-flight 显式拒绝（复用上游直连守卫语义），并补工具描述。该方案零副作用（拒绝发生在任何 RPC 调用之前），不触碰 run/session/lease/workspace/ledger。
4. **「用 fresh spawn 伪装 resume 换模型」不是 resume 修复**，本文明确**不推荐冒充支持**（§4.3）：它丢失上游 revive 的 canonical sessionFile 续写与独占 lease 语义、丢失 retained recovery descriptor 的 capability ceiling 交集、依赖 retention 可清理的 run 工件取证，并会牵动 `recovery-resume-activation.v1` 严格合同与 workspace owner/lease rebind。
5. **禁止路径**：注入/篡改上游私有 `recovery-descriptor.json`（`async-execution.js:1789` 写、`async-resume.js:263-300` 严格白名单校验）以伪造 model 恢复证据。该文件是上游 recovery 身份权威，本仓写入即伪造恢复证据。
6. **bug record 需更正一处、锐化一处**（§3）：revive **确实**走 pi 核心 session 加载（`SessionManager.open` 复用 canonical sessionFile），旧模型未被 session 还原的真实原因是 SDK **显式 model 优先**（`sdk.js:87-99`）；另 `step.model` 是 **launch-selected/expected** 而非 observed actual（`subagent-runner.js:785,1065,3537`）。
7. **需用户决策 4 项**（§8）：支持范围（诚实拒绝 vs 真换模型）、是否授权上游修改/升级、拒绝语义（hard error vs warning+继续）、child 会话直连路径是否纳入同一契约。

---

## 2. 完整调用链与首个偏离点

### 2.1 本仓公共层（model 原样透传，control 分支不 apply selector）

| # | 位置 | 事实 |
|---|---|---|
| 1 | `src/subagent-dispatch/extension.ts:54-113` `TYPED_SUBAGENT_PARAMETERS` | 顶层单一 object，`additionalProperties:false`；`:61` `model: { type:"string", minLength:1, maxLength:512, pattern:".*\\S.*" }` 是**无条件**顶层属性；`:107` `action` enum 含 `resume`。schema 层对 `resume + model` 组合**无任何条件约束** → 校验通过。 |
| 2 | `extension.ts:117` `TYPED_SUBAGENT_DESCRIPTION` | 明文写「model 是唯一可选的模型选择器」「resume 必须携带非空新消息，可将 paused/completed/failed 的 run 以新 run（新子会话）方式续跑」。**全文未声明 resume 会忽略 model** → 契约文本让调用方形成「可切换」预期。 |
| 3 | `extension.ts:1576-1590` + `:1657` | 本仓注册 `name:"subagent"`、`exposure:"model-only"` 的 typed 工具，`parameters: TYPED_SUBAGENT_PARAMETERS`。 |
| 4 | `extension.ts:1612-1614` | `if (Object.hasOwn(input, "action"))` → `executeControl(input, rpc, …)`，`input` 原样传入，**无 model 过滤**。 |
| 5 | `extension.ts:1174-1259` `executeControl` | `:1205-1207` 仅校验 `resume` 的 `message` 非空（`INVALID_RESUME_MESSAGE`）；`:1208` `const { action, ...params } = input` → `model` 留在 `params`；`:1249` `const reply = await rpc[action](params)`；`:1250-1259` 成功后仅做 `titleRegistry` 续接（title/agent，**不含 model**）。**resume 分支不经 supervisor 控制面**（`:1209` 起的控制面分支只处理 `action === "steer"`）。 |
| 6 | `extension.ts:538-582` `resolveSpawnModel` | 本仓模型选择器唯一入口。调用点只有 `:802`（`executeCoding`）与 `:1017`（`executeGeneric`）。**control/resume 路径从不调用**，`providerBlacklist` 也只传给这两条 spawn 路径（`:1619`、`:1623`）。 |
| 7 | `src/subagent-dispatch/rpc-client.ts:299-301` | `resume(params, options) → call("resume", params, options)`，透传。`:199` `call()` → `:276` `events.emit(REQUEST_CHANNEL, {version:1, requestId, method, params, source})`，`:216/:230` 在 `subagents:rpc:v1:reply:<requestId>` 上等回复。 |
| 8 | `src/subagent-dispatch/execution.ts` | 只有 spawn 侧 adapter（`createGenericDispatchAdapter` / `createCodingDispatchAdapter` / `dispatchExecution`，均在 `model === undefined` 时省略字段）。**该文件不含任何 resume 语义**，因此「自有 execution 层保留 model」在 resume 上没有现成接点。 |

结论：本仓层**不丢** model，但也**不校验、不 apply selector、不在回执中报告**。

### 2.2 上游 RPC 层 —— **首个偏离点**

`pi-subagents/src/extension/rpc.js`：

```
:17-19   SUBAGENT_RPC_REQUEST_EVENT / READY_EVENT / REPLY_EVENT_PREFIX（与本仓 rpc-client.ts:3-4 同一 in-process 事件总线）
:20      SUBAGENT_RPC_METHODS 含 "resume"
:423-440 function resumeParams(params) { … }        ← 首偏离点
:632-633 request.method === "resume" → executeChecked(options, ctx, requestId, method, resumeParams(request.params))
:343-349 executeChecked → assertSubagentParams → options.execute(`rpc-resume-<id>`, params, signal, undefined, ctx) → failIfToolError → dataFromToolResult
```

`resumeParams()` 现场事实（`:423-440`）：

- 校验：`message` 非空（`:425-426`）；target 至少含 `id|runId|dir`（`:427-429`）；`output` 必须非空路径（`:430-431`）；`outputMode` 只允许 `file-only`（`:432-433`）。
- 返回：`{ action:"resume", ...target, message, ...(output?{output,outputMode:"file-only"}:{}) }`（`:434-439`）。
- `target` 由 `normalizeTargetParams`（`:270-271`）→ `normalizeTargetParamsFromRecord`（`:258-269`）产生，**只保留 `id`/`runId`/`dir`/`index`**。

→ 这是一个**重建式白名单**，不是「删除已知危险字段」的黑名单。任何未列举字段（含 `model`、`thinking`、`agent`、`acceptance`、`capabilityCeiling`…）都被丢弃，且**不产生任何诊断**。`index` 能存活而 `model` 不能，正是白名单性质的直接证明。

补充事实（同源，说明这不是本仓 schema 独有缺陷）：

- 上游自身工具 schema `src/extension/schemas.js:246` 也把 `model` 声明为无条件可选字符串（`"Child model provider/id; bare id only if unique…"`），**没有 action 条件约束** → 上游 schema 同样接受 `resume + model`。
- 上游 `steerParams`（`:406-422`）白名单为 `{action, target, message, mode, steeringRecovery:false}`，同样无 `model` → **steer 也不能换模型**，且同样是静默丢弃。
- `manage` 方法（`:350-374`）只构造 `{action, id?, quiet?}`；`SUBAGENT_RPC_MANAGEMENT_ACTIONS`（`:21-29`）全是 `schedule.*`，**不存在能携带 model 的 resume 管理动作**。
- `spawnParams`（`:375-404`）经 `normalizePublicSubagentExecution` 保留 `model`；但 `src/extension/public-execution.js:123-124` 明确拒绝顶层 `resume` 执行参数：「Top-level resume execution is not available. Put resume on a workflow script runs.run/runs.all item.」→ **无法用 spawn 携带 resume+model**。

**关键推论（决定本仓有无接点）**：RPC 是 in-process 事件总线，服务端在同一 pi 进程内重建参数。本仓是**发送方**，没有任何发送后钩子能让上游 `resumeParams` 保留额外字段；`runtime-membrane.ts:175-189` 的拦截只作用于 `registerTool`/`getAllTools`（把上游 `subagent` 工具挡在 root 会话之外，只放行 `subagent_supervisor` 并 bind 进 adapter），**不是 RPC 参数拦截器**。→ **wire 层无绕过空间**。

### 2.3 上游恢复执行层（旧模型三段回填）

1. `src/runs/foreground/subagent-executor.js:6506-6512`：`action === "resume"` → `resumeAsyncRun({params: paramsWithResolvedCwd, …})`。
2. `:1553-1558`：**直连守卫**——`if (input.params.model !== undefined)` 直接返回 `isError:true`，文案 `"action='resume' reuses the persisted child model and does not accept a model override."`。因 `resumeParams` 已剥离 `model`，RPC 路径**永远不会触发**这条守卫；这就是「直连显式报错 / RPC 静默吞掉」的分歧根源。
3. `:1572` `resolveRequestedResumeTarget(...)` → `src/runs/background/async-resume.js:476` `resolveAsyncResumeTarget()`：
   - `:597` `const stepModel = statusSteps[index]?.model ?? resultSteps[index]?.model ?? (stepCount === 1 ? result?.model : undefined);`
   - `:619` `...(stepModel ? { model: stepModel } : {})` → `target.model`（**来源全部是旧 run 的持久化工件**：`status.json` steps / `results/<runId>.json`）
   - `:621` `launchContractDigest` 同样从旧工件导出；`:607-627` 的 target 构造块附带 `recoveryDescriptor`（`:626`）、`capabilityCeiling`（`:624`）、`thinkingCeiling`（`:625`）、`managedWorktree`（`:617`）。
4. `:1791` `const revivalSessionFile = target.sessionFile;`（旧 child 的 canonical session 文件）；`:1792-1794` 无 sessionFile 即失败。
5. `:1855-1935` `executeAsyncSingle({...})` 中：
   - `:1881` `sessionFile: revivalSessionFile`
   - `:1882-1887` `revivalLease: { sessionFile: revivalSessionFile, runId, sourceRunId: target.runId, parentSessionId? }`
   - **`:1889` `modelOverride: recoveryDescriptor?.model ?? target.model`** ← 旧模型；**整个 revive 参数块不出现 `input.params.model`**
   - `:1891-1892` `modelOverrideFromParent` / `modelOrigin` 亦只取 descriptor 或 `target`
   - `:1928` `capabilityCeiling: intersectSubagentCapabilityCeilings(recoveryDescriptor?.capabilityCeiling ?? …, resolveCurrentSubagentCapabilityCeiling(...))`
   - `:1946/:1975-1976/:2003` 回执携带 `sourceLaunchContractDigest = target.launchContractDigest`（血缘审计信号，非强制门禁）
6. `src/runs/background/async-execution.js:1596-1608`：`resolveModelOrigin({fromParent: params.modelOverrideFromParent, storedOrigin: params.modelOrigin, explicitModel: params.modelOverrideFromParent ? undefined : params.modelOverride, …})` → `resolveSubagentModelOverride(params.modelOverride ?? agentConfig.model, …)`（`src/runs/shared/model-resolution.js:285-313`）→ `primaryModel` → `:1668-1680` `resolveModelSelection(...)` → `:1697/:1710/:1745` `model: selectedModel`。
7. `:1707-1735` `resolveLaunchBinding({... model: source.model ...})` → `src/shared/launch-contract.js:104-136`：**`model` 是 `launchContractDigest` 的组成字段**。→ 换模型必然改变新 run 的 digest（这本身是 desirable 的可观察差异，但也意味着任何以 digest 做等同性判断的消费方会看到不一致）。

### 2.4 fresh spawn 对照（为什么 spawn 可换模型）

- 前台/异步单 spawn：`subagent-executor.js:3062-3075`
  `resolveModelOrigin({storedOrigin: params.modelOrigin, explicitModel: params.model, agentModel: a.model, parentModel})` → `resolveEffectiveSubagentModel(params.model, a.model, parentModel, availableModels, a.modelProvider ?? currentProvider, {scope, source})` → `modelOverride`；`:3098` `sessionFile: sessionFileForTask(params.agent, 0, modelOverride, modelOverrideFromParent, modelOrigin)`；`:3106-3108` 传入 `executeAsyncSingle`。
- 另一条前台路径 `:3496` 同样以 `params.model` 为首要输入。
- 本仓 spawn 侧：`extension.ts:802/:1017` → `resolveSpawnModel` → `model-selection.ts` `resolveModelCandidates` + `resolveModelSelection`，再经 `workflow-spawn.ts` `childControls()`（白名单含 `"model"`、`"thinking"`）写进 `runs.run(key, leaf)` 脚本 → RPC `spawn`。
- bug record §1 步骤 4 已用真实 fresh spawn（`run 94534908-…`，`GLM-5.3` running）实证该路径可用。

**差异本质**：spawn 的模型输入是**调用方参数**；revive 的模型输入是**旧 run 持久化工件**。两者不是同一数据源，因此「spawn 能换」不能推出「resume 能换」。

### 2.5 workflow 脚本路径同样不通

`subagent-executor.js:4348-4404` `prepareWorkflowLaunchParams()` 的 `typeof childParams.resume === "string"` 分支：

- 对 `extensionBindings`（`:4364-4366`）与 `gate`（`:4367-4369`）**显式抛错**：「… is not supported with retained resume; resume uses the original retained child binding / the retained child contract.」
- 返回对象（`:4389-4404`）是白名单：`{action:"resume", id, index?, message, workflowParentRunId, workflowKey, workflowOutputClaimPath?, lane?, worktree?, baseRef?, outputSchema?, …}`，**不含 `model`，且对 `model` 不抛错**。
- `src/workflows/scripted-workflow.js` 全文**无 `model` 字样**（`runs.run` 参数校验 `:655-680` 只约束 `gate`/`extensionBindings`/`resume`/`agent`/`task`）→ workflow 层既不承认也不拒绝 `model`，同样静默忽略。
- `docs/tool-reference.md:178`：「`resume` and `agent` are mutually exclusive. The revived child keeps its stored agent, model, and tool contract.」
- `CHANGELOG.md:1332`：retained workflow child 可经 `runs.run` resume「without changing its stored agent, model, or tool contract」。

→ 「resume 沿用 stored model」是上游**明文设计意图**，不是实现疏漏；真正的缺陷形态是**契约信号不一致**（schema/描述接受 `model`，RPC 层静默丢弃，直连层却显式拒绝）。

### 2.6 首偏离点判定

- **首个偏离点（本仓调用方视角）**：`pi-subagents/src/extension/rpc.js:423-440` `resumeParams()`。这是 `model` 在调用链上**第一次也是唯一一次**被移除的位置；此前每一跳都原样携带。
- **共因（本仓公共层）**：`extension.ts:54-113` schema 无条件接受 + `:117` 描述未声明例外 + `:1208/:1249` 盲透传 + `:1250-1259` 成功回执无 `modelSelection`/`warnings`。
- **主因（上游）**：白名单式过滤 + 与自身直连守卫（`:1553-1558`）行为不一致。
- **被排除的更深假设**：不需要「恢复执行层覆盖了调用方模型」这一假设——`model` 从未到达该层；`:1889` 只消费旧工件。bug record 的这一排除在现场源码上成立（其**理由**需更正，见 §3）。

---

## 3. 对 bug record §3/§5 的源码级更正（主管裁定方案 A）

> 本节只更正**理由**，不推翻 bug record 的首偏离点与根因结论。原断言与现场源码逐条对比，版本锚点见 §0。

### 3.1 更正一：revive **确实**走 pi 核心 session 加载；必须区分两种身份

**bug record 原断言**

- §3：「同文档 `:350`/`:355` …… 是『以旧 session 上下文新建子会话』，不是 pi 核心意义上的原地 session 恢复。」
- §5 被排除的假设：「pi 核心 session 恢复还原模型（models.md）与本链无关：revive 是新子会话，不走核心 `--resume` 加载。」

**现场源码事实（与原断言不符）**

revive 复用**同一个 canonical session 文件**，并经 pi 核心 `SessionManager.open` 打开续写：

1. `subagent-executor.js:1791` `const revivalSessionFile = target.sessionFile;`（= 旧 child 的 session 文件，来自 `async-resume.js:591-596` `statusSteps[index]?.sessionFile ?? resultSteps[index]?.sessionFile ?? (stepCount === 1 ? status?.sessionFile ?? result?.sessionFile : undefined)`，并经 `validateResumeSessionFile` 校验（`:596`））
2. `:1881` `sessionFile: revivalSessionFile` 传入 `executeAsyncSingle`
3. `async-execution.js:1743-1745` `...(sessionFile ? { sessionFile } : {})` / `...(selectedModel ? { model: selectedModel } : {})` 进入 runner 配置
4. `src/runs/shared/child-launch.js:64-71` `childStorage(input)`：`if (input.sessionFile) { fs.mkdirSync(dirname); return { kind:"file", sessionFile: input.sessionFile }; }`；`:215-216` `storage: childStorage(input)`、`...(input.model ? { model: input.model } : {})`
5. `src/runs/shared/child-session.js:406-407` `launch.storage.kind === "file"` → **`pi.SessionManager.open(launch.storage.sessionFile, undefined, launch.cwd)`**（SDK 声明：`dist/core/session-manager.d.ts:378` `static open(path, sessionDir?, cwdOverride?)`）
6. 上游文档自身亦印证：`docs/tool-reference.md:356`「Direct revival takes an **exclusive cross-process lease on the canonical session file** until the new child finishes.」

**因此必须区分两种身份，不得沿用「新子会话 = 新 session 文件」**：

| 身份维度 | revive 后的事实 | 权威来源 |
|---|---|---|
| **run / child 执行实例身份** | **新**：`runId = randomUUID()`（`subagent-executor.js:1821`）、新 `asyncDir`（`:1856`）、新 pid、新 process-terminal 证据链 | `:1821`、`:1856`、`revivalLease.runId`（`:1882-1887`） |
| **canonical session 身份** | **复用旧的**：同一 `sessionFile`、同一 `sessionId`（`SessionManager.open` 读文件头）、新条目**追加**到旧分支 | `child-launch.js:64-71`、`child-session.js:406-407` |
| **session 独占 lease** | 新 run 对**旧 canonical sessionFile** 取跨进程独占 lease，直到新 child 结束 | `session-lease.js:158-249`、`subagent-runner-bootstrap.js:133` |
| **血缘** | `sourceRunId = target.runId`；`sourceLaunchContractDigest = target.launchContractDigest` | `:1885`、`:1946/:1975-1976/:2003` |

**旧模型未被 session 还原的真实原因**（替代原「不走核心恢复」的理由）：

- `child-session.js:413-419`：`launch.model` → `pi.resolveCliModel({cliModel: launch.model, modelRuntime})` → `createAgentSession({ …, model: resolvedModel.model, sessionManager })`
- SDK `dist/core/sdk.js:87-99`：
  ```js
  let model = options.model;
  const sessionModel = getBranchSelection(sessionManager.getBranch(), …);
  if (!model && hasExistingSession && sessionModel) { /* 才从 session 还原 */ }
  ```
  → **显式 `options.model` 优先；只有未显式传 model 时才还原 session 记录的选择**。
- 而 revive 恒有 `modelOverride`（`:1889`，来自 descriptor 或旧工件），故 `launch.model` 非空 → 走显式分支，session 记录不参与。
- 对照 `docs/models.md:35`：「A session records model and thinking-level changes. Resuming the session restores them without changing defaults for new sessions.」——该还原语义在本链中**被显式 model 短路**，而非「不经过」。

**结论不变**：首偏离点仍是 `rpc.js:423-440`；旧模型来自旧 run 工件而非 session 还原。**但理由必须改为「显式 model 优先短路了 session 还原」**。

**设计含义（重要且需克制解读）**：`sdk.js:87-99` 只证明 **SDK 底层支持**在同一 session 文件上以不同显式 model 启动，**不等于本仓存在安全接点**。本仓既拿不到 `launch.model` 的注入点（它在 runner 子进程内由上游配置构造），也不能改写 `recovery-descriptor.json`。§4 逐项核查安全边界后给出结论。

补充（换模型是否会污染后续 revive 的 session 分支选择）：`dist/core/virtual-models.js:29-44` `getBranchSelection()` 从分支尾部扫描，**最后一条非虚拟 assistant response 的 `provider`/`model` 即为分支选择**（`model_change` 仅在虚拟模型场景保持）。故若某次 revive 确以新模型产出响应，新模型会随响应自然成为分支选择，不会残留旧模型。`dist/core/agent-session.js:295-306`（调用点 `:1380`）`_recordSelection()` 只在分支隐含另一选择且涉及虚拟模型时追加 `model_change`（`session-manager.d.ts:267` `appendModelChange`）。此为 SDK 事实，非本仓可控面。

### 3.2 锐化二：`step.model` 是 launch-selected，不是 observed actual

bug record §6 unknown#1 记录了「status 行裸 `gpt-6.1-sol` 不构成 actual-model provider 的完整证据」。现场源码可把这条从 unknown 提升为**确定结论**：

- `run-child-session.js:401-410`：子会话流中 `if (event.message.model) { model = event.message.model; … }` —— 这是**唯一**的 observed（provider 响应）模型采集点；`:406-409` 用 `formatSubagentModelVerificationError(input.expectedModelForVerification, event.message.model, …)` 做期望/实测比对；`:520` 该 observed `model` 进入 child session result。
- `subagent-runner.js:785` `const candidate = step.model;`（launch-selected）；`:808` `expectedModelForVerification = candidate && !step.skipPrimaryModelVerification ? candidate : undefined`；**`:1065`** `finalResult = { …run, model: candidate ?? run.model, … }` → **launch-selected 优先覆盖 observed**（仅当 `step.model` 为空时才留 observed）。
- `:3537-3539` / `:3966-3967`：`setOptionalProperty(status.steps[fi], "model", singleResult.model)` 回写 status；`:2686-2695` `updateStepModel()` 在每次 attempt 启动时把 `step.model` 更新为该 attempt 的 launch 模型。
- `async-status.js:232` 投影 `step.model`；`shared/formatters.js:33-44` `formatModelThinking()` 再 **剥掉 provider**（`displayModel.slice(slashIdx+1)`）→ 得到 `gpt-6.1-sol · thinking high` 这样的裸串。

**判定**：状态投影里的模型串是 **launch-selected/expected（且已去 provider）**，不是 observed actual。revive 场景下 `expectedModelForVerification` 也等于旧模型，所以即使实际响应模型不同，上游校验也**不会**报错——**上游在 resume 换模型这件事上没有任何自发信号**。

**唯一权威的 observed actual 来源**：child 会话 `.jsonl` 中 assistant message 的 `provider`/`model`（以及 `SessionManager.appendUsage(kind, provider, model, usage, note)` 记录的 usage 条目，`session-manager.d.ts:269`）。`results/<runId>.json` 的 `model` 与 `status.json` 的 `steps[].model` 都不是 observed。

### 3.3 命名冲突：本仓 `requestedModel` ≠ 上游 `step.requestedModel`

两者同名不同义，设计必须显式隔离：

| 名称 | 语义 | 位置 |
|---|---|---|
| 本仓 `details.modelSelection.requestedModel` | **调用方原始工具参数**（`input.model?.trim()`） | `extension.ts:539`、`:578-580`、`:586-592` |
| 本仓 `details.modelSelection.resolvedModel` | 本仓 selector 解析后的 qualified `provider/id` | `model-selection.ts` `resolveModelSelection()` 返回 `model` |
| 上游 `step.requestedModel` | **已解析后的 launch override 串**（`origin === "inherited"` 时为 `undefined`），不是调用方原参 | `model-resolution.js:337-355`（`const requestedModel = origin === "inherited" ? undefined : model;`），经 `async-execution.js:874-882/:1668-1676` → `:943/:1823` 写入 step，`async-status.js:237` 投影 |
| 上游 `step.model` | launch-selected（含 thinking 后缀），见 §3.2 | `async-execution.js:907/:937/:1697` |

---

## 4. 本仓可行性评估（不修改上游 / vendor / fork）

### 4.1 Option A —— pre-flight 显式拒绝（**推荐**，本仓可独立完成，最小 diff）

**做法**：在 `executeControl`（`extension.ts:1174`）的 resume 校验块内，紧接 `:1205-1207` 之后、`:1208` 解构之前，增加一条 fail-closed 分支；文案对齐上游直连守卫语义（`subagent-executor.js:1555`）。同时更新 `TYPED_SUBAGENT_DESCRIPTION`（`:117`）补一句 resume 的 model 例外。

**为什么这是本仓能做到的最强信号**：

- 上游 `resumeParams` 是重建式白名单，wire 层无绕过（§2.2）；
- 上游直连守卫（`:1553-1558`）在 root 会话**不可达**——`runtime-membrane.ts:175-186` 拦截了上游全部 `registerTool`（只放行 `subagent_supervisor`），`:187-189` 还从 `getAllTools` 过滤掉它，故 root 会话只有本仓 typed `subagent` 工具（`extension.ts:1576-1590`、`:1657`），唯一通路是 RPC。**本仓必须自己产生拒绝信号，不能指望上游产生。**

**副作用面（可证明为零）**：拒绝发生在 `rpc[action](params)`（`:1249`）之前，因此

- 不产生新 run、不写 `asyncDir`、不分配 active-async capacity；
- 不取 canonical sessionFile 的 revival lease（lease 只在 runner 子进程 bootstrap 内取：`subagent-runner-bootstrap.js:133`，释放于 `:204` 与 `:120` 的 `process.once("exit")`；释放证据由 `process-terminal.js:43-49` 记 `leaseDisposition` / `canonicalSessionLeaseReleased`）；
- 不追加旧 session 文件任何条目（`SessionManager.open` 只发生在 `child-session.js:406-407`，即子进程内）；
- 不触碰 workspace ledger / owner token / integration queue resume intent / proof outbox（这些只在 `workspace/coordinator-server.ts:414-443` `recovery.activate-resume` 与 `workspace/integration-queue.ts` 的 intent 状态机中变更）；
- 不经 supervisor 控制面（`executeControl` 的控制面分支只覆盖 `steer`，`:1209`）→ 不产生 delivery intent / receipt / 补偿路径。

**验证方式**：既有测试已有同型断言——`test/subagent-runtime-membrane.test.mjs:1405-1431`「maps approved control actions to RPC and requires a resume instruction」在拒绝后断言 `rpc.calls.length` 不增长。Option A 复用该模式即可（§6）。

**残留契约缺口（A 不解决）**：调用方若确实需要换 provider，仍必须改走 fresh spawn。A 只保证「不再静默」。

### 4.2 Option B —— A + 替代路径回执（A 的增强，仍属本仓范围）

在 A 的拒绝回执 `details` 中附加**事实性**替代指引（不含伪造的 resolved/actual）：

- `details.code = "RESUME_MODEL_OVERRIDE_UNSUPPORTED"`
- `details.detail.requestedModel` = 调用方原参（明确标注为 requested，**不得**命名为 `model`/`resolvedModel`/`actualModel`）
- `details.detail.persistedModelProvenance` = 说明续跑模型来源是旧 run 持久化工件（`async-resume.js:597` → `subagent-executor.js:1889`），并声明本仓**未**读取该值（若未读取就不报值，避免伪造 resolved）
- 文案指向已验证可用的替代路径：对 failed run 做 fresh spawn 并显式 `model`（bug record §1 步骤 4 实证）

`failure()`（`extension.ts:241-253`）已支持 `{code, detail, keypath}` 形状，`keypath` 可填 `$.model`，与 `INVALID_RESUME_MESSAGE` 的 `$.message`（`:1206`）风格一致。

### 4.3 Option C —— 用 fresh spawn 伪装「resume 换模型」（**不推荐；明确不是 resume 修复**）

**构造思路**：读旧 run 事实（agent / sessionFile / cwd）→ 以新 model fresh spawn → 在 prompt 内注入旧 session 引用（模仿 `async-resume.js:658-671` `buildRevivedAsyncTask()` 的文本形态）。

**逐项安全边界核查结论（全部为本轮源码核对）**：

| 边界 | 结论 | 证据 |
|---|---|---|
| 旧 session 身份 | **不被触碰**（fresh spawn 的 session 文件是 `path.join(sessionRoot, "run-<idx>", "session.jsonl")`，新 runId 的新 sessionRoot） | `subagent-executor.js:7028-7041`（`sessionDirForIndex` / `childSessionFileForTask`）、`:3098` |
| revival lease | **不取用也不冲突**（lease 只在带 `revivalLease` 的 revive runner 中获取） | `subagent-runner-bootstrap.js:106,132-134` |
| 上下文保真 | **语义降级**：新 child 没有旧会话的真实消息历史，只有我们注入的文本引用；上游 revive 是 `SessionManager.open` 真续写 | `child-session.js:406-407` vs `:409-411`（`create`/`inMemory` 分支） |
| capability ceiling | **可能放宽**：revive 取 `intersect(recoveryDescriptor.capabilityCeiling ?? target.capabilityCeiling, current)`；fresh spawn 取 `intersect(effectiveParams.capabilityCeiling, current)`，**不继承 retained child 的 ceiling** | revive `:1928` vs spawn `:7151`、`:1769` |
| recovery descriptor | **不可用**：多数 async revive 强制要求 descriptor（`asyncReviveRequiresRecoveryDescriptor`：非 workflow 或无 sessionFile/ceiling 即要求）；descriptor 由上游私有写入且字段严格白名单，未知字段直接抛错 | `async-resume.js:251-255`、`:263-300`（`allowedFields`）、`async-execution.js:1789`（`writePrivateAtomicJson(..., "recovery-descriptor.json")`） |
| 取证可用性 | **不可靠**：旧 run 的结构化 step 事实（`model`/`requestedModel`/`sessionFile`/`agent`）**不在 RPC status 的 `details` 里**——`inspectSubagentStatus` 的 details 基本只有 `{mode, results}`，结构化模型信息只存在于人类可读 `text`；`asyncSnapshot` 只给 `modelThinking` 显示串（已去 provider） | `run-status.js:351-520`、`rpc.js:246-252/:594-621`、`async-status.js:196-250/:300-323`、`shared/async-status-projection.js:509-516` |
| 绕过取证的唯一替代 | 直接读 `asyncDir/status.json`（本仓已有先例：`src/tui/session-browser.ts:143-156` `adjacentFacadeLeafStep` + `readBrowserRunStatus`，路径限定在 `path.dirname(asyncDir)` 直接子目录）。但该工件受 retention 清理（bug record §6：4 个相关 run 工件已被清理），**证据可用性不可保证**，且这是 TUI 展示层先例，不是派发决策层授权 | `session-browser.ts:143-156`、`:180` |
| workspace / owner | **高风险**：若旧 run 是 `publication=allowed` 的 coding 托管工作区，fresh spawn 会走新的 workspace 分配；要把新 run 绑回原 lease 必须经 `recovery.activate-resume`，而其 `ResumedRunIdentity` 是 `exactKeys` 严格合同且**不含任何 model 字段** → 需要 v2 合同 | `recovery-resume-contract.ts:21`（`RESUMED_RUN_KEYS = ["runId","asyncDir","sessionId","pid","agentProfile"]`）、`:88-93`（`exactKeys`）、`:104-110`（`parseResumedRun`）、`coordinator-server.ts:414-443` |
| 模型选择器一致性 | 可复用：`resolveSpawnModel`（`extension.ts:538-582`）+ `resolveModelCandidates`（全候选 API guard）+ `resolveModelSelection`（qualified 精确匹配 / 裸 id 按声明候选链 / 全局 catalog 兜底并给 `MODEL_MATCH_USED_GLOBAL_CATALOG`）+ `assertDispatchModelApi`（拒绝 `pi-virtual`、要求非空 `api`）+ `providerBlacklist` | `model-selection.ts` 全文；`extension.ts:802/:1017/:1619/:1623` |

**判定**：Option C 技术上可拼装，但它**不是 resume 修复**——它改变了身份语义（新 session 而非续写）、放弃了 retained contract 继承（ceiling / descriptor / extensionBindings）、并把决策建立在 retention 可清理的工件上。若采用，必须**明确对外声明为「fresh spawn 替代路径」而非 resume 支持**，不得冒充。主管已明确：不推荐冒充支持。**本文不推荐 Option C。**

### 4.4 Option D —— 注入/篡改上游私有 recovery descriptor（**禁止**）

`recovery-descriptor.json` 由上游 `async-execution.js:1789` 以 `writePrivateAtomicJson` 写入，`async-resume.js:263-300` 校验：`version` 必须为 1、`allowedFields` 白名单外字段直接抛错、`sourceRunId/agent/cwd/systemPromptMode/outputMode` 必填、`modelOrigin ∈ {explicit, inherited, configured}`（`:339-340`）、`modelOrigin` 缺失且 `model` 存在时按 `modelOverrideFromParent` 推导（`:341-342`）。

本仓写入或改写该文件即**伪造恢复证据**，且会绕过 `:1889` 的模型来源策略与 `:1928` 的 ceiling 交集。**明确禁止**（与主管指令一致）。同理禁止：伪造 `status.json` / `results/*.json` 的 `steps[].model` 以诱导 `async-resume.js:597` 选到新模型。

### 4.5 若必须上游扩展：接口提议（**只写提议，不改上游代码**）

要让 `resume` 真正支持换模型，需上游在**三处**协同改动（缺一即无效或不一致）：

1. **RPC 参数层**（`src/extension/rpc.js:423-440`）
   - 最小一致化（推荐先做）：`resumeParams` 对 `model !== undefined` 抛 `SubagentRpcError("invalid_params", …)`，文案复用 `subagent-executor.js:1555`，消除「直连报错 / RPC 静默」分歧。`executeChecked` 的 `failIfToolError`（`:253-257`）与本仓 `rpc-client.ts` 的错误映射已能把它变成调用方可见的 error。
   - 若要支持换模型：显式接受 `model`（及可选 `thinking`），并在 `resumeParams` 内做基本形状校验后透传。
2. **管理守卫层**（`src/runs/foreground/subagent-executor.js:1553-1558`）
   - 需从「无条件拒绝 `params.model`」改为「按能力开关/显式 opt-in 接受」，并要求调用方同时确认放弃 retained 契约等同性。
3. **revive 启动层**（`:1855-1935`，核心是 `:1889`）
   - `modelOverride` 需引入显式优先级：`explicitRequestedModel ?? recoveryDescriptor?.model ?? target.model`；
   - 相应地 `modelOrigin`（`:1892`）必须在显式覆盖时置为 `"explicit"`（否则 `resolveModelOrigin`（`model-resolution.js:322-331`）会因 `storedOrigin` 优先而沿用旧 origin，导致 `async-execution.js:1596-1608` 走 inherited 分支、`requestedModel` 被置 `undefined`、并跳过 explicit 的 scope 强制）；
   - `thinkingOverride`（`:1893`）与 `thinkingCeiling`（`:1894`）需一并按新模型能力重算（`assertThinkingWithinCeiling`，`async-execution.js:1678`）；
   - **必须同时定义** `launchContractDigest`（`launch-contract.js:104-136`，含 `model`）与 `sourceLaunchContractDigest`（`:1946/:1975-1976/:2003`）的血缘语义：新 digest 变化是预期的，但需明确哪些消费方（如 `workflow-child-permit.js:3-11` 的 `projectionDigest` 含 `launchContractDigest`）需要失效或重签；
   - 需明确 `recoveryDescriptor.model` 与新显式 model 冲突时谁胜，以及 descriptor 是否需要在 revive 后重写（`async-execution.js:1789`）。
4. **建议同时补的上游可观察面**：把 observed actual model 与 launch-selected model 分成两个字段（当前 `subagent-runner.js:1065` 用 `candidate ?? run.model` 把 observed 覆盖掉了），否则「换模型成功」在上游侧永远无法自证。

**范围声明**：以上是接口提议，不是本仓可实施项；实施需上游版本变更 + `src/compat/pi-subagents-0.75.ts` 兼容入口同步 + 完整验收（`packages/pi-subagents-enhanced/AGENTS.md`「Upstream 兼容边界」：版本固定 `0.75.0`，升级前必须同步兼容入口并完整验收）。

---

## 5. 可观察合同（criterion-3）

### 5.1 模型元数据四段：不得混用

| 段 | 定义 | 权威来源 | 禁止 |
|---|---|---|---|
| `requestedModel` | 调用方在 typed 工具参数里写的原始串（trim 后） | 本仓 `extension.ts:539`；回执 `details.modelSelection.requestedModel` | 不得填 selector 输出；不得填旧 run 工件值 |
| `resolvedModel` | 本仓 selector 解析出的 qualified `provider/id` | `model-selection.ts` `resolveModelSelection().model`；回执 `details.modelSelection.resolvedModel` | 不得声称是子代理实际模型（`extension.ts:117` 已明文：「requested 与 resolved 均不冒充子代理实际模型」） |
| `launchModel`（上游 `step.model`） | 上游 launch 选定串（含 thinking 后缀），每次 attempt 会更新 | `async-execution.js:907/:937/:1697`；`subagent-runner.js:2686-2695/:3537` | **不得**当作 observed actual；投影会剥 provider（`formatters.js:33-44`），不得据此断言 provider |
| `observedModel`（actual） | provider 响应中自报的模型 | child session `.jsonl` assistant message 的 `provider`/`model`（采集点 `run-child-session.js:401-410`）；usage 条目（`session-manager.d.ts:269`） | 不得用 `status.json` / `results/*.json` 的 `model` 冒充（`subagent-runner.js:1065` 已用 launch 值覆盖） |

**命名隔离规则**：本仓新增字段不得使用裸名 `requestedModel` 而不带命名空间，以免与上游 `step.requestedModel`（语义为「已解析的 launch override 串」，`model-resolution.js:337-355`）混淆。建议本仓回执统一置于 `details.modelSelection.*`（既有形状，`extension.ts:586-592`），并在需要引用上游值时显式命名为 `upstreamStepRequestedModel` / `upstreamStepLaunchModel`。

**无 resolved 就不报 resolved**：Option A/B 的拒绝路径**不产生** `resolvedModel`（selector 未运行或运行结果未被使用）。宁缺不造。若为了给出替代建议而运行 selector，必须把结果标注为「仅用于建议，未用于任何启动」，且不得写入 `modelSelection.resolvedModel`（该字段在本仓既有语义中表示「本次派发实际采用的解析结果」，见 spawn 成功回执 `extension.ts:978`（coding）与 `:1112`（generic））。

### 5.2 身份合同：run 身份 vs session 身份（依 §3.1）

- **旧 run 身份不变**：拒绝路径不创建、不修改、不 dismiss 任何 run；旧 run 的 `asyncDir`/`status.json`/`results`/process-terminal 证据链保持原状。
- **旧 session 身份不变**：不 `open`、不追加、不 fork、不重命名旧 canonical sessionFile；不取用、不释放、不使冲突其 revival lease。
- **新 run 身份**：Option A/B **不产生新 run**（这是与现状最大的可观察差异——现状是产生新 run 且以旧模型跑）。
- **若未来走真换模型（需上游）**：新 run 必须同时携带 `sourceRunId` 与 `sourceLaunchContractDigest`（上游 `:1885`、`:1946/:1975-1976/:2003` 已有），并**新增**显式的 `modelProvenance`（`requested` / `persisted-from-source-run` / `explicit-override`）以区分三种来源；本仓 `ResumedRunIdentity`（`recovery-resume-contract.ts:21/:104-110`）若需记录 model，必须走 **v2 合同**（`exactKeys` 严格，不能加可选字段）。

### 5.3 失败与回滚：零副作用证明面

拒绝必须满足以下全部可观察不变量（均可由 in-memory RPC double 断言，§6）：

1. `rpc.calls` 不增长（无 `resume`、无 `spawn`、无 `stop`、无 `status`）。
2. 回执 `isError === true`，`details.code` 为稳定枚举串，`details.keypath === "$.model"`。
3. 不调用 `supervisorControlPlane.*`（无 intent、无 receipt、无 `commitDelivery`、无补偿）。
4. 不调用 `titleRegistry.remember(...)`（`:1250-1259` 只在 `reply?.isError !== true` 时执行；拒绝路径根本不产生 reply）。
5. 不调用 workspace service / coordinator（无 lease、无 owner token 变更、无 resume intent、无 proof supersede）。
6. 不写任何 run 工件、不取 session lease、不产生 process-terminal candidate。
7. 幂等：同一 `toolCallId` 重复调用得到同一 `code`，无状态残留。

**回滚语义**：Option A/B 是 **pre-flight 拒绝**，因此不存在「已开始再回滚」的窗口——这是它相对「先 resume 再纠正」的根本优势。对照既有 spawn 侧回滚先例：`extension.ts:403` `stopSpawnedRunsBestEffort()` 是**尽力**语义（stop 失败仅记日志，不改变原失败错误）；resume 拒绝路径**不应**引入任何此类尽力回滚，因为没有已 spawn 的对象。

### 5.4 owner / lease / workspace 边界

- **session lease**：`session-lease.js:47-56`（`canonicalSessionFilePath` / `canonicalSessionId` = sha256(canonical path) / `sessionLeaseDir`），`:158-249` `acquireSessionLease`（4 次尝试 + stale-owner 回收 + `SessionLeaseConflictError(owner)`）。**全部在 runner 子进程内**（`subagent-runner-bootstrap.js:133`）。本仓 pre-flight 拒绝不涉及。
- **workspace owner**：`packages/pi-subagents-enhanced/AGENTS.md`「Workspace 所有权边界」——owner token 只存统一私有 ledger，agent 只消费公开 receipt 与 `leaseId`；`src/workspace/` 外禁止 worktree mutation，禁止第二套 ledger/owner token/disposition 状态机。任何 resume 相关设计**不得**新建第二套 resume 身份账本；既有 `recovery-resume-contract.ts` + `workspace/integration-queue.ts` + `coordinator-server.ts:414-443` 是唯一 resume 身份账本。
- **Auto Integration**：`publication=allowed` 的托管工作区由子代理 integration queue 自主拥有，父层 integrate 会返回 `CHILD_OWNS_INTEGRATION`（`extension.ts:117` 描述已明文）。Option C 会与此边界正面冲突（新 run 不是 queue 的 owner），这是不推荐它的独立理由。

### 5.5 RPC / direct SDK 适用范围

| 路径 | 是否可达 | model 行为 | 证据 |
|---|---|---|---|
| root 会话 → 本仓 typed `subagent` → RPC `resume` | **唯一 root 通路** | 静默丢弃（现状）/ Option A 显式拒绝 | `runtime-membrane.ts:175-189`（上游 `registerTool` 全拦、只放行 `subagent_supervisor`）、`extension.ts:1576-1590/:1657`、`rpc.js:423-440` |
| root 会话 → 上游直连 `subagent` 工具 | **不可达**（被 membrane 拦截，未注册） | 若可达则显式报错 | `subagent-executor.js:1553-1558`；`src/extension/index.js:640/:672`（上游注册 `name:"subagent"`） |
| child 会话（nested subagent，上游扩展被加载时） | **未验证** | 推断：直连路径可达 → 显式报错 | 推断依据：`registerRequiredChildExtensions`（`extension.ts:24/:1741-1750`）注册的是本仓 child 扩展；上游 `allowNestedSubagents` / `subagentOnlyExtensions` 决定是否加载上游扩展（`async-execution.js:894-911` `requiredExtensions` / `resolvePiLaunchToolPlan`）。**本轮未实证 child 会话内是否存在上游 `subagent` 工具，标记为未验证。** |
| SDK `pi.setModel` | 不适用 | 只改**当前**会话模型，不影响 detached child 进程 | `dist/core/extensions/types.d.ts:1259-1263`「Set the model for the current session without changing the configured default for new sessions」、`:1553` `SetModelHandler`、`:1618` |
| RPC `steer` + model | 不支持 | 静默丢弃 | `rpc.js:406-422`（白名单无 `model`） |
| RPC `manage` | 不适用 | 无 resume 管理动作 | `rpc.js:21-29/:350-374` |
| RPC `spawn` + `resume` | 上游显式拒绝 | — | `public-execution.js:123-124` |
| workflow `runs.run({resume, model})` | 静默忽略 model | — | `subagent-executor.js:4348-4404`；`scripted-workflow.js` 全文无 `model` |

### 5.6 无 model 时的兼容性（回归不变量）

- `model === undefined` 的 resume 必须**完全不受影响**：仍只校验 `message` 非空（`:1205-1207`），仍透传 `{id|runId|dir, index?, message, output?, outputMode?}`，仍在成功后做 `titleRegistry` 续接（`:1250-1259`）。
- 判定必须用 `input.model !== undefined`（或 `Object.hasOwn(input, "model")`），**不得**用 truthiness——空串已被 schema `minLength:1` + `pattern:".*\\S.*"` 挡在工具层外（`:61`），但 `executeControl` 也会被 headless 入口直接调用（`extension.ts:1791` `installHeadlessTypedSubagentRuntime`），不能假定 schema 已跑过。这与上游直连守卫用 `params.model !== undefined`（`:1553`）一致。
- 既有断言必须继续通过：`test/subagent-runtime-membrane.test.mjs:1405-1431`（resume 参数逐字段映射）、`test/subagent-dispatch-schema-security.test.mjs:70`（`{action:"resume", id, message}` 通过 schema）。

---

## 6. 测试矩阵与最小 fixture

> 本节只定义**矩阵与资源需求**，不实现任何测试（合同禁止改 test）。仓库规范禁止 TDD 方式；补测需用户明确授权（`pi/AGENTS_SHARED.md`）。

### 6.1 单元层（in-memory，零真实资源）

**最小 fixture（已存在，直接复用）**：`test/subagent-runtime-membrane.test.mjs`

- `:246-296` `createPi()`：最小 `ExtensionAPI` double（`registerTool` 收集到 `pi.tools`、`events`、`sendMessage`）。
- `:297-324` `createRpc(overrides)`：in-memory RPC double，`calls[]` 记录 `{method, params}`；`resume` 默认返回 `{text:"resumed"}`；可 override 成 `{text:..., details:{runId, asyncId}}` 以覆盖 titleRegistry 分支。
- 无需 provider、无需网络、无需真实 session/run 工件。

**矩阵 M1（Option A/B 的核心围栏）**

| # | 输入 | 期望 |
|---|---|---|
| M1-1 | `{action:"resume", id:"run-1", message:"continue", model:"provider/a"}` | `isError:true`；`details.code === "RESUME_MODEL_OVERRIDE_UNSUPPORTED"`；`details.keypath === "$.model"`；`rpc.calls.length === 0` |
| M1-2 | 同上但 `model` 为 qualified / 裸 id / 带 `:thinking` 后缀 三种形态 | 三者均拒绝（判定基于 `!== undefined`，不做值解析） |
| M1-3 | `{action:"resume", id:"run-1", message:"continue"}`（无 model 键） | `isError:false`；`rpc.calls.at(-1) === {method:"resume", params:{id:"run-1", message:"continue"}}`（回归不变量） |
| M1-4 | `{action:"resume", id:"run-1", model:"provider/a"}`（缺 message） | `INVALID_RESUME_MESSAGE` 优先或并列——**需明确定义校验顺序**；建议 message 校验在前（保持既有行为），model 校验紧随其后 |
| M1-5 | `{action:"resume", id:"run-1", message:"x", model:undefined}`（显式 undefined 键） | 与 M1-3 同（`undefined` 不算提供 override）；若采用 `Object.hasOwn` 判定则会拒绝 → **必须先定义判定语义再写测试** |
| M1-6 | `{action:"steer", runId:"run-1", message:"x", model:"provider/a"}` | 记录当前行为（steer 也静默丢弃 model，`rpc.js:406-422`）；**是否纳入同一拒绝属用户决策项 §8-4** |
| M1-7 | `{action:"status"/"interrupt"/"stop", id:"run-1", model:"provider/a"}` | 定义是否同样拒绝（status/interrupt/stop 的 model 无意义）；建议与 resume 同一门禁，避免只堵一个口子 |
| M1-8 | 拒绝路径的零副作用 | 断言 `supervisorControlPlane` double 的所有方法未被调用；`titleRegistry` double 的 `remember` 未被调用；`rpc.calls` 为空 |
| M1-9 | 幂等 | 同一 `toolCallId` 连续两次 M1-1 → 两次同 code，`rpc.calls` 仍为空 |

**矩阵 M2（契约文本与 schema）**

| # | 断言 | 位置 |
|---|---|---|
| M2-1 | `TYPED_SUBAGENT_DESCRIPTION` 含 resume 的 model 例外声明（一句即可） | `extension.ts:117` |
| M2-2 | schema 仍接受 `{action:"resume", id, message, model}`（**不在 schema 层拒绝**，因为顶层 `model` 是 spawn 共用属性；拒绝属 runtime 路由职责） | `test/subagent-dispatch-schema-security.test.mjs:66-72` 同型 |
| M2-3 | 若决定改为 schema 层拒绝：需验证不会破坏 spawn 分支（顶层单一 object 无 union 组合子，`extension.ts:49-52` 注释记载 glm/zai 空 tool args 缺陷），**风险高，不推荐** | — |

**矩阵 M3（模型元数据不混用）**

| # | 断言 |
|---|---|
| M3-1 | 拒绝回执中**不出现** `resolvedModel` / `actualModel` / `launchModel` 字段（宁缺不造） |
| M3-2 | 若回执含 `requestedModel`，其值必须逐字等于调用方原参 trim 后结果，且位于 `details.modelSelection.*` 或 `details.detail.*` 命名空间下 |
| M3-3 | spawn 路径既有 `modelSelection` 三字段形状不变（`extension.ts:586-592`、`:978`、`:1112`）——防回归 |

### 6.2 合同层（in-memory + 临时目录）

| # | 断言 | 资源 |
|---|---|---|
| M4-1 | `ResumedRunIdentity` 仍为 `exactKeys(["runId","asyncDir","sessionId","pid","agentProfile"])`，加入任何 model 字段必须抛 `TypeError`（守住「不偷偷扩合同」） | `test/recovery-resume-contract.test.mjs:152-192` 同型；临时目录 |
| M4-2 | `recovery.activate-resume` 在 resume 被拒后**不会**被调用；intent 状态机无迁移 | `workspace/coordinator-server.ts:414-443` double |

### 6.3 集成层（真实资源；**需用户显式授权与额度**）

| # | 目标 | 资源需求 | 备注 |
|---|---|---|---|
| M5-1 | 端到端验证「resume+model 被拒且不产生新 run」 | 真实 Host（`@earendil-works/pi-coding-agent@1.0.4`，`src/host-runtime/index.ts:6-19` 校验物理 Host 与 peer 版本）+ 一个可失败的 child run | 需要一个能确定性失败的 child；可用 `test/fixtures/recovery-resume/scripted-model-server.mjs`（确定性 openai-completions fake server，`fake/deterministic`）避免付费网络 |
| M5-2 | 验证 observed actual model 与 launch model 的区分 | 同上 + 读 child session `.jsonl` | **本调研未执行**（合同禁止读 session 正文）；实施时需用户单独授权 |
| M5-3 | 验证「fresh spawn 换模型可用」替代路径 | 真实 provider 或 scripted server | bug record §1 步骤 4 已用真实 provider 实证；复现需付费网络与用户授权 |
| M5-4 | 上游扩展后的验收（仅当 §8-2 授权） | 上游新版本 + `src/compat/pi-subagents-0.75.ts` 同步 + 全量验收 | `packages/pi-subagents-enhanced/AGENTS.md`「Upstream 兼容边界」要求 |

### 6.4 明确不做的测试

- 不为「上游静默丢弃 model」这一**上游设计行为**写 production 兼容分支或 fallback（`AGENTS.md`「缺陷数据来源分类门禁」第 1 类：按生产缺陷处理，最小修复；不得加防御性兼容）。
- 不构造手工拼装的 `recovery-descriptor.json` / `status.json` fixture 去驱动 revive 换模型——那是「测试制造的非预期数据」（门禁第 2 类），且等同伪造恢复证据。
- 不用 deterministic/fake model 代替 coding child 去声称真实验收（`packages/pi-subagents-enhanced/AGENTS.md`「T9 acceptance probe」明令禁止）。

---

## 7. 最小写路径

**本文件**：`docs/research/2026-10-14-subagent-resume-model-override-design.md`（唯一授权写路径，已使用）。

**若后续授权实施 Option A/B（本文不实施）**，最小写路径为：

| 路径 | 改动性质 | 规模 |
|---|---|---|
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | `executeControl` resume 分支加一条 pre-flight 拒绝（紧邻 `:1205-1207`）；`TYPED_SUBAGENT_DESCRIPTION`（`:117`）补一句 | 约 5-12 行 |
| `test/subagent-runtime-membrane.test.mjs` | 扩展既有 `:1405-1431` 用例或新增一个同型 `test()`，复用 `createPi()`/`createRpc()` | 约 20-40 行 |

**明确不在最小写路径内**（任何一项都需单独授权）：

- `packages/pi-subagents-enhanced/node_modules/**`（上游，禁改）
- `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts`（仅在升级上游版本时同步）
- `packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`（selector 语义不变）
- `packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-contract.ts`（v1 合同不动；如需 model 字段必须 v2）
- `packages/pi-subagents-enhanced/src/workspace/**`（owner/lease/ledger 不动）
- `packages/pi-subagents-enhanced/src/tui/**`（本缺陷不是展示问题；`AGENTS.md`「TUI 精简边界」禁止为展示改写 payload）
- `docs/bugs/2026-10-14-subagent-resume-model-override.md`（§3 更正由父层统一处理，主管裁定方案 A）
- `pi/settings.json` / `pi/models.json`（per-machine 配置，禁提交/禁改）

---

## 8. 需用户决策的事项

| # | 决策项 | 选项 | 本文建议 | 影响 |
|---|---|---|---|---|
| **1** | **支持范围**：`resume` 是否应支持换模型？ | (a) 不支持，只修契约信号（显式拒绝）；(b) 支持换模型（需上游改动） | **(a)**。(b) 与上游明文设计冲突（`tool-reference.md:178`、`CHANGELOG.md:1332`），牵动 launch contract digest / capability ceiling / recovery descriptor / permit digest 四条链（§4.5），远超最小修复 | 决定后续是「本仓 5-12 行」还是「上游多处 + 版本升级 + 全量验收」 |
| **2** | **上游修改授权**：是否授权向上游提交 issue/PR，或升级到已修复版本？ | (a) 不授权，仅本仓围栏；(b) 授权提 issue（不改代码）；(c) 授权升级/patch 上游 | **(a) 或 (b)**。本仓 `AGENTS.md` 固定 `pi-subagents@0.75.0`，升级必须同步兼容入口并完整验收；**禁止** patch `node_modules` 或 fork | 决定 §4.5 是提议还是排期项 |
| **3** | **拒绝语义**：hard error 还是 warning + 继续以旧模型续跑？ | (a) `isError:true` 硬拒绝；(b) 过滤 model 后继续，在 `details.warnings` 注入说明 | **(a)**。理由：(b) 仍产生一个调用方未同意其模型的新 run，与「不混用 requested/resolved/actual」冲突；(a) 与上游直连守卫（`subagent-executor.js:1553-1558`）语义一致，且零副作用可证 | 决定回执形状与 M1 矩阵期望值 |
| **4** | **门禁覆盖面**：只堵 `resume`，还是同时堵 `steer` / `status` / `interrupt` / `stop` 上的无意义 `model`？ | (a) 仅 resume；(b) 所有 control action | **(b)**，但需分优先级：`resume`/`steer` 会让调用方形成「已生效」误判（`rpc.js:406-422` 同样静默丢弃），`status`/`interrupt`/`stop` 属纯噪声 | 决定 M1-6/M1-7 期望值与改动规模 |
| **5** | **child 会话范围**：nested child 内的直连 `subagent`（若存在）是否纳入同一契约？ | (a) 纳入；(b) 本轮不处理，仅记录未验证 | **(b)**，先补实证（§5.5 表中标记为未验证） | 决定是否需要 child 侧围栏 |
| **6** | **补测授权**：是否授权按 §6 矩阵补测试？ | (a) 授权 M1-M4（in-memory/临时目录）；(b) 同时授权 M5（真实 Host/网络） | **(a)**；M5-3 涉及付费网络，需单独授权 | 仓库规范禁止 TDD，补测需明确授权 |
| **7** | **bug record 更正落盘**：§3 的两处更正由谁落盘？ | (a) 父层统一更正（主管已选）；(b) 扩 writePaths 由本 agent 追加 | **(a)**（主管裁定方案 A，本文仅在本文件记录） | 决定是否需要扩 writePaths |

---

## 9. 证据索引

### 9.1 本仓（`packages/pi-subagents-enhanced/`）

```
src/subagent-dispatch/extension.ts
  :54-113    TYPED_SUBAGENT_PARAMETERS（:61 model、:107 action enum）
  :117       TYPED_SUBAGENT_DESCRIPTION（resume 文案；modelSelection 语义声明）
  :241-253   failure(code, message, detail, keypath)
  :255-261   rpcResult(reply)（details 原样透传）
  :403       stopSpawnedRunsBestEffort（spawn 侧尽力回滚先例）
  :538-582   resolveSpawnModel（唯一 selector 入口）
  :586-596   modelSelectionDetails / modelSelectionWarningText
  :802       executeCoding → resolveSpawnModel
  :978       coding spawn 成功回执 details.modelSelection
  :1017      executeGeneric → resolveSpawnModel
  :1112      generic spawn 成功回执 details.modelSelection
  :1174-1259 executeControl（:1205-1207 resume message 校验、:1208 解构、:1209+ steer 控制面、:1238 steer 内 rpc[action]、:1249 rpc[action]、:1250-1259 titleRegistry 续接）
  :1576-1590 typed 工具定义（name "subagent"、exposure "model-only"）
  :1612-1624 action→control / writePaths→coding / 其余→generic 路由
  :1657-1658 pi.registerTool
  :1741-1750 registerRequiredChildExtensions（本仓 child 扩展）
  :1791      installHeadlessTypedSubagentRuntime
src/subagent-dispatch/rpc-client.ts
  :3-4       REQUEST_CHANNEL / REPLY_PREFIX
  :19        CONTROL_METHODS（含 resume）
  :199-283   call()（:276 events.emit）
  :299-301   resume(params) → call("resume", params)
src/subagent-dispatch/execution.ts        全文：只有 spawn adapter，无 resume
src/subagent-dispatch/model-selection.ts  assertDispatchModelApi / resolveModelCandidates / resolveModelSelection / ModelSelectionError
src/subagent-dispatch/runtime-membrane.ts
  :1-4       ALLOWED_REGISTRATIONS / SUPERVISOR_TOOL_NAME
  :175-186   registerTool 拦截（只放行 subagent_supervisor）
  :187-189   getAllTools 过滤
src/subagent-dispatch/runtime-state.ts    runtimeFromStatus（status→控制面身份；消费 asyncSnapshot.runs）
src/subagent-dispatch/recovery-resume-contract.ts
  :21        RESUMED_RUN_KEYS
  :88-93     exactKeys
  :104-110   parseResumedRun
  :48/:179/:193/:214  requiredAction "resume-child"
src/subagent-dispatch/workflow-spawn.ts   childControls()（白名单含 model/thinking）、buildWorkflowSpawn（runs.run 脚本）
src/workspace/coordinator-server.ts:414-443   recovery.activate-resume（intent→workspace rebind→queue rebind→proof supersede）
src/workspace/integration-queue.ts:102-232    resume intent ledger
src/tui/session-browser.ts:143-156,:180       readBrowserRunStatus / adjacentFacadeLeafStep（读 asyncDir/status.json 的既有先例）
extensions/subagent-runtime.ts:310-340        installHeadlessTypedSubagentRuntime（bootstrap: upstreamSubagentRuntime）
src/compat/pi-subagents-0.75.ts               唯一深层 import 兼容入口
src/host-runtime/index.ts:6-19                resolvePhysicalHost（Host/peer 版本校验）
AGENTS.md                                     Upstream 兼容边界 / Workspace 所有权边界 / T9 acceptance probe
```

### 9.2 上游 `pi-subagents@0.75.0`（`packages/pi-subagents-enhanced/node_modules/pi-subagents/`）

```
src/extension/rpc.js
  :17-20     事件通道常量、SUBAGENT_RPC_METHODS
  :21-29     SUBAGENT_RPC_MANAGEMENT_ACTIONS（全为 schedule.*）
  :232-239   assertSubagentParams
  :246-257   dataFromToolResult / failIfToolError
  :258-271   normalizeTargetParamsFromRecord / normalizeTargetParams（只留 id/runId/dir/index）
  :343-349   executeChecked
  :350-374   manageParams
  :375-404   spawnParams（保留 model）
  :406-422   steerParams（白名单无 model）
  :423-440   resumeParams ★首偏离点
  :589-621   manage/status 分派
  :632-633   resume 分派
src/extension/schemas.js:246            model 无条件可选（无 action 约束）
src/extension/public-execution.js:108-124  baseRef 限制；顶层 resume 执行参数被拒
src/extension/index.js:640,:672         上游注册 name:"subagent"
src/runs/foreground/subagent-executor.js
  :1572      resolveRequestedResumeTarget 调用点
  :1553-1558 直连守卫：resume 不接受 model override ★
  :1791-1794 revivalSessionFile = target.sessionFile
  :1821      runId = randomUUID()（revive 新 run 身份；:1856 asyncDir）
  :1855-1935 revive → executeAsyncSingle 参数块
  :1881      sessionFile
  :1882-1887 revivalLease{sessionFile, runId, sourceRunId, parentSessionId?}
  :1889      modelOverride: recoveryDescriptor?.model ?? target.model ★旧模型回填
  :1891-1894 modelOverrideFromParent / modelOrigin / thinkingOverride / thinkingCeiling
  :1928      capabilityCeiling 交集（revive）
  :1946,:1975-1976,:2003  sourceLaunchContractDigest
  :3062-3075 fresh spawn：resolveModelOrigin + resolveEffectiveSubagentModel(params.model, …) ★可换模型
  :3098      sessionFile: sessionFileForTask(…, modelOverride, modelOverrideFromParent, modelOrigin)
  :3496-3501 前台单 spawn 同上
  :4348-4404 prepareWorkflowLaunchParams 的 resume 白名单（无 model，且不抛错）★
  :6506-6512 action==="resume" → resumeAsyncRun
  :7028-7041 sessionDirForIndex / childSessionFileForTask（fresh spawn 的 session 路径）
  :7151      capabilityCeiling 交集（spawn）
src/runs/background/async-resume.js
  :251-255   asyncReviveRequiresRecoveryDescriptor
  :263-300   readAsyncRecoveryDescriptor + allowedFields 严格白名单 ★禁改
  :325-345   descriptor 字段校验（modelOrigin / modelOverrideFromParent）
  :476-632   resolveAsyncResumeTarget
  :591-597   sessionFile / stepModel 来源（旧工件）
  :607-627   target 构造（:618 sessionFile、:619 model、:620 thinking、:621 launchContractDigest、:624 capabilityCeiling、:626 recoveryDescriptor）
  :629-656   applySteeringRecoveryAgentConfig
  :658-671   buildRevivedAsyncTask（revive prompt 文本形态）
src/runs/background/async-execution.js
  :1596-1608 modelOrigin / primaryModel（explicitModel: params.modelOverride）★
  :1668-1680 resolveModelSelection + assertThinkingWithinCeiling
  :1697,:1710,:1745  model: selectedModel
  :1707-1735 resolveLaunchBinding / launchContractDigest
  :894-911   requiredExtensions / resolvePiLaunchToolPlan（child 工具与扩展集）
  :1684      single-run requiredExtensions
  :1789      writePrivateAtomicJson(asyncDir/recovery-descriptor.json) ★上游私有
  :1818-1825 step.model / step.requestedModel 写入
src/runs/background/async-status.js:196-250,:300-323   status 投影（:232 step.model、:237 requestedModel、:238 sessionFile）
src/runs/shared/async-status-projection.js:509-516      modelThinking 显示串（已去 provider）
src/runs/background/run-status.js:351-520               inspectSubagentStatus（details 仅 {mode, results}）
src/runs/shared/model-resolution.js
  :9-19      formatSubagentModelVerificationError(expected, observed, …)
  :285-313   resolveSubagentModelOverride
  :315-321   resolveEffectiveSubagentModel
  :322-331   resolveModelOrigin
  :337-355   resolveModelSelection（requestedModel = 已解析 override，非调用方原参）★命名冲突源
src/runs/shared/launch-contract.js:104-136              launchBindingDigest（含 model）
src/runs/shared/workflow-child-permit.js:3-11,:19-33    projectionDigest 含 launchContractDigest
src/runs/shared/child-launch.js:64-71,:215-216          childStorage → {kind:"file", sessionFile}；model 传递
src/runs/shared/child-session.js:406-419                SessionManager.open(sessionFile) + resolveCliModel + createAgentSession ★核心 session 加载
src/runs/shared/session-lease.js
  :8-14      SessionLeaseConflictError
  :47-56     canonicalSessionFilePath / canonicalSessionId / sessionLeaseDir
  :58-70     inspectSessionLease
  :158-249   acquireSessionLease（4 次尝试、stale 回收、冲突抛错）
src/runs/background/subagent-runner-bootstrap.js
  :102-120   runConfiguredSubagent；releaseOnExit（process.once("exit")）
  :132-148   acquireSessionLease(config.revivalLease) + 启动握手（ready→ack→confirm→proceed）
  :204-213   lease.release()
src/runs/background/process-terminal.js:43-49           leaseDisposition / canonicalSessionLeaseReleased
src/runs/background/process-terminal-candidate.js:67-95 revivalLeaseToken 校验/确认
src/runs/background/run-child-session.js
  :401-410   observed model 采集（event.message.model）+ 期望/实测比对 ★actual 唯一来源
  :505-535   child session result（:520 model）
src/runs/background/subagent-runner.js
  :785       candidate = step.model（launch-selected）
  :808       expectedModelForVerification
  :1065      finalResult.model = candidate ?? run.model ★launch 覆盖 observed
  :2686-2695 updateStepModel（每 attempt 更新）
  :3537-3539,:3966-3967  status.steps[].model 回写
src/shared/formatters.js:33-44                          formatModelThinking（剥 provider）
docs/tool-reference.md:178,:350,:355,:356               stored model 设计 / revive 语义 / 独占 lease
CHANGELOG.md:1332                                       "without changing its stored agent, model, or tool contract"
```

### 9.3 SDK `@earendil-works/pi-coding-agent@1.0.4`（根 `node_modules/`）

```
dist/core/sdk.js:87-99                     显式 options.model 优先；!model 时才 getBranchSelection 还原 ★
dist/core/virtual-models.js:29-52          getBranchSelection（最后一条 physical assistant response 优先）
dist/core/agent-session.js:295-306,:1380   _recordSelection（仅虚拟模型场景追加 model_change）
dist/core/session-manager.d.ts
  :31-34   ModelChangeEntry
  :267     appendModelChange
  :269     appendUsage(kind, provider, model, usage, note)
  :371/:378/:386  static create / open / inMemory
dist/core/model-runtime.d.ts               ModelRuntime（getModel / getAvailable / resolveModel / registerVirtualModel）
dist/core/model-registry.d.ts              ModelRegistry 同步 facade（getAvailable / find / hasConfiguredAuth）
dist/core/extensions/types.d.ts
  :225     ctx.modelRegistry
  :1259-1263  pi.setModel（仅当前会话）
  :1553/:1618 SetModelHandler / ExtensionActions.setModel
docs/models.md:35                          "A session records model and thinking-level changes. Resuming the session restores them…"
```

### 9.4 既有测试与 fixture

```
test/subagent-runtime-membrane.test.mjs
  :246-296   createPi()（最小 ExtensionAPI double）
  :297-324   createRpc()（in-memory RPC double，calls[] 记录）
  :1405-1431 "maps approved control actions to RPC and requires a resume instruction"
             （resume 逐字段映射；INVALID_RESUME_MESSAGE 不到达 RPC）★M1 复用基座
test/subagent-dispatch-schema-security.test.mjs
  :23-38     model 字段接受/拒绝（含 retired modelTier）
  :66-72     三分支扁平 schema；:70 {action:"resume", id, message} 通过
test/recovery-resume-contract.test.mjs:47-192   intent/activation 合同（含 resumedRun 严格字段）
test/subagent-lifecycle-contract.test.mjs:12-31 source/resumed 双轨身份、fail-closed
test/subagent-model-selection.test.mjs / .integration.mjs / test/subagent-model-candidates.test.mjs
test/fixtures/recovery-resume/scripted-model-server.mjs   确定性 fake model server（fake/deterministic），可用于 M5-1 免付费网络
test/subagent-compact-rendering.test.mjs:175              resume 回执渲染 fixture
```

---

## 10. 残留风险与未验证项

1. **child 会话直连路径未实证**（§5.5）：nested child 内是否存在上游 `subagent` 工具（从而可达 `subagent-executor.js:1553-1558` 显式守卫）本轮未验证。需实证后再决定 §8-5。
2. **observed actual model 未在本调研中读取**：合同禁止读 session 正文，故 §3.2 的结论完全来自源码路径分析（`run-child-session.js:401-410` → `subagent-runner.js:1065`），未用真实 run 工件交叉验证。bug record §6 的 4 个 run 工件已被 retention 清理，无法补验。
3. **bug record §1 步骤 3 的 `gpt-6.1-sol` 归属**：按 §3.2，该串是 launch-selected（去 provider）。它是「旧模型」还是「旧模型的某次 attempt 模型」无法区分（`updateStepModel` 每 attempt 更新，`subagent-runner.js:2686-2695`）。不影响首偏离点结论。
4. **`resumeParams` 白名单的其他静默丢弃字段**：本轮只核查了 `model`。`thinking`/`agent`/`acceptance`/`capabilityCeiling`/`worktree`/`baseRef`/`timeoutMs`/`toolBudget` 等在 RPC resume 上同样会被丢弃（同一白名单），但上游 revive 会从 descriptor/target 回填其中若干（`:1893-1930`）。**未逐字段核查其契约一致性**，可能存在同类未登记的静默不一致。
5. **`steer` 同类缺陷未登记**：`rpc.js:406-422` 白名单同样不含 `model`，且本仓 steer 走 supervisor 控制面（`extension.ts:1209-1247`）后仍原样透传 `params`（`:1238` `rpc[action](params)`）。是否需要独立 bug 记录由父层决定。
6. **上游版本漂移风险**：所有上游行号锚定 `0.75.0`。`AGENTS.md` 要求升级前同步 `src/compat/pi-subagents-0.75.ts` 并完整验收；升级会使本文行号全部失效。
7. **本仓工作区 dirty**：`extension.ts` 等文件在工作区有既存未提交改动，本文引用的本仓行号以**当前工作区内容**为准（非 HEAD 提交态）。若父层回滚这些改动，行号需重新核对。
8. **未运行任何测试**：§6 矩阵全部为设计，未执行；`commandsRun` 仅含只读检索命令。
