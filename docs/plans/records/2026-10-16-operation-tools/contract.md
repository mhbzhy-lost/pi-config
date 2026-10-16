# S0 合同：冻结现有每操作字段、调用者与字节基线

- 任务：dispatch-7fc486c1（contract SHA-256 7fc486c176f6402227f4b76d0a111a08badfd16fc9a849071983363a29510af4）
- 计划：`docs/plans/2026-10-16-subagent-operation-tools-guidance.md`（首审修订版 afa5c64；先前作为父 dirty 的 +2 行「执行授权」已由父提交为 `2db3696`，本任务未改计划正文）
- 全部证据来自本仓源码与只读上游 `packages/pi-subagents-enhanced/node_modules/pi-subagents@0.75.0`（仅读，不 deep import、不修改）。未读 settings/models/auth/备份/session/authority/state。未 stage/commit/push。未跑 npm/test/tsc/Host/网络/kill。无 TDD。
- 术语：**现支持** = 本仓 schema 声明且执行链真实消费；**runtime-only** = 上游消费但本仓 schema 未声明（模型今天发不出）；**未证** = 标 unknown，不猜。

## 0. 现场基线（事实，非假设）

| 项 | 现场值 | 证据 |
| --- | --- | --- |
| HEAD（交付时点） | `2db3696 docs(subagent): 记录独立工具计划执行授权`（父在 S0 运行期间提交，仅 +2 行计划授权文本）；S0 起始 HEAD 为 `ee8eb1a fix(deps): 固定Pi兼容的codemode依赖` | `git log --oneline -3` |
| codemode 声明 | root `package.json` `overrides.@earendil-works/pi-codemode = 1.0.4`；package `overrides` 同值 | root `package.json`、`packages/pi-subagents-enhanced/package.json` |
| codemode 物理 | `node_modules/@earendil-works/pi-codemode` 实为 **1.1.0**（未重装；无嵌套 1.0.4 副本） | 读两处 `package.json` version |
| 结论 | lock/override 声明 **不等于** 物理 Host 事实；S6 需 fresh Host 复核 | 上行 |
| Node | v26.8.1（>=22.19.0） | `node -v` |
| supervisor gate 兄弟计划 | 仅 B 已发布（`357bade`，`docs/plans/records/2026-10-15-supervisor-gate/baseline.json`）；G0 run 258e05ae 进行中；`supervisor-gate-policy.ts`/`supervisor-upstream-observer.ts`/`supervisor-recovery-tools.ts` 在 HEAD **不存在** | baseline.json `scopeNotStarted.planCreateTargetsAbsent` + 现场 `ls` |
| gate 工具名 | `subagent_supervisor_inspect`/`_clear` 只出现在两份计划文本，`src/` 零命中 | grep 现场 |
| **S4 前置未 ready** | 是（G2/C3 未实现）。S1/S2/S3 不受阻（纯新文件 factory） | 本节 |

## 1. 当前模型注册面（fresh Host main，注册顺序即测试位置依赖）

| 注册名 | 定义位置 | parameters | description | exposure |
| --- | --- | --- | --- | --- |
| `subagent` | `src/subagent-dispatch/extension.ts:1861` | `TYPED_SUBAGENT_PARAMETERS`（`extension.ts:62`） | `TYPED_SUBAGENT_DESCRIPTION`（`extension.ts:125`） | `model-only`（`1862`） |
| `subagent_worktree` | `src/workspace/tool.ts:60`（factory `createSubagentWorkspaceTool`） | `SUBAGENT_WORKSPACE_PARAMETERS`（`tool.ts:26`，顶层 `anyOf` 四支） | `SUBAGENT_WORKSPACE_DESCRIPTION`（`tool.ts:27-33`） | `model-only`（`61`） |
| `subagent_supervisor` | `src/subagent-dispatch/supervisor-adapter.ts:43`（`createSupervisorTool` 默认 name） | `SUPERVISOR_PARAMETERS`（`supervisor-adapter.ts:1-11`） | `SUPERVISOR_DESCRIPTION`（`supervisor-adapter.ts:13`） | `model-only`（`58`） |

- 唯一注册点：`pi.registerTool(tool)` `extension.ts:1952`、`pi.registerTool(workspaceTool)` `1953`、`if (supervisorTool) pi.registerTool(supervisorTool)` `1985`。`supervisorTool` 仅在 `controlledSupervisorAdapter` 存在时创建（`1944-1947`）。
- 工厂返回值：`Object.freeze({ tool, workspaceTool, supervisorTool, executeSupervisor, dispose, ready })`（`extension.ts:2083`）；`executeSupervisor`（`2082`）是 Host 侧第三入口，S4 需一并核。
- child 面另有 `subagent_integration`（`child-extensions/integration-queue.ts:136`）与 `submit_acceptance_evidence`（`child-extensions/acceptance-evidence.ts:29`）：**不属于本 14 工具**，S1–S5 不得改名或重复注册。
- child 不扩权（现证）：`extensions/subagent-runtime.ts:208` 对 `PI_SUBAGENT_CHILD=1` / `PI_SUBAGENT_FANOUT_CHILD=1` 直接 `return`（main-only 工具面在 child 进程根本不注册）；三个定义全部 `exposure:"model-only"`；`registerRequiredChildExtensions`（`extension.ts:2035-2047`）只注入 `{id,path}`（`root-session-owner`、`integration-queue`、可选 shared），不注入新模型工具。S1/S2/S3/S4 不得改变这三条。

## 2. 新工具目录：14 项精确字段（S1/S2/S3 可直接消费）

命名严格照计划 §2.1，不新增 alias、不加第 15 项。所有新 schema 根为单 `type:"object"` + `additionalProperties:false`，**不用 union/allOf/oneOf/anyOf（顶层）/if-then**（对齐 `test/subagent-dispatch-schema-security.test.mjs:53-60` 的 root-no-combinator 断言，原因见 `docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md`）。所有新工具 `exposure:"model-only"`。

### 2.1 subagent 面（7 项，S1）

| 工具 | required | optional | 明确不支持（发即 Host 层拒 / 不写进 schema） |
| --- | --- | --- | --- |
| `subagent_roster` | — | — | `action`、`id`、`runId`、`dir`、`index`、`message` 及全部启动字段 |
| `subagent_start` | `agent`、`task` | `title`、`model`、`thinkingLevel`、`worktree`、`cwd`、`writePaths`、`acceptance`、`output`、`outputMode`、`outputSchema`、`artifacts`、`progress`、`skill`、`reads` | `action`、`id`、`runId`、`dir`、`index`、`message`；`timeoutMs`、`version`（runtime 已 fail-closed） |
| `subagent_run_status` | — | `id`、`runId`、`dir`、`index` | `action`、`message`、`view`、`lines`（见 §5.1）、`model`、`childId`（见 §5.3） |
| `subagent_run_steer` | `message`（非空） | `id`、`runId`、`dir`、`index` | `action`、`mode`（见 §5.2）、`model`、`view`/`lines`/`childId` |
| `subagent_run_interrupt` | — | `id`、`runId`、`dir`、`index` | `action`、`message`、`view`/`lines`/`childId`/`mode` |
| `subagent_run_resume` | `message`（非空） | `id`、`runId`、`dir`、`index`、`output`、`outputMode`（仅file-only；父层裁决保留既有可达行为，见 §5.4） | `action`、`model`（现被 resume 静默丢弃，**不得实现换模**）、`view`/`lines`/`childId` |
| `subagent_run_stop` | — | `id`、`runId`、`dir`、`index` | `action`、`message`、`childId`（见 §5.3）、`view`/`lines` |

字段消费证据（`executeControl`，`extension.ts:1427-1513`）：
- 允许集合 `CONTROL_ACTIONS = {status,steer,interrupt,resume,stop,list}`（`extension.ts:36`）；集合外 → `UNSUPPORTED_ACTION`（`1429-1431`）。
- `list` 早返回（`1432-1456`）：只调 `discover(ctx.cwd,"both",ctx.model?.provider)`，按 `admission` 过滤 `.agents` 路径（`1437-1441`），content 输出 `[{name, frontmatter?}]`，`details.agents` 保 name/description/model/models/tools/metadata → `subagent_roster` 的空参数成立。
- `resume` 前置于 RPC 的非空消息校验：`INVALID_RESUME_MESSAGE` + `keypath="$.message"`（`1458-1460`）。
- `const { action, ...params } = input;`（`1461`）后整包透传 `rpc[action](params)`（`1499` steer 分支、`1502` 其它）→ 今天除 `action` 外的任何扁平字段都会进 RPC，因此分工具 schema 的字段隔离是新的收缩面，必须在 factory 侧 fail closed（S1 要求「不透传调用方 action」）。
- `steer` 是唯一经过 control resolver 的 action：`canonicalSteerTarget`（`1379-1395`）拒绝 `dir`（`SUPERVISOR_STEER_TARGET_ALIAS`）、空/非串（`_INVALID`）、`id`≠`runId`（`_CONFLICT`）、无法定位（`_UNRESOLVED`）、前缀歧义（`_AMBIGUOUS`）；仅 owner 三态与 `unowned` 判定后才 `resolveSupervisorControl`+`rpc.steer`+`commitDelivery`（`1462-1500`）。**control resolver 仅 steer 适用**；status/interrupt/resume/stop 不加该约束、也不得套用。
- `resume` 成功后的 titleRegistry 迁移只读公开 `details.runId/asyncId`（`1503-1511`）——S1 不得改此行为。
- start 侧：路由 `Object.hasOwn(input,"action")→control`（`1892-1896`）、`isCodingDispatch = 有 writePaths`（`src/contracts/dispatch-ir.ts:76`）、其余 generic；`executeGeneric` 要求 `agent`+`task` 非空否则 `INVALID_GENERIC_DISPATCH`（`1239-1248`）；`title` 缺省 `task.slice(0,50)` 经 `normalizeSubagentTitle`（`1250`）；`thinkingLevel` 不进合同只作 `child.thinking`（`1014-1019`、`629`）；`genericWorkflowSpawnParams` 精确取 `model,output,outputMode,outputSchema,skill,reads,progress,acceptance` + `context ?? "fresh"`、`artifacts ?? true`（`624-641`）；`compileDispatchIR` 的 `PUBLIC_KEYS` 白名单（`dispatch-ir.ts:13-16`）与未知字段 `INVALID_CONTRACT`（`:82`）、`timeoutMs` 禁（`:85`）、`version` → `DEPRECATED_SCHEMA`（`:80`）、coding 条件必填 `writePaths≥1`+`acceptance.criteria≥1`（`:91-94`）、`acceptance` 无 `writePaths` → `CODING_FIELD_WITHOUT_WRITE_PATHS`（`:84`）→ **`subagent_start` 的 acceptance 条件必填保留原 typed 编译器权威，schema 不加 if/then**。

### 2.2 workspace 面（4 项，S2）

| 工具 | required | optional | 不支持 |
| --- | --- | --- | --- |
| `managed_workspace_list` | — | — | `action`、`workspace_id`、`runId`（`service.listOwned` 支持 `runId`（`src/workspace/service.ts:658`）但现工具未暴露，S2 不扩） |
| `managed_workspace_status` | `workspace_id` | — | `action`、`disposition`/`strategy`/`action_token` |
| `managed_workspace_dispose` | `workspace_id`、`disposition`、`action_token` | `strategy`（`cherry-pick`\|`merge`，缺省 `cherry-pick`） | `action`、`reason`、`owner`/`rootSessionId`/`kind` |
| `managed_workspace_release` | `workspace_id` | — | `action`、`disposition`/`strategy`/`action_token` |

- 复用而非复制：四工具 execute 必须落到 `createSubagentWorkspaceTool` 的同一唯一 execute 闭包（`src/workspace/tool.ts:59-104`）——`resolveRootSessionId(ctx.sessionManager)`（`72-73`）→ `ownerScope={kind:"standalone-subagent",rootSessionId}`（`75`，模型不得填）→ `service(ownerScope)`（`76`）→ `listOwned/statusOwned(+active 时 issueOwnedDisposition)/disposeOwned/releaseOwned`（`79-97`）。
- `strategy` 条件由 runtime 裁决：`INVALID_WORKSPACE_STRATEGY`（`tool.ts:89`）。现 `WORKSPACE_DISPOSE_SCHEMA` 的顶层 `allOf`（`tool.ts:18`）在 S2 **移除**；同时保留 `CHILD_OWNS_INTEGRATION` 显式捕获（`93-94`）与 `allowedActionsFor` 状态权威（`src/workspace/ledger.ts:53-64`：`reserved/allocating/released=[]`、`active=[status,dispose]`、`disposing=[dispose]`、`preserved/cleanup-debt=[release]`）。这是明确的 schema 早拒降级而非 runtime 放宽，S2 测试须同时证明 guard 仍在。
- 公开投影字段（S2 不得改语义）：`workspacePublic()`（`tool.ts:41-56`）输出 `workspace_id/state/workspace_state/lease_id/process_terminal/dispatch_cwd?/allowed_dispositions?/action_token?/integrate_blocked_reasons?`；`action_token` 仅在 `state==="active"` 且 `allowed_dispositions` 非空且实有 token 时出现。
- `disposition` 枚举 `integrate|discard|preserve`（`tool.ts:16`），`preserve` 的 `reason` 由 runtime 注入（`91`），不暴露为模型字段。
- `disposeOwned` 缺 token 会由 service 的 owner/CAS 门禁拒（`src/workspace/service.ts:600+`）；package 边界规范要求工具不得替代该门禁（`packages/pi-subagents-enhanced/AGENTS.md`「Workspace 所有权边界」）。

### 2.3 supervisor 面（3 项，S3）

| 工具 | required | optional | 不支持（现证） |
| --- | --- | --- | --- |
| `supervisor_request_pending` | — | — | `action`、`to`、`replyTo`、`message`（native pending 分支完全不读这些字段） |
| `supervisor_request_status` | — | `replyTo` | `action`、`to`、`message`（status 分支不消费 `to`/`message`） |
| `supervisor_request_reply` | `replyTo`、`message` | `to`（条件性，见下） | `action`、`id`/`runId`/`index`/`childIndex` |

- 上游 native 参数形状：`IntercomParamsSchema`（`node_modules/pi-subagents/src/intercom/native-supervisor-channel.js:27-33`）= `action enum[list,pending,status,reply]` + `to?` + `message?` + `replyTo?`，`additionalProperties:false`。本仓 `SUPERVISOR_PARAMETERS` 把 action 收窄为 `reply|pending|status`（`supervisor-adapter.ts:5`）→ **`list` 今天在本仓不可达**（S3 不新增第四工具）。
- `to` 真实用途：只在 `reply` 且无 `replyTo` 时兜底匹配 `requestId` 前缀 / `agent` / `childTarget`（大小写不敏感），多命中或零命中即抛错要求 `replyTo`（`native-supervisor-channel.js:479-507`）。
- `replyTo` 真实用途：(a) `reply` 的精确请求定位（`:483-487`）；(b) 本仓 D3 **status 只读诊断的 requestId 过滤**（`extension.ts:1533` `filter={requestId:params.replyTo}`）。除 status 之外 `replyTo` 不改 native 输出。
- `message` 真实用途：`reply` 正文，`writeReply(request, input.message ?? "")`（`:540`）；`pending`/`status` 不消费。
- 本仓受控链（`createControlledSupervisorAdapter`，`extension.ts:1515-1600`）：`status` → native 透传 + `withSupervisorDiagnosticDetail(result,"supervisorDiagnostic", …)`（`1540-1542`，root 身份只取 `resolveRootSessionId(ctx.sessionManager)`，绝不接受 agent 指定 root；D2/D3 raw 诊断保留）；`reply` → **只有 `typeof params.replyTo === "string"` 才进入 flights 串行（`1588-1593`）**，`executeReply` 中缺 `replyTo` 的请求查不到 → `SUPERVISOR_REQUEST_NOT_PENDING`（`1550-1558`）或 `SUPERVISOR_REQUEST_REGISTRATION_FAILED`（`1551-1557`）；成功后 `commitDelivery` + `deliveryReceiptDiagnostic`（queued≠consumed，`1577`）；失败走 `compensateSupervisorDelivery`（`1579-1581`）。
- **`to` 的条件性（关键、须父知悉）**：`supervisorControlPlane` 存在且 `enabled()!==false` 时，`to`-only reply 实际被本仓拒（要 `replyTo`）；仅当无控制面（`extension.ts:1516` 直接返回原 adapter）或 `enabled()===false` 时，`to`-only 才由 native 解析。故 S3 合同：`replyTo`/`message` 必填，`to` 作为 optional 保留（不新增语义、不加 fallback），并在 description 说明「`to` 只在无控制面/控制面停用路径生效；受控路径以 `replyTo` 为唯一权威」。不得为此新增第二 observer 或改 native content/isError。

## 3. 薄委托 factory 与固定 action（S1/S2/S3 接口）

- 每个新工具 execute 必须走「唯一 typed dispatcher / 唯一 workspace service 闭包 / 受控 supervisor adapter」，并把固定 action 注入（调用方 args 不含 `action`，schema 也不声明该属性）→ 天然不可被覆盖；S1 另需断言：即使 raw args 带 `action`，透传给 `executeControl` 的仍是工具自身固定 action（计划 S1「不透传调用方 action 覆盖固定 action」）。
- 唯一执行入口映射：roster→`executeControl(action:"list")`；`run_*`→`executeControl` 固定 status/steer/interrupt/resume/stop；`start`→`executeCoding`/`executeGeneric`；`managed_workspace_*`→`createSubagentWorkspaceTool` 的 execute 同一闭包（不 copy service 逻辑）；`supervisor_request_*`→`controlledSupervisorAdapter.execute` 固定 pending/status/reply。
- 无新 dispatcher、无新状态/定时器、无新 queue：`flights`、`registrationFailures`、`titleRegistry`、owner/CAS、`action_token`、terminal proof 全部沿用（`extension.ts:1517,1943,1503-1511`）。
- 旧 union 工厂保留但不注册（`TYPED_SUBAGENT_PARAMETERS`/`SUBAGENT_WORKSPACE_PARAMETERS`/`SUPERVISOR_PARAMETERS` 仍是兼容测试与实现复用源）；不删除公开导出。

## 4. 名字迁移与依赖点（S4 必读）

- **membrane 上游旧名捕获不得改**：`src/subagent-dispatch/runtime-membrane.ts:5` `SUPERVISOR_TOOL_NAME="subagent_supervisor"`；`175-185` 只在该 name 上拦截 `registerTool` 并 `supervisorAdapter.bind(definition.execute)`；`186-188` `getAllTools` 过滤掉该名。上游自证：`native-supervisor-channel.js:13 NATIVE_SUPERVISOR_TOOL_NAME`、`:649 hasTool(...)`。它是上游名，不是新模型工具名 → 常量与拦截判定保持。
- **`deactivateSupervisorTool` 现硬编码单名**：`extension.ts:1666-1671`（`activeTools.includes("subagent_supervisor")` / filter）。调用点 `extension.ts:2061-2071`（`session_start` 时 `supervisorAdapter.isBound()===false` → 停用并抛 `SUPERVISOR_TARGET_UNAVAILABLE`）。S4 必须把停用集合换成 `supervisor_request_pending`/`supervisor_request_status`/`supervisor_request_reply`，未 bind 时不留 active 声明；`inspect`/`clear` 仍归 gate 计划。
- **renderer 名字表（按名）**：`src/tui/tool-renderers.ts:117-118` Map 键 `"subagent"`/`"subagent_supervisor"`（child 预览 `resolveToolRenderer`）；`messages`/`entries` 键是 customType（`subagent_supervisor_request`、`subagent-notify`、`subagent-workspace-reminder`、`subagent_supervisor_reply`、`subagent_control_notice`）**不是工具名，不得改**。
- **renderer 现依赖 `args.action`**（S4 必须改为按工具名映射固定 operation）：`tool-renderers.ts:33-37`（`spawnStartingSummary` 用 `Object.hasOwn(args,"action")` 区分 spawn/control）、`52-61`（action + `id|runId|index|dir` 目标）、`66`（`!Object.hasOwn(args,"action")` 才走 spawn summary）、`85-90`（supervisor action + replyTo）；`compact-rendering.ts:268-292`（`input.action` 分支 steer/list/interrupt/resume/status）、`203-224`（supervisor reply 正文投影，读 `input.message`/`input.to`/`details.replyTo`）。新工具名不再携带 `args.action`，这些分支必须重挂到「工具名→operation」。
- **旧校验失败正则**：`compact-rendering.ts:293` `/^Validation failed for tool "subagent":\s*$/m`（并 `split(/^Received arguments:\s*$/m)`）——Host 校验失败文案形状由 SDK 佐证 `Validation failed for tool "${toolCall.name}":\n…Received arguments:\n…`（`node_modules/@earendil-works/pi-ai/dist/utils/validation.js:306`）。S4 覆盖新 14 名，不得改模型 raw payload。
- **上游 raw 文本显示投影（不得反向改 raw）**：`compact-rendering.ts:165` `/^Reply with:\s*subagent_supervisor\s*\(/i`（只裁显示行）。上游完成/决策通知仍带旧调用示例，禁止重写其 raw；GLOBAL 需给一次性旧→新映射。
- 非工具名同串（**禁止改名**）：`ActivityKind="subagent"` 于 `src/tui/background-activity.ts:21,156,159`、`src/tui/subagent-activity.ts:90,156`、`src/tui/footer-runtime.ts:72,866`、根 `src/background-activity/layout.ts:59`；`"extensions/subagent/config.json"` 目录路径于 `src/subagent-dispatch/child-tool-policy.ts:16`；`contact_supervisor` 消费在 `src/subagent-dispatch/supervisor-consumption.ts:83`。
- `scripts/probes/repository-merge-queue-acceptance.ts:172,408` 以 `record.toolName === "subagent"` 认派发事件（真实工具名消费，非本计划 WritePaths → 见 §6 额外路径）。

## 5. unknown / runtime-only 字段清单（fail closed，不猜，不加 fallback）

1. **`view` / `lines`（status 输出）**：上游 `normalizeStatusParams` 消费（`rpc.js:273-281`）并有 transcript 分支（`src/runs/background/run-status.js:405-445`），但本仓 `TYPED_SUBAGENT_PARAMETERS.properties` 无此二键 → **今天模型发不出**（Host `additionalProperties:false` 拒）。S1 不得新增（新增即扩 schema，须父决策）。
2. **`mode`（steer 投递模式）**：上游 `steerParams` 支持 `steer|follow_up|auto`（`rpc.js:414-416,421`），本仓 schema 无 `mode` → runtime-only，不新增。
3. **`childId`（stop 子级定位）**：上游 `stopAsyncRun` 校验并消费（`rpc.js:441-452,485-517`），本仓 schema 无 → runtime-only，不新增。
4. **`output` / `outputMode` 在 resume 上（需父决策）**：本仓扁平 schema 有这两 property，且 `executeControl` 整包透传 → 今天 `{action:"resume", …, output, outputMode}` 事实可达并被上游 `resumeParams` 读取（`rpc.js:430-440`，且 `outputMode` 只允许 `file-only`）。但计划 §2.1 的 resume 行未列这两字段。父层已裁决：新resume保留既有可达`output`/`outputMode`，output沿原string或false形状，outputMode仅file-only；执行仍交原resumeParams裁决，不实现换模，不向其他run工具扩展output。
5. **`index` 对 resume/stop 的实际效果**：上游 `normalizeTargetParams` 保留 `index`（`rpc.js:258-268`），但 `resolveAsyncRunLocation` 只读 `id/runId/dir`（`src/runs/background/async-resume.js:159-176`）→ `index` 是否改变 resume/stop 投递目标 **未证**；计划要求 resume/interrupt 保留 `index`，S1 照计划保留字段但不得声称 `index` 对 resume/stop 有定位效果。
6. **provider 兼容**：以上全部为 fake Host / 静态证据；真 provider 端（含 glm/zai 严格端）对新 14 份单 object schema 的通过情况 **unknown**，S6 只在 fresh Host 记录，不提前宣称。
7. **`executeSupervisor`（`extension.ts:2082`）的外部消费者**：本次未穷尽检索（按主管指示停止）→ unknown；S4 改注册前须单独确认是否有 Host 侧调用。

## 6. 活跃自有引用清单（脚本产出，不含历史 docs）

脚本（一次性、只读、排除 TDD 文件与外部 skills、排除 node_modules/docs/var）：`/tmp/s0-operation-contract-probe.mjs`、`/tmp/s0-toolname-sites.mjs`、`/tmp/s0-classify-sites.mjs`、`/tmp/s0-final-sites.mjs`。宽扫 184 文件命中后按「是否把旧名当工具名消费」分类，得下表。

**Production（本仓自有，6）**
| 文件 | 行 | 性质 |
| --- | --- | --- |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | 1861, 1952/1953/1985, 1666-1671, 2061-2071, 125/1222/1360, 1408 | 定义/注册/停用/自有文案（S4/S5） |
| `packages/pi-subagents-enhanced/src/workspace/tool.ts` | 60 | 定义（S2 复用） |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts` | 43 | 定义（S3 委托对象） |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts` | 5, 175-188 | 上游名捕获（**不改**） |
| `packages/pi-subagents-enhanced/src/tui/tool-renderers.ts` | 117-118（+33-90 args.action 依赖） | 名字表（S4） |
| `packages/pi-subagents-enhanced/src/tui/compact-rendering.ts` | 293, 165, 268-292, 203-224 | 校验正则/reply-hint/operation 分支（S4） |

另有 `packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts:55`（本仓自有 reminder 文案含 `subagent_worktree({action:"status"…})`，属 S5）；`scripts/probes/repository-merge-queue-acceptance.ts:172,408`（见 §4）。

**Unit test（可 `node --test`，S4/S5 候选写路径）**
| 文件 | 依赖点 |
| --- | --- |
| `test/subagent-runtime-membrane.test.mjs` | 352,515,545,623,719,732,868,882,942,956,1007,1044,1072,1129,1151,1777,1783,2140；**位置依赖 `pi.tools[0..2]`：966-977**（44 处 `tools[0]`） |
| `test/subagent-compact-rendering.test.mjs` | 186,275,291,300,305,322,328,351（含 reply-hint 与 reminder 文本） |
| `test/joint-upgrade-model-only.test.mjs` | 21 名集 `['subagent','subagent_worktree','subagent_supervisor','subagent_integration',…]`；`h.invoke('subagent',…)` 26 |
| `test/subagent-dispatch-extension.test.ts` | **`tools[0]` 位置依赖 34 处**（189,232,265,279,293,341,382,430,493,517,588,609,644,682,701 …） |
| `test/subagent-supervisor-adapter.test.mjs` | 13（name/label/description/parameters 冻结断言） |
| `test/subagent-workspace-tool.test.mjs` | 14,35,50（name + `anyOf` action consts + description 文本） |
| `test/subagent-dispatch-schema-security.test.mjs` | 6,69,70（`Compile(TYPED_SUBAGENT_PARAMETERS)`、root 无组合子、混支） |
| `test/subagent-spawn-rollback.test.mjs` | 158,197,228,255,292,313（`pi.tools[0]`） |
| `test/subagent-rpc-diagnostics.test.mjs` | 161（`pi.tools[0]`） |
| `test/subagent-dispatch-startup-probe.test.mjs` | 60（`pi.tools[0]`） |
| `test/custom-footer-subagents.test.mjs` | 889,890（`resolveToolRenderer("subagent"/"subagent_supervisor")`） |
| `test/repository-merge-queue-acceptance-probe.test.mjs` | 370,382,401,420,436,456-467,565,643,663,677,698（`toolName:"subagent"` 记录） |
| `test/joint-upgrade-ceiling-runtime.test.mjs` | 48（`h.invoke('subagent',…)`） |

**Integration test（S4 需真实 SDK fake Host 资源；未跑）**：`test/pi-subagents-runtime.integration.mjs`（353,359,362,424-441，含 `filter(name=>name!=="subagent")`）、`test/pi-subagents-project-workflow.integration.mjs`（98,116,120,220,236,322,340,345,440）、`test/pi-subagents-045-workflow.integration.mjs`、`test/subagent-managed-worktree.integration.mjs`（**`tools[1]` 位置依赖** 196-318）、`test/subagent-model-selection.integration.mjs`（23 处 `tools[0]`）、`test/subagent-auto-integration-real-git.integration.mjs`（269）、`test/subagent-acceptance-evidence.integration.mjs`（29,43,55,60 `tools[0]`，但那是 child 证据工具）、`test/subagent-completion-notification.integration.mjs`（87,98,133,349）、`test/subagent-steer-text-insertion.integration.mjs`（72,85,87,277,287,288,296）、`test/joint-upgrade-contact-supervisor.integration.mjs`（37,66-112,143）、`test/heartbeat-parent-death.integration.mjs`（160）、`test/subagent-runtime-root-broker-startup.integration.mjs`（72-73）、`test/subagent-runtime-production-shutdown.test.mjs`（44,108,159 `registerTool({name:"subagent_supervisor"})`）、`test/pi-runtime.integration.mjs`（63,68）、`test/subagent-worktree-lifecycle.integration.mjs`（37-41，`subagent_integration` child 面）。

**测试 fixture（自有写路径候选）**：`test/fixtures/heartbeat-parent-host.ts`（26 `setActiveTools(["subagent","subagent_worktree"])`）、`test/fixtures/heartbeat-provider.ts`（113,117-128 `toolName==="subagent"/"subagent_worktree"`）、`test/fixtures/deterministic-provider-state.mjs`（75-88）、`test/fixtures/joint-upgrade/contact-provider.mjs`（19,47-66）、`test/fixtures/recovery-resume/scripted-model-server.mjs`（45 `name:"subagent"`）、`test/fixtures/repository-merge-queue-acceptance/root-provider.mjs`（82 `name:"subagent"`）、`test/fixtures/background-activity-visual.ts`（14,33 — ActivityKind，**不改**）。

**非 TDD skills / 根 MD**：`skill-overrides/**` 零命中；`pi/AGENTS_GLOBAL.md` 命中 66,68（`subagent({…})` 派发示例）、116,120,128（`subagent_worktree({action:…})` 示例）、116-128 整段 Workspace 处置 → S5 迁移范围；`src/agents-shared/index.ts` 无旧工具名（32 行是「subagent」普通名词，57 行是 `subagent:acknowledge-extension` 事件名）；`src/bash-async/index.ts` 无旧工具名。

**历史 docs（登记，不改）**：`docs/research/2026-10-15-{runtime-guidance-boundaries,upstream-subagent-tool-exposure,bash-async-agent-guidance}.md`、`docs/research/2026-10-14-subagent-resume-model-override-design.md`、`docs/research/2026-10-15-supervisor-steer-block-diagnosis.md`、`docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/{C,E,F}.md` 等（旧名/旧示例保持原样，S5 不覆写）。

**S4 精确 test fixture 写路径白名单建议（相对计划已给 8 项）**：计划已含 `subagent-runtime-membrane`、`subagent-compact-rendering`、`joint-upgrade-model-only`、`subagent-dispatch-rpc`、`subagent-dispatch-extension.test.ts`。本 S0 额外发现必须同步修改的：`test/subagent-supervisor-adapter.test.mjs`、`test/subagent-workspace-tool.test.mjs`、`test/subagent-dispatch-schema-security.test.mjs`、`test/subagent-spawn-rollback.test.mjs`、`test/subagent-rpc-diagnostics.test.mjs`、`test/subagent-dispatch-startup-probe.test.mjs`、`test/custom-footer-subagents.test.mjs`、`test/joint-upgrade-ceiling-runtime.test.mjs`、`test/repository-merge-queue-acceptance-probe.test.mjs`、`test/subagent-runtime-production-shutdown.test.mjs`，以及 production 侧 `scripts/probes/repository-merge-queue-acceptance.ts`。**注**：`test/subagent-dispatch-rpc.test.mjs` 实际只涉及 RPC channel 名（`subagents:rpc:v1:*`），不消费工具名 → 计划把它列进 S4 写路径可能不必要（保留但不预期有 diff）。另：位置依赖（`tools[0]`/`tools[1]`）必须在 S4 改为按 name 查找，这是本节最重要的连带风险。

## 7. 三个旧 schema/description 的 UTF8 字节基线（`Buffer.byteLength`，无 token 估算、无收益宣称）

| 旧工具 | description | schema(JSON.stringify) | promptSnippet | promptGuidelines |
| --- | --- | --- | --- | --- |
| `subagent` | 3141 | 1781 | 123 | 464（3 条） |
| `subagent_worktree` | 1113 | 1010 | 96 | 341（2 条） |
| `subagent_supervisor` | 98 | 209 | 117 | 277（2 条） |
| 合计 | 4352 | 3000 | 336 | 1082 |

`desc+schema` 合计 **7352**；含 snippet/guidelines 合计 **8770**。方法：`node --input-type=module` 导入 `extension.ts`/`workspace/tool.ts`/`supervisor-adapter.ts` 的导出常量（subagent 的 snippet/guidelines 从 `extension.ts:1866-1873` 定义体就地取值）后 `JSON.stringify` + `Buffer.byteLength(…, "utf8")`。本文件不声称任何 token 下降或模型选择改善。

## 8. 验收映射与阻塞

- criterion-1：§1、§2（14 工具 required/optional/不支持）、§3（薄委托固定 action）、§7（字节）、§4（旧→新名映射与依赖点）均带 `file:line` 现场证据；研究假设（如「所有 control 共用 canonicalSteerTarget」）在 §2.1/§4 显式否掉，仅 steer 权威。
- criterion-2：§1（注册面/model-only/child 不扩权）、§4（membrane 旧名不改、`deactivateSupervisorTool` 硬编码、renderer 按名与 `args.action`、校验错误正则）、§2.3（control resolver 仅 steer、`to`/`replyTo`/`message` 真实用途、D2/D3 raw 诊断保留）。
- criterion-3：§0（gate 未发布 → 只挡 S4）、§5（unknown 清单 + 各自窄停止条件）。
- criterion-5：§2 表格「不支持」列 + §5，全部不自行扩 schema/alias；§5.4 是需父决策的窄点。
- 父层验收修订：start表曾误列`context`（runtime消费但当前模型schema未声明），已移除，新schema不扩该字段。resume的output/outputMode已裁决保留。§7确实运行过只读node导入探针，故开头“未跑node”若据此理解为零node执行则不成立：未跑tests/tsc/Host，不隐瞒静态探针事实。
- 遗留 unknown（不阻 S1–S3）：§5.1–§5.6、§5.7（`executeSupervisor` 消费者未穷尽，按主管指示停止检索）、§7 的物理 Host 与真 provider 兼容。
