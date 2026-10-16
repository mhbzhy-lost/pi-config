# 上游 pi-subagents@0.75.0 管理工具曝光目录（只读调研）

- 任务 ID：dispatch-8ff9faf0
- 调研对象：**本仓已安装副本** `packages/pi-subagents-enhanced/node_modules/pi-subagents/`
- 版本确认：`pi-subagents/package.json:4` `"version": "0.75.0"`；本仓依赖 pin `packages/pi-subagents-enhanced/package.json:39` `"pi-subagents": "0.75.0"`
- 运行宿主：`@earendil-works/pi-coding-agent` `1.0.4`（`node_modules/@earendil-works/pi-coding-agent/package.json:3`）
- 边界：全程只读，未运行 node/tests/npm/Host/provider，未联网，未升级。**本文所有结论只描述 0.75.0 这一安装副本，不代表上游最新版本。**
- 路径缩写：`UP = packages/pi-subagents-enhanced/node_modules/pi-subagents`
- 本文只做 exposure（曝光）对照与 guidance 归属位置的**有界登记**；guidance 全面归属由父会话另一路（5e39cd1b）负责，本文不重复其结论、不做实现/计划 review。

---

## 1. 模型可见 registerTool 名单（全量注册点，非记忆）

上游全仓 `pi.registerTool(` / 等效调用共 12 处实际注册点（`grep -rn registerTool UP/src UP/index.js`）：
`UP/src/extension/index.js:672`、`UP/src/extension/tool-activation.js:114`、`UP/src/extension/fanout-child.js:229`、`UP/src/extension/herdr-pi-bridge.js:95`、`UP/src/intercom/native-supervisor-channel.js:192`、`:650`、`UP/src/runs/background/wait-tool.js:34`、`UP/src/runs/shared/subagent-prompt-runtime.js:409`（经由 `:408` 的别名 `registerTool`）、`:458`、`UP/src/runs/shared/child-session.js:168`（MCP 代理内部）、`:358`、`:359`。
另有 3 处只是能力探测/守卫而非注册：`UP/src/agents/runtime-agent-registry.js:44`（要求 host 具备 `pi.registerTool`）、`UP/src/runs/shared/subagent-prompt-runtime.js:476`（注册 `bg_wait` 的守卫，实际调用在 `:477`）、`UP/src/runs/shared/child-session.js:167`（proxy get）。

### 1.1 根（parent/orchestrator）会话可见

| 工具名 | exposure | 注册点 (file:line) | 角色 | 出现条件 |
|---|---|---|---|---|
| `subagent` | `model-only` | 定义 `UP/src/extension/index.js:639-671`；注册 `:672` | 唯一委派 + 全部管理/控制入口（60 个 action 见 §2） | 恒注册。schema 由 `createSubagentParamsSchema(disabledFeatures)` 生成（`index.js:638`；`UP/src/extension/schemas.js:276-291`）；description 由 `buildSubagentToolDescription`（`index.js:643`；`UP/src/extension/tool-description.js:163-183`） |
| `bg_wait` | **无 exposure 字段 → 默认 `direct`** | `UP/src/runs/background/wait-tool.js:27-34`；根侧调用 `UP/src/extension/index.js:685` | 等待无原生完成通知的后台工作（provider/detached） | 恒注册；`config.waitTool` 只改变描述与行为（`wait-tool.js:4,16`），不改变注册 |
| `subagents_enable` | `model-only` | `UP/src/extension/tool-activation.js:77-114`；根侧调用 `index.js:1058-1064` | 惰性激活器：把 `subagent` 加入 active tools | `config.toolActivation !== "eager"` 时才注册（`tool-activation.js:66`；`index.js:1059`）；`"auto"` 仅对可中途加工具的模型启用 loader（`tool-activation.js:22-34`、`:44-66`）；host 缺 `getAllTools/getActiveTools/setActiveTools` 时退回 eager（`:68-74`） |
| `subagent_supervisor` | `model-only` | 工厂 `UP/src/intercom/native-supervisor-channel.js:517-547`；注册 `:648-651`；触发 `start()` `:837-842` ← `index.js:1042` | 父侧回复 child 请求（reply/pending/list/status） | 仅在 `supervisorChannel.start()`（`session_start`）时注册一次；`hasTool` 去重（`:649`） |

`MODEL_ONLY_TOOL` 定义在 `UP/src/shared/extension-context.js:7`（`{ exposure: "model-only" }`；头注 `:1-6` 说明为何要 model-only）。`exposure` 取值语义见**宿主**文档 `/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:152-164`：`direct`（默认）/`model-only`/`codemode`/`deferred`/`hidden`。（下文单写 `docs/…` 时均指 `UP/docs/…`。）

### 1.2 child（子会话）可见

子侧工具由两条独立路径注入：`session_start`/`before_agent_start` 事件触发（prompt runtime），或 `agent_start` 前置钩子。

| 工具名 | exposure | 注册点 (file:line) | 角色 | 出现条件 |
|---|---|---|---|---|
| `contact_supervisor` | `model-only` | 定义 `UP/src/intercom/native-supervisor-channel.js:179-192`（schema `:22-26`）；由 `UP/src/runs/shared/subagent-prompt-runtime.js:478-490`、`:551` 触发 | child→父阻塞决策/结构化访谈/进度上报 | 需 `childSupervisorMetadata(config)` 非空（`native-supervisor-channel.js:180`：`!metadata` 直接 return）；`hasTool` 去重；agent `tools` 白名单必须显式含该名 |
| `subagent_supervisor` | `model-only` | `UP/src/extension/fanout-child.js:238`（`supervisorChannel.registerTools()`） | fanout child 作为「中间父」回复自己后代 | 仅 `childConfig.fanoutChild`（`fanout-child.js:136-137`），且 host allowlist 已放行该名（`fanout-child.js:240`）；`child-tool-plan.js:202-204`：声明 `subagent_supervisor` 却无 fanout 授权 → 启动即抛错 |
| `subagent`（child-safe 变体） | `model-only` | `UP/src/extension/fanout-child.js:212-229`；挂载 `UP/src/runs/shared/child-hooks.js:169-170` | 嵌套 fanout 委派 | `allowNestedSubagents` 或 `tools` 含 `subagent`（`child-tool-plan.js:199-201`）；描述中写死可行动作白名单（`fanout-child.js:218`）与阻塞动作（`:210,219`） |
| `bg_wait`（child 变体） | 默认 `direct` | `UP/src/runs/shared/subagent-prompt-runtime.js:476-477` → 同一 `wait-tool.js:34` | child 侧收集自有后代 | 恒注册于 child runtime；须保留在 child `tools` 白名单（`wait-tool.js:16` 文案自证） |
| `structured_output` | `model-only` | `UP/src/runs/shared/subagent-prompt-runtime.js:404-442`；仅 `config.structuredOutput` 时调用 `:520-521`；名称注入白名单 `child-tool-plan.js:234` | 结构化终态提交（`terminate: true`，`:434`） | 仅当该 run 有 outputSchema/结构化合同 |
| `watchdog_diff` | 默认 `direct` | `UP/src/watchdog/diff-tool.js:56-66`；注册 `UP/src/runs/shared/subagent-prompt-runtime.js:453-458` | reviewer 读自身 diff | 仅 `config.requiredTools` 含该名（`:453`） |
| `bash`（被 wrap） | 不注册新名，只替换 | `UP/src/runs/shared/child-commands.js:106-164`（注入 `yieldTimeMs` 与提示文案 `:109-113`）；挂载 `UP/src/runs/shared/child-session.js:358` | 给 bash 增加 `yieldTimeMs` | `runtime.runId && agent && childIndex !== undefined && tools⊇{bash,subagent_command}`（`child-session.js:322-326`） |
| `subagent_command` | 默认 `direct` | `UP/src/runs/shared/child-commands.js:165-181`（名常量 `:7`；`action` 必填 enum `[status,cancel]` `:169`）；注册 `child-session.js:359` | child 自查/取消自己的命令 | 同上白名单条件 |
| MCP 直连工具 | 被改写为 `direct`/`hidden` | 代理 `UP/src/runs/shared/child-session.js:160-172`（`registerTool` 包装 `:167-168`） | 把 host 默认 `codemode` 曝光的 MCP 工具提升为模型直连 | 仅 `builtin:mcp` 路径；未被 selector 命中的全部降为 `hidden` |
| `contact_supervisor`（Herdr pane 变体） | `model-only` | `UP/src/extension/herdr-pi-bridge.js:95-121` | 远程 pane 内 child 的 supervisor 通道 | 仅 Herdr pane 原生会话（`herdr-pi-bridge.js`），与本地 child runtime 互斥 |

**结论性差异**：upstream child 里唯一「独立注册」的管理工具是 `contact_supervisor` / `subagent_supervisor` / `subagent_command`；`resume/steer/status/list/interrupt/stop` **都不是工具**，只是 `subagent` 的 action（§2）。

---

## 2. 管理动作的暴露方式：单工具 + `action` 判别（start 与 control 统一）

### 2.1 是否统一

统一。`subagent` 一个工具同时承载「启动」与「控制/管理」，由 `action` 是否存在切换模式：

- schema 注释即合同：`UP/src/extension/schemas.js:143-145`「Management/control only; omit for execution」。
- 运行时分派：`UP/src/runs/foreground/subagent-executor.js:7375-7377`（`normalizedAction` 存在→管理路径，否则→执行路径）。
- 结果 `details.mode`：管理类统一 `{ mode: "management", results: [] }`（如 `:6222,6247,6390`）。
- 上游**没有** `subagent_start`/`subagent_control`/`subagent_status` 之类的独立工具（全量注册点见 §1）。

### 2.2 required / optional 事实

`SubagentParams = Type.Object(SubagentParamProperties)`（`UP/src/extension/schemas.js:259-260`）**没有 `required` 数组**：`SubagentParamProperties`（`:138-258`）内全部字段均为 `Type.Optional(...)`。即模型侧 schema 层面 0 个必填字段；所有「X 必填/互斥」语义只存在于 (a) 字段 description 文本、(b) 运行时校验、(c) 文档表。

字段与约束（file:line 均在 `UP/src/extension/schemas.js`）：

| 字段 | 行 | schema 约束 | 真实必填/关联（非 schema） |
|---|---|---|---|
| `action` | `:143-145` | Optional string, minLength 1 | 出现即管理模式 |
| `agent` / `task` | `:139-140` | Optional | 「task requires agent」只在描述里 |
| `capabilities` | `:146` | Optional boolean | 仅 `list` 有意义 |
| `name` | `:147` | Optional | 仅 `schedule.create` |
| `id` / `runId` / `dir` | `:148-156` | Optional | status/control 目标；RPC 侧 `steer/resume` 必须三者之一（`rpc.js:411-413,428-430`） |
| `index` | `:163` | Optional int ≥0 | 多子 run 必显式（`docs/tool-reference.md:323-331`） |
| `childId` | `:164` | Optional 1-256 | `stop` 单子粒度（`rpc.js:441+`） |
| `toolCallId` | `:165` | Optional | `command.yield/cancel` 必填（`docs/tool-reference.md:325-345`） |
| `view` / `lines` | `:166-170` | Optional，`enum:[fleet,transcript]`，lines 1-500 | 仅 status |
| `topic` | `:171` | **Optional string，无 enum** | 合法值只在代码/文档：`UP/src/extension/subagent-guide.js:4-16`（11 个 topic） |
| `message` / `mode` / `steeringRecovery` | `:172-174` | `mode` enum `[steer,follow_up,auto,plan,apply]` | `resume/steer` 需非空 message（`rpc.js:407,424`） |
| `config` | `:197-202` | anyOf object/string | create/update 载荷 |
| `merge`/`supersession`/`laneId`/`handoffPath`/`repo`/`planId` | `:157-162` | 宽松 object | lane 证据字段细则不在 schema（描述指向 guide 主题） |
| `workflow`/`args`/`preflight`/`chain`(structured 分支) | `:204-210`、`:263-275` | 关闭脚本时替换为 `chain/tasks` | 运行时严格校验（`:276-291`） |
| 其余执行默认项 | `:190-257` | 全 Optional | `docs/tool-reference.md:68-117` 为权威表格 |

**唯一有 `required` 的两处**：`SubagentWaitParams`（`bg_wait`，`:292-310`，全部 Optional，无 required）实际上也无；真正 required 的是 child 侧 `structured_output`（`UP/src/runs/shared/structured-output.js:140-149`：`required: ["value", ...]`）和 `subagent_command`（`child-commands.js:169`：`action` 必填）、`subagent_supervisor`（`native-supervisor-channel.js:27-33`：`action` 必填）、`contact_supervisor`（`:22-26`：`reason` 必填）。

### 2.3 action 全集与分组（60 个）

权威枚举：`UP/src/shared/types.js:129`（`SUBAGENT_ACTIONS`，60 项）。分类计数：`schedule` 9、`mission` 7、`watchdog` 4、`inspector` 4、`command` 3、`lane` 3、`refine` 3、`project` 3、`worktree` 2，其余各 1（脚本统计见 §8 命令记录）。

分派位置（`UP/src/runs/foreground/subagent-executor.js`）：

| 组 | 处理位置 | 备注 |
|---|---|---|
| lane 证据 `lane.status/recordMerge/recordSupersession` | `:6181-6210` | 写 manifest，不跑 git |
| `worktree.discard` / `worktree.cleanup` | `:6181-6210` 前段与 `mode` 约束（`schemas.js:173` 只接受 `plan`） | apply 保留 |
| 权限门禁（`stop/interrupt/steer/schedule.create/inspector.open/project.open`） | `:6214-6233` → `UP/src/policy/authority.js:1-20` | `confirm` 需 `ctx.hasUI`，否则 fail closed |
| Herdr project panes / inspector / mission / watchdog / refine | `:6234-6240` / `:6241-6254` / `:6255-6269` / `:6270-6279` / `:6280-6302` | 各自模块 action 常量：`UP/src/inspectors/types.js:1`、`UP/src/missions/actions.js:6-14`、`UP/src/watchdog/tool-actions.js:149`、`UP/src/inspectors/herdr/project-panes.js:9`、`UP/src/runs/background/scheduled-runs.js:15-25` |
| `grant-spawn-budget` | `:6303-6369` | 需 root interactive + 原生确认（`schemas.js:175`） |
| `guide` | `:6370-6386` | 读安装包内文档，不启动 run |
| `children.list` | `:6387-6394` | workflow-only 名册 |
| `doctor` | `:6395-6437` | `UP/src/extension/doctor.js` |
| `command.status/yield/cancel` | `:6438-6454` | 需 child 已授予 `subagent_command` |
| `status` / `debug.run` | `:6455-6505` | `view`/`lines`/`index` |
| `resume` | `:6506-6519` | 分离式回执 |
| `steer` | `:6520-6646` | `mode`、`steeringRecovery` |
| `dismiss` | `:6647-6663` | 通知清理 |
| `stop` | `:6664-6741` | 仅本会话顶层 async |
| `interrupt` | `:6742-6781` | run 级 |
| agent profile CRUD（`list/get/models/create/update/delete/eject/disable/enable/reset`） | 兜底 `:6782-6796` → `UP/src/agents/agent-management.js:1502-1515` | 未知 action 生成 next-step 文案 `subagent-executor.js:141-156` |
| `validate` | `:7428`（`action === "validate"` 在公共派发层） | 离线校验 workflow |

### 2.4 model-only / deferred / 动作级隐藏标记

- 工具级：仅 `MODEL_ONLY_TOOL`（`exposure: "model-only"`，`UP/src/shared/extension-context.js:7`）。**上游 0.75.0 任何 registerTool 都未使用 `deferred`，也未使用 `codemode`；`bg_wait`/`subagent_command`/`watchdog_diff` 未写 exposure，落宿主默认 `direct`。** `deferred` 是宿主/Pi 概念（`docs/extensions.md:159`（宿主）），不是上游动作标记。
- 动作级「模型只见子集」的三层机制：
  1. `config.disabledFeatures` 特性组同时删 action 与 param（`UP/src/shared/disabled-features.js:8-40`，裁剪 `UP/src/extension/schemas.js:276-291`），影响面见 `docs/configuration.md:119`。
  2. child-safe 硬边界：`allowMutatingManagementActions === false`（`fanout-child.js:203`），拒写动作集合 `subagent-executor.js:113`（MUTATING）/`:114`（DESTRUCTIVE），逐分支拦截 `:6122,6154,6182,6219,6235,6242,6256,6271,6281,6304,6440,6624,6640`。
  3. RPC 独立 allowlist：只有 7 个 schedule 动作可经 `manage`（`UP/src/extension/rpc.js:21-29`、`:350-374`），其余管理动作在 RPC 层被拒。
- 未知动作不 fail-silent：返回 `status`/`list` 下一步 + 近似拼写建议，破坏性动作只在「单字符差且长度相符」时才提名（`subagent-executor.js:141-156`）。

---

## 3. agent profile CRUD / fleet / run control 是三个不同层次

| 维度 | agent profile CRUD | fleet | run control |
|---|---|---|---|
| 对象 | 代理「定义」（可发现的 agent 名单、模型、tools、acceptance 默认） | 「当前活跃 run 的观测投影」 | 「某一个 run 的生命周期」 |
| 入口 | `subagent({action:"list/get/models/create/update/delete/eject/disable/enable/reset/refine*"})`（`agent-management.js:1502-1515`） | `{action:"status", view:"fleet"}`（`schemas.js:166`）；`/subagents-fleet`（`UP/src/slash/slash-commands.js:700`）；TUI FleetView + 键位（`UP/src/shared/types.js:21-35`，`UP/src/tui/fleet.js:1057-1195`）；RPC `status` 的 `data.fleet` DTO（`rpc.js:71-200`） | `{action:"interrupt/stop/resume/steer/command.*"}`（§2.3） |
| 写副作用 | 有（改 agent 文件/overlay） | **无**：`view:"fleet"` 明确「不新增 steer/stop 能力」（`docs/tool-reference.md:313-321`）；fleet DTO「刻意不暴露 run/async/tool id」（`docs/extension-api.md:144-152`） | 有；`stop/interrupt` 属 DESTRUCTIVE（`subagent-executor.js:114`） |
| 调度差异 | — | — | `schedule.*` 是「未来启动的注册表」（9 动作，`scheduled-runs.js:15-25`），与在跑 run 的 control 分离；selector 里 schedule 条目走 `schedule.pause` 而非 `stop`（`docs/tool-reference.md:358-368`） |

即：上游把「CRUD 定义」「观测 fleet」「控制 run」三件事都塞进**同一工具名的不同 action**，但语义/权限/副作用边界是分层的，fleet 明确是只读投影层。

---

## 4. HostUI slash / agent tools / 程序 RPC：三条通道不混用

| 通道 | 载体 | 证据 | 消费者 |
|---|---|---|---|
| **agent tools（模型声明）** | `subagent`、`bg_wait`、`subagents_enable`、`subagent_supervisor`（根）；child 见 §1.2 | §1 全部 file:line | 模型 |
| **HostUI slash / TUI（人操作）** | 共 20 个 `pi.registerCommand`：`UP/src/slash/slash-commands.js` 内 17 个 —— `/subagents:592`、`/run:598`、`/subagent-cost:645`、`/subagents-doctor:651`、`/subagents-inspect-rpc:657`、`/subagents-guide:674`、`/subagents-refine:688`、`/subagents-fleet:700`、`/subagents-detach:728`、`/subagents-stop:738`、`/subagents-steer:777`、`/subagents-models:849`、`/subagents-profiles:866`、`/subagents-load-profile:877`、`/subagents-refresh-provider-models:930`、`/subagents-generate-profiles:964`、`/subagents-check-profile:1003`；另有 `/prompt-workflow`（`UP/src/slash/prompt-workflows.js:240`）、`/subagents-watchdog`（`UP/src/watchdog/register-main.js:379`）、`/pi-subagents-bridge`（内部 pane 派发，`UP/src/extension/herdr-pi-bridge.js:152`）+ 1 个 `pi.registerShortcut`（`slash-commands.js:733`）+ TUI 键位 `shared/types.js:21-35` | `registerSlashCommands` 挂载 `UP/src/extension/index.js:714` | 人（TUI/CLI）；slash 通过事件桥复用同一 executor，不是第二个模型面：`slash-bridge`（`index.js:614`）、`prompt-template-bridge`（`:619`） |
| **程序化 RPC（in-process 事件总线）** | 9 method：`ping/status/manage/spawn/steer/interrupt/stop/resume/cost`（`UP/src/extension/rpc.js:20`）；事件名 `:16-19`；`ping.capabilities` 自述 `:315-345` | 桥接注册 `rpc.js:690-719` ← `index.js:631-637`；文档 `UP/docs/extension-api.md:96-152` | 其他 Pi 扩展。**`spawn` 拒绝 action**（`rpc.js:399`）、`manage` 只允许 schedule 7 动作（`:350-374`）、`steer` 强制 `steeringRecovery:false`（`:420`）、`stop` 走进程内控制通道而非 executor（`:441-581`）、`status` 无目标时可走内存投影（`:282-297`、`:594-613`） |
| **程序化 API（import）** | 15 个 subpath exports + 根导出（`pi-subagents/package.json` `exports`）：`/background-work`、`/external-job-provider`、`/external-runs`、`/agents`、`/inspectors`、`/delegation`、`/capability-ceiling`、`/workflow-resources`、`/required-child-extensions`、`/preflight`、`/control-channel`、`/intercom-bridge`、`/child-tool-plan`、`/shared-types`、`/project-panes` | 同上 | 扩展开发者；本仓已用 `/capability-ceiling`（`packages/pi-subagents-enhanced/src/subagent-dispatch/child-tool-policy.ts:3`）与 `/required-child-extensions`（`extension.ts:24`） |

`intercom` 工具本身不属 pi-subagents（来自 pi-intercom）；本仓 `node_modules` 未发现 pi-intercom，因此上游 supervisor 文案里的「不覆盖 pi-intercom」（`native-supervisor-channel.js:522`）在本环境无对应竞争工具。

---

## 5. 与本仓 wrapper 的差异：不能把上游工具当作「当前可见」

### 5.1 本仓膜（membrane）实际拦截

`packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`：

- `:1-4` `ALLOWED_REGISTRATIONS = { registerEntryRenderer, registerMessageRenderer }`
- `:5` `SUPERVISOR_TOOL_NAME = "subagent_supervisor"`
- `:175-186` 拦截 `registerTool`：**只接受 `subagent_supervisor`**，且不接受其注册，而是把 `definition.execute` bind 进 `supervisorAdapter`，一律 `return undefined`；`execute` 非函数则抛 `SUPERVISOR_TARGET_INVALID`
- `:187-189` `getAllTools` 过滤掉 `subagent_supervisor`（让上游的 `hasTool` 探测看不到本地同名工具）
- `:190-195` 任何 `register*` 前缀属性若不在白名单 → `blockedRegistration`（`:11`，返回 `undefined`）

`bootstrap` 只以膜代理接收上游根扩展：`extension.ts:1896-1922`（`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:311` 调用 `installHeadlessTypedSubagentRuntime`，`:322` 传入 `bootstrap: upstreamSubagentRuntime`；该 forwarder 定义在 `src/compat/pi-subagents-0.75.ts:4,11-13`）。

### 5.2 因此，上游根工具在本仓主会话的实际可见性

| 上游工具 | 上游注册点 | 本仓主会话是否可见 | 原因 |
|---|---|---|---|
| `subagent`（上游） | `index.js:672` | **否** | 膜丢弃（非 supervisor 名）；本仓以同名工具自行重注册覆盖（`extension.ts:1577,1657`） |
| `bg_wait` | `wait-tool.js:34` ← `index.js:685` | **否** | 膜 `registerTool` 拦截 |
| `subagents_enable` | `tool-activation.js:114` ← `index.js:1058` | **否** | 同上 → 本仓无「惰性激活」这层，工具恒由本仓注册 |
| `subagent_supervisor`（上游实现） | `native-supervisor-channel.js:650` | **不注册，但被接管** | 膜只 bind execute 到 `supervisorAdapter`（`runtime-membrane.ts:177-184`）；模型看到的 `subagent_supervisor` 是本仓工具（`extension.ts:1690`；`supervisor-adapter.ts:43-72`），参数面是本仓 `SUPERVISOR_PARAMETERS`（`:1-11`，`required:["action"]`、enum `reply/pending/status`，**无 `list`**），不是上游 `IntercomParamsSchema`（enum 含 `list`） |
| 上游 20 个 slash 命令 + 1 个 shortcut | `slash-commands.js:592..1003`、`prompt-workflows.js:240`、`watchdog/register-main.js:379`、`herdr-pi-bridge.js:152`、`:733` | **否** | `registerCommand`/`registerShortcut` 均在 `register*` 黑名单（`runtime-membrane.ts:190-195`） |
| 上游消息渲染器 | `index.js` 内 `registerMessageRenderer` | 是 | 白名单允许 |
| 上游 RPC 事件桥 | `rpc.js:690-719`（`pi.events.on`） | 部分 | 膜的 `events.on` 把上游订阅交给 `captureEventSubscription`（`runtime-membrane.ts:124-138`）延后到 `activateEventSubscriptions` 才真正接入（`extension.ts:1877-1895`）；RPC method 面本身不受 registerTool 膜影响 |

### 5.3 本仓当前真实模型可见的 subagent 相关工具名单（逐个有源）

| 名称 | exposure | 注册点 | 动作面 |
|---|---|---|---|
| `subagent`（typed） | `model-only` | `extension.ts:1577-1578`、`:1657` | `action` enum **仅 6 值** `status/steer/interrupt/resume/stop/list`（`extension.ts:107`）；执行分支由 `writePaths`/`action` 路由（`:117`） |
| `subagent_worktree` | `model-only` | `src/workspace/tool.ts:60`、`extension.ts:1658` | `anyOf` 四 schema：`action` 为 const `list/status/dispose/release`（`tool.ts:3-26`） |
| `subagent_supervisor` | `model-only` | `supervisor-adapter.ts:43-50`、`extension.ts:1690` | `action` enum `reply/pending/status`，`required:["action"]`（`supervisor-adapter.ts:1-11`） |

child 侧本仓额外工具：`subagent_integration`（`child-extensions/integration-queue.ts:136`，`exposure:"model-only"`，注册 `:193`）、`submit_acceptance_evidence`（`child-extensions/acceptance-evidence.ts:29`，注册 `:82`）。上游 child 工具（`contact_supervisor`/`bg_wait`/`structured_output`/`subagent_command`）在 child 会话由上游 runtime 注册，**不经过本仓膜**；是否声明取决于 agent `tools` 白名单：`pi/agents/delegate.md:12`、`executor.md:10` 含 `contact_supervisor`，`reviewer.md:12` 不含。

**净差异（一句话）**：上游有 4 个根侧工具 + 20 个 slash 命令 + 60 个 action；本仓主会话只有 3 个工具、`subagent` 控制面 6 action、`subagent_worktree` 4 action、`supervisor` 3 action，且 slash 为 0。上游能力面 ≠ 本仓可见能力面。

---

## 6. 对「每操作独立工具」决策的对照（可借鉴 / 不构成反转依据）

既有方向登记：`docs/research/2026-10-15-markdown-guidance-inventory.md:118-138`（"全部拆开，每个操作独立工具"；并明确"不因上游做法反推"，`:134`）。

### 6.1 可借鉴（与拆分方向不冲突，且能缓解拆分的已知代价）

1. **未知动作/错误回执带下一步**：`subagent-executor.js:141-156` —— 拆分后每个工具可承接同型「did you mean + 只读兜底动作」文案，且对破坏性动作收紧提名条件（`:147-149`）。这补的正是「拆分后 discoverability 下降」（inventory `:71` 登记的代价）。
2. **guides 作为可拉取的运行时文档面**：`action:"guide"` + 11 个 topic（`subagent-guide.js:4-16`；读安装包文件 `:30-40`）—— 拆工具后仍需要一份跨工具协议索引，可保留一个 `*_guide` 工具而不在每个 description 复制长篇政策（对应 inventory `:144` 原则）。
3. **特性组一次性同时删 action + param**：`disabled-features.js:8-40` —— 拆成 N 工具后，等价能力是「按组卸载工具」，比逐 action 开关更干净。
4. **child-safe 的「读动作白名单 + 写动作显式拒绝」二分**：`fanout-child.js:210,218-219` + `subagent-executor.js:113-114` —— 与本仓按 owner 拆工具（父层/child 层）方向同构，可直接借用其集合式判定而非散点 if。
5. **authority policy 三态 `auto/confirm/forbid` 且无 UI 时 fail closed**：`policy/authority.js:1-20` + `subagent-executor.js:6222-6233` —— 每个独立工具仍需这一层，不依赖 description。
6. **能力自述走 RPC `ping.capabilities`，而非塞进工具描述**：`rpc.js:315-345` —— 拆分后「本版本支持哪些动作」应由程序面声明，避免 description 与实现漂移。
7. **激活器模式（loader）**：`tool-activation.js:77-114` —— 若拆分导致工具数上升，upstream 的「小 loader 换取大 schema」是控制 prompt 成本的一种参考（但本仓当前膜掉 `subagents_enable`，引入需显式决策）。
8. **RPC 层 allowlist 远小于模型层**：`rpc.js:21-29` —— 与本仓 `verify-package.ts`/contract 的窄接口原则一致，可作拆分后程序面的分层模板。

### 6.2 不能作为反转依据的上游事实（明确登记）

- 上游把 60 个动作塞进单 `subagent` 工具（§2.1、`schemas.js:138-258` 全 Optional、无 required、互斥只靠运行时），是**它自己的成本**：description 已膨胀到需要 `toolDescriptionMode: full|compact|custom` 与外置 `subagent-tool-description.md` 来治（`tool-description.js:5,73-81,112-146,163-183`；`docs/configuration.md:103-110`）。它证明「单工具会失控」，不证明「单工具更优」。
- 上游 9 个 RPC method（`rpc.js:20`）是**程序通道**，不是模型工具面；不能引用它论证「每操作独立 tool」或反驳它。
- fleet 是只读投影（§3），不构成「一个工具管所有观测」的模型面先例。
- `bg_wait` 未标 `model-only` 这一事实只影响 `ctx.executeTool()` 可达性（宿主 `docs/extensions.md:152-164`），与本仓工具粒度决策无关。
- 上游 `contact_supervisor` 的 `reason` 三值是请求语义枚举，非「多操作复用一工具」，与既有登记的「不属于拆分对象」一致（inventory `:134`）。

---

## 7. 精确文案 / promptGuidelines / return guidance 的位置

| 内容 | 位置 (file:line) | 说明 |
|---|---|---|
| `subagent` description 组装 | `UP/src/extension/tool-description.js:163-183`（入口），`index.js:643` 注入 | `toolDescriptionMode` undefined → `defaultDescription`（`:35`）；`full` → `fullDescription`（`:43-51`）；`custom` → 读 `.pi/subagent-tool-description.md` 或 `agentDir/subagent-tool-description.md`（`:5,82-88,112-146`），且**强制回贴 safety 段**（`:151-158`）；`toolDescriptionMode` 解析 `:73-81` |
| safety 段（授权/失败恢复/异步/fork-resume 政策） | `:12-21`；常量 `AGENT_SELECTION_GUIDANCE:7`、`SUBAGENT_FAILURE_RECOVERY_GUIDANCE:8` | 唯一不可被 custom 描述删除的块 |
| 执行合同段 | 脚本模式 `:22-28`；结构化模式 `:29-34` | 由 `disabledFeatures("workflow-scripts")` 二选一（`:35`） |
| 管理动作发现索引 | `managementDiscovery` `:36-42` | 按特性组裁剪文案 |
| `promptSnippet` | `SUBAGENT_TOOL_PROMPT_SNIPPET:52` / 结构化变体 `:53`；装配 `buildSubagentToolPromptMetadata:65-72`；注入 `index.js:644` | **仅在 `config.toolDescriptionMode === undefined` 时注入**（`:66-67`）；本仓工具自带 snippet（`extension.ts:1582`、`workspace/tool.ts:65`、`supervisor-adapter.ts:62`） |
| `promptGuidelines` | `SUBAGENT_TOOL_PROMPT_GUIDELINES:54-56`（当前 1 条）；装配 `:70` | 上游只有 1 条委派授权条款；本仓为 3 条 + 2 条 + 2 条（`extension.ts:1583-1587`、`workspace/tool.ts:66-70`、`supervisor-adapter.ts:63-66`） |
| `subagents_enable` 文案 | `tool-activation.js:81`（description）、`:82`（snippet）、回执 `:109` | 回执含「下一步再调 `subagent({action:"list",capabilities:true})`」与 `--exclude-tools` 逃生门 |
| `bg_wait` 文案 | `wait-tool.js:5-16`（root/child 两分支在 `:7`，配置禁用尾巴在 `:16`） | |
| `contact_supervisor` 文案 | `native-supervisor-channel.js:186`（单行 description）；无 promptSnippet/promptGuidelines | 子侧「何时上报」不在工具文案，而在 runtime prompt 边界块与 agent 正文 |
| 父侧 supervisor 回执内嵌引导 | `native-supervisor-channel.js:440-446`（`Reply with:` 在 `:444`；`Live guidance: subagent({action:"steer"...})` 在 `:445`）；`supervisorReplyHint` `UP/src/intercom/supervisor-ui.js:10-12` | **return guidance 的模型面主要落点**：把「回复后还需 steer」写进结果文本 |
| async 启动回执引导（return guidance） | `UP/src/runs/background/async-execution.js:134-150`（interactive 与非 interactive 两套） | 「返回控制权、勿 sleep/轮询、status 仅一次性」在**回执**而非 description |
| 控制失败恢复引导 | `UP/src/runs/shared/subagent-control.js:212` | steer/interrupt 失败后的处置顺序 |
| fanout child 工具文案 | `fanout-child.js:216-219` | allowed/blocked 动作直接写进 description |
| 参数级 description（真实 source schema） | `UP/src/extension/schemas.js:138-258`（TypeBox）；裁剪嵌套描述只保留顶层 `:7-32` | **注意**：嵌套 object 的 `description` 被 `pruneNestedDescriptions` 剥掉（`:9-26`），模型只看到顶层字段说明 —— 深层形状必须靠 `guide topic tool-reference`（`docs/tool-reference.md:68-117`） |
| 文档型权威面 | `UP/docs/tool-reference.md`（`:180` 管理动作、`:287` 状态/控制、`:313` status、`:323` command、`:348` resume、`:358` stop、`:370` steer、`:382+` acceptance）；`docs/extension-api.md:96-152` RPC；`docs/configuration.md:83-98` 激活、`:119` disabledFeatures | 上游真实 source schema 是 **TypeBox（JS，`schemas.js`）**，不是 TypeScript；本仓三个工具的 parameters 是**手写 JSON Schema 字面量**（`extension.ts:54-113`、`workspace/tool.ts:25-26`、`supervisor-adapter.ts:1-11`），无 TypeBox。`.d.ts` 只是类型投影，不构成运行时 schema 源 |

---

## 8. 现场核对命令（本次实际执行）

```bash
# 版本与依赖 pin
grep -n '"version"' .../pi-subagents/package.json            # :4 = 0.75.0
grep -n '"pi-subagents":' packages/pi-subagents-enhanced/package.json  # :39 = 0.75.0
# 全量注册点
grep -rn "registerTool" UP/src index.js *.mjs | grep -v "\.map:"
# 动作枚举与分派
grep -n "SUBAGENT_ACTIONS" UP/src/shared/types.js            # :129（60 项）
grep -n 'action === "' UP/src/runs/foreground/subagent-executor.js
# 曝光
grep -rn "exposure" UP/src | grep -v "\.map:"                # 仅 model-only / direct / hidden，无 deferred
grep -rn "MODEL_ONLY_TOOL = " UP/src/shared/extension-context.js  # :7
# RPC 面
grep -n "SUBAGENT_RPC_METHODS\|SUBAGENT_RPC_MANAGEMENT_ACTIONS" UP/src/extension/rpc.js  # :20, :21
# 本仓膜与自注册
grep -n "registerTool\|SUPERVISOR_TOOL_NAME\|ALLOWED_REGISTRATIONS" packages/.../runtime-membrane.ts  # :1, :5, :175, :187
grep -n "pi.registerTool" packages/.../src/subagent-dispatch/extension.ts  # :1657, :1658, :1690
```

---

## 9. Unknown / 未验证清单（不得当结论使用）

1. **本仓当前 child 工具实际声明集合未现场读取**：`pi/extensions/subagent/config.json` 的 `childToolCeiling` 未读取（避免读取 settings 类文件）。仓内既有记载 `docs/research/2026-10-15-bash-async-agent-guidance.md:43` 称该文件不含 `childToolCeiling`（即 ceiling 不注册），本次未复核 → **unknown**。
2. `subagents_enable` 的 `toolActivation` 实际生效模式取决于运行时 `config`；本仓侧该路径已被膜完全阻断，故对模型可见性无影响（`runtime-membrane.ts:175-186`）。
3. `watchdog_diff` 在本仓是否进入任何 child 的 `requiredTools` 未现场核对 → **unknown**。
4. 未运行任何会话/Host，因此「实际 `getAllTools()` 输出」未取证；本表是静态注册点 + 膜逻辑推导。
5. 上游 `intercom`（pi-intercom 包）未安装于本仓 `node_modules`（`ls | grep -i intercom` 无匹配）→ `docs/tool-reference.md:98` 的 `toolTimeoutMs` 豁免名单里提到的 `intercom` 在本环境无对象；上游 `native-supervisor-channel.js:522` 的「不覆盖 pi-intercom」文案也无竞争对象。
6. Herdr/Ghostty inspector 与 `project.*` 依赖外部可执行程序；本次未核对可用性，其工具曝光条件仅按代码路径描述。
7. 本文不含对上游实现的修改，也不含上游最新版本对比。
