# subagent_run_resume 可选模型覆盖：Pi 1.4.0 / pi-subagents 0.80.0 诊断与后续实现合同

日期：2026-10-27。范围：只读源码诊断与本报告；没有实施模型覆盖。唯一写入路径为本文件。

**用户范围决策（2026-10-27）：** 用户已明确决定“既然 pi-subagents resume 不支持换模型，那我们也不支持”。模型覆盖需求撤回，增强层保持不提供 `model`、沿用原模型；不进行上游改造或派生发行。下文 §6–§7 的候选实现合同仅保留为调查背景，不是获准实施的任务，也不是 Goal 计划的缺项。

## 1. 结论与证据边界

**当前原生不支持 resume 换模。只在 enhanced operation-tools、rpc-client、control 或 compat 增加字段，不能让新 runner 使用指定模型。Pi 1.4 SDK 本身支持打开旧 session 时显式选择新模型；阻断位于 pi-subagents 0.80 的恢复协议和启动材料组装。**

精确结论：

1. 当前独立 `subagent_run_resume` 的 schema、allowedKeys 和 description 都明确不提供模型覆盖。正常工具入口会拒绝 `model`，不是已实现但隐藏的能力。
2. typed `rpc.resume(params, options)` 无模型白名单，只透传 params。直接从这层传 `model`，upstream `resumeParams()` 会静默剥离它；绕过 RPC 进入 `resumeAsyncRun()`，又会明确拒绝 `params.model !== undefined`。
3. 新 runner 的模型目前来自旧 `recoveryDescriptor.model ?? target.model`，后续成为新 config 的 `steps[0].model`。新 runner 打开原 session 文件，再把该模型作为 SDK 显式 `model` 传入；旧 session 不会反向覆盖这个显式参数。
4. 模型覆盖需先具备 upstream 可审查的新能力，或批准受控源码补丁的发行方式，再接 enhanced 公共边界。不能把“改 schema”“返回 requestedModel”“模型自报身份”“同一个 sessionFile”当成真实换模证明。
5. managed coding 的新 PID 授权、合法 resume intent 和 workspace/queue 重绑是独立前置条件。模型覆盖必须复用正在修复的生命周期链；不能用换模绕过该链，也不能要求其并行执行者猜字段扩 scope。

本报告中的“支持”分成两层：静态源码证明 SDK 能表达该行为；产品功能仍未实现、未进行真实新 runner/provider 验收。本次没有启动 Host/provider、发送消息、调用 run 控制或 workspace 处置工具，没有安装依赖，没有读取本机 models/auth/凭据/证书，也没有读取私有 grant、token 或整份环境。

适用规范已核对：根 `AGENTS.md`、`pi/AGENTS_SHARED.md`、package `AGENTS.md`。相关 Pi 文档已完整读取 `extensions.md`、`models.md`、`models-configuration.md`、`sdk.md`、`sessions.md`、`session-format.md`，以及必要交叉引用 `message-types.md`、`configuration.md`、`settings.md`、`how-pi-works.md`、`cli-integration.md`、`custom-provider.md`、`virtual-models.md`、`providers.md`、`security.md`；同时读取 SDK models/sessions/extensions 示例和实际导出声明，未运行这些示例。package 的“固定 0.79.2”文字已过时；以 [enhanced manifest](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/package.json:39)、[安装 upstream manifest](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/package.json:4)、[Pi manifest](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/package.json:3) 为准，实际为 **pi-subagents 0.80.0 / Pi 1.4.0**。`compat/pi-subagents-0.75.ts` 是历史文件名，不是运行版本。

## 2. 当前入口、参数与首个丢失点

以下 `H` 指 `packages/pi-subagents-enhanced/src/subagent-dispatch/`；`U` 指 `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/`；`P` 指 `node_modules/@earendil-works/pi-coding-agent/dist/core/`。行号是本轮读取快照，后续并行改动可能使 enhanced 行号移动。

| 层 | 现场证据 | 对模型覆盖的实际行为 |
| --- | --- | --- |
| 独立工具 schema | [operation-tools.ts:140](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:140) | 单 object 根、`additionalProperties:false`、必填 message；字段为 id/runId/dir/index/message/output/outputMode，没有 model/modelId/provider |
| 独立工具描述与白名单 | [operation-tools.ts:275](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:275) | description 明说“不提供模型换模”；allowedKeys 在 :285 同样不含这三个字段 |
| 工具 direct raw 调用 | [operation-tools.ts:340](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:340) | 未知字段返回 `INVALID_DISPATCH`，keypath 为相应字段，回调尚未执行；仅改 schema 还会被此处拒绝 |
| enhanced control | [extension.ts:1521](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1521) 的 `executeControl()`；后续 `const {action,...params}`、`rpc[action](params)` | resume 检查非空 message；当前没有 resume 模型解析。新 managedResume 接线只处理身份/绑定，不代表模型支持 |
| typed RPC client | [rpc-client.ts:299](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts:299) | `resume(params,options) -> call("resume",params,options)`；没有声明或校验模型专属字段；第二个 options 是 requestId/diagnostic 等本地调用选项，不是恢复模型选项 |
| upstream RPC 入口 | [rpc.js:640](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/rpc.js:640) | `resumeParams(request.params)` 后 `executeChecked()` |
| upstream `resumeParams` | [rpc.js:425](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/rpc.js:425) | 只构造 action、target、trim 后 message、字符串 output 及 file-only；不构造 model/modelId/provider。`assertRecordParams()` 只检查对象形状，不先拒绝这类未知键，因此直接 typed RPC 的这些键在此无信号丢失 |
| upstream 共享 schema | [schemas.js:247](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/schemas.js:247)、`:261` 的 `SubagentFlatParams` | 共享 flat/schema 已有 optional model，顶层模型工具也复用它；没有 resume 专属 modelId/provider。这只是通用参数形状，不能覆盖下述 resumeParams 的过滤及执行器拒绝 |
| upstream 直连执行器 | [subagent-executor.js:1597](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:1597) | 明确返回错误：`action='resume' reuses the persisted child model and does not accept a model override.` |

**首偏离点须按实际入口区分**：独立工具是 schema/direct raw 白名单拒绝；绕过独立工具直接 typed RPC 是 upstream `resumeParams()` 丢失；直连执行器是显式拒绝。不能把历史“公共合并 schema 接受 model”的缺陷直接描述成当前独立工具仍然接受。

upstream ping 的 [rpc.js:309](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/rpc.js:309) 只声明 `resume:true`，没有 resumeModelOverride 能力；这证明能调用 resume，不证明能换模。当前公开 exports 在 upstream package manifest 中包含 root、agents、preflight、delegation、control-channel 等；没有公开的 `resume(options:{model})` 或公开的恢复 descriptor 修改接口。`control-channel.d.ts:1` 只导出 requestAsyncStop；`delegation.d.ts:20` 的 model 属于新 delegation 请求，不是 resume；`preflight.d.ts:17` 是 launch 解析，不会自行执行恢复。

旁支合同差异：独立 resume schema 保留 `output:false`，但当前 upstream RPC `resumeParams():432` 对非 undefined、非字符串 output 报错。现有 operation 单测只证明 schema/factory 可达，不证明这个值跨 RPC 可达。本任务不修它，也不把它作为模型覆盖的 fallback。

## 3. 真实恢复顺序：descriptor、step、lease、runner、session、model

1. **解析权威恢复目标。** `U/runs/foreground/subagent-executor.js:1543` 的 `resolveRequestedResumeTarget()` 区分 async、foreground、nested。async 最终进入 [async-resume.js:481](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-resume.js:481) 的 `resolveAsyncResumeTarget()`：解析 run 位置、reconcile、读取 status/result/recovery descriptor，校验当前父 session ownership、descriptor.sourceRunId、状态和 child index。
2. **选择旧会话与合法 cwd。** `async-resume.js:596` 从选中 step/result 取 sessionFile；`:460` 验证文件，`:468` 验证 cwd。`:602` 的 `stepModel` 优先级为 `statusStep.launchModel ?? statusStep.model ?? resultStep.model ?? singleResult.model`，thinking 在 :603 读取。`:611` 优先 retained managed-worktree cwd，再取 status/result/descriptor cwd；返回 `kind:"revive"`。target.model 是旧启动事实，当前代码从不读取调用方 model 来覆盖它。
3. **恢复工具与扩展合同。** `subagent-executor.js:1655` 取得 recoveryDescriptor；[async-resume.js:634](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-resume.js:634) 的 `applySteeringRecoveryAgentConfig()` 恢复 descriptor.model、modelProvider、thinking、tools/excludeTools、extensions、systemPrompt、继承策略、launcher 等。不能只替换 agent profile 或临时注册新 agent 来“间接换模”，这会改掉恢复合同。
4. **生成新 run 与启动材料。** `subagent-executor.js:1882` 生成新 runId，并 transfer/acquire async capacity；`:1951` 传入原 sessionFile 和新的 revivalLease `{sessionFile,runId,sourceRunId,parentSessionId}`。关键启动参数在 [subagent-executor.js:1959](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:1959)：`modelOverride: recoveryDescriptor?.model ?? target.model`，thinking 同样优先 descriptor；旧 modelOrigin/modelOverrideFromParent 也会恢复。
5. **解析并封存新模型。** [async-execution.js:1695](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-execution.js:1695) 的 `executeAsyncSingle()` 消费 modelOverride、modelOrigin 和当前可用模型元数据，执行 model scope、thinking ceiling 校验；`:1770` 再解析 selectedModel；`:1806` 重新计算 definition/launchContractDigest；`:1830` 起写新 recovery descriptor；`:1920` 将 selectedModel 写入新 runner config 的 `steps[0].model`，`:2007` 转交 revivalLease。
6. **新进程持有原 session 的写 lease 后执行。** [subagent-runner-bootstrap.js:103](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/subagent-runner-bootstrap.js:103) 校验 config；`:135` 起 acquireSessionLease，执行 ready → ack → acknowledged → confirm → confirmed → proceed；`:169` 动态加载 `subagent-runner.js`。父侧完成启动后 [async-execution.js:2091](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-execution.js:2091) 发布 async-started，带新 id/PID/asyncDir。父事件与 child 扩展加载存在调度竞争，不能把事件到达顺序当作新 PID 已授权的保证。
7. **runner 使用新 config 的 step.model。** [subagent-runner.js:772](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/subagent-runner.js:772) 为 `candidate = step.model`；`:827` 调用 `buildRunnerChildLaunch()`；[runner-child-launch.js:22](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/runner-child-launch.js:22) 同时传入旧 sessionFile 和 candidate model。`child-launch.js:64` 的 childStorage 对显式 sessionFile 返回 `kind:"file"`，没有因此新建对话。
8. **扩展先于打开 session。** [child-session.js:442](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/shared/child-session.js:442) `loader.reload()` 等待 async factories，拒绝 required load errors，注册/继承 provider；`:462` 调用 `SessionManager.open(launch.storage.sessionFile,undefined,launch.cwd)`；`:473` 通过 Pi 公开 `resolveCliModel({cliModel:launch.model,modelRuntime})` 解析模型，失败直接 throw；`:478` 调用 `createAgentSession({model:resolvedModel.model,...sessionManager})`，`:496` 才 bindExtensions。
9. **Pi SDK 显式模型优先，旧消息保留。** [sdk.js:84](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:84) 构建旧 branch context；`:87` 先取 options.model，只有 `!model && hasExistingSession` 才在 :93 恢复旧会话模型，仍无模型才进入 :103 默认选择。`:253` 的 Agent 初始状态使用该 model 和 `existingSession.messages`。因此“打开旧 session 必然覆盖新模型”不成立。公开 [SessionManager.open:1326](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1326) 支持 cwdOverride，并打开原文件。
10. **首次请求事实。** `U/runs/background/run-child-session.js:569` 由现有 factory 创建，`:618` prompt；Pi `sdk.js:261` 的 streamFn 用选定 model 进入 `modelRuntime.streamSimple()`，provider hooks 在请求路径生效。这里才到达真实模型请求，之前的返回参数/启动状态均不是 provider 已使用新模型的证据。

本轮搜索安装源码 `resumeData` 没有匹配。当前对象名称是 target/recoveryDescriptor、新 config.steps；不能按旧版本记忆虚构 `resumeData.step.model` 接口。若只在上层临时写一个 model，**首个强制回旧点是 :1959 的 descriptor 优先级**；若仅改 :1959 却保留旧 modelOrigin/modelOverrideFromParent，还可能被归为 inherited，跳过主模型校验。正确实现必须在恢复事实完成校验后、计算新 launch digest 与写 config 之前，明确选定显式 override，并同步设置 explicit origin/取消旧 inherited 标记。之后 runner 的 step.model 是选定值的载体，不是第二次读取旧 step 的覆盖点。

“未填保留旧模型”的准确含义是维持上述现有优先级，不重新调用 start 的 profile 默认选择。旧 descriptor 或 launchModel 优先于可能被 observed response 改写的 status.model；若某个老工件缺少全部模型事实，SDK 才可能进入 session/default 解析分支，不能无证据声称每种历史材料都保证同一模型。新增覆盖能力不应改动未传 model 分支，也不能在显式覆盖失败时落回旧模型或 SDK 默认。

## 4. v1 状态与执行种类边界

下表是建议的新增覆盖合同；当前所有覆盖组合均未实现。

| 目标 | 当前原生恢复行为 | 模型覆盖 v1 应支持的边界 |
| --- | --- | --- |
| paused/completed/failed 的 native Pi child，有完整 sessionFile、合法 cwd 与恢复身份 | 新 run、新 runner；复用旧 session 文件 | 支持显式 model；进入同一个 resume/lease/runner 链 |
| running run 中明确选中的 paused/completed/failed child | async resolver 可解析终态 child；多 child 必须指定 index | 仅在选定 child 无活跃 writer、权威恢复身份完整且新能力能保持原合同的情况下支持；不能只依据顶层 running 一概放行 |
| 当前选中 child 仍 running/live | `subagent-executor.js:1625` 拒绝普通 async resume，提示 steer；live-nested 有独立投递路径 | 覆盖必须在任何消息投递/spawn 前拒绝；不能先 steer 再声称换模，也不暗中 interrupt/stop |
| pending/queued/stopping/unknown、stopped、缺会话或 cwd 失效 | stopped/pending 有明确拒绝；其他材料须按解析结果判断 | 覆盖 v1 在 spawn 前 fail closed；不新增推断或 fresh start fallback |
| external-cli / external-job / pane remote | external-cli 在 :1688 拒绝；external-job 在 :1709 另走 follow-up | 不纳入 native Pi 模型覆盖 v1；单独 runner/provider 协议未经证明不能宣称支持 |
| generic，无 managed workspace | 原生恢复本身不要求 enhanced coding workspace 绑定 | 模型准入与恢复一致；仍保留现有 generic 新进程授权/工具边界，不能把 generic 当绕过身份的方式 |
| coding / generic 带 managed workspace | 除 native session 恢复外，还要合法 owner、resume intent、workspace/queue 绑定 | 只有生命周期修复证明该 owner kind 可恢复才开放；coding 的绑定未闭合则拒绝，不能降级 generic |
| nested / foreground retained child / workflow root 或 chain attachment | 有不同 resolver、恢复/attach 分支；不等同 standalone async revive | 新能力第一版限定可证明的 standalone async native child；没有逐分支覆盖证据的场景显式不支持，不套用普通 resume 成功推断 |

上述限制应由权威目标解析结果实施，不能靠用户传来的 state/profile 字符串。当前独立工具未强制 resume.index；可继续沿用唯一 child 的上游选择语义，但多 child/歧义必须拒绝，控制面授权目标必须与实际投递目标完全相同。id/runId 冲突、dir/前缀定位若无法在同一 authority 下证明 canonical identity，也应在 spawn 前拒绝，不能借用 steer 的别名放行。

## 5. 模型解析、profile、registry、thinking 与跨 provider

### 5.1 复用显式 start 的真实规则

[extension.ts:796](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:796) 的 `resolveSpawnModel()` 是 coding/generic start 共用解析入口，在 :1060 / :1281 调用。它先通过 Host discover 找已准入 agent，再取 `ctx.modelRegistry.getAvailable()`，生成 profile 当前可用候选，最后调用 [model-selection.ts:153](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts:153) 的 `resolveModelSelection()`。

精确规则：

- 显式 `provider/id`：精确匹配当前 available catalog；受 blockedProviders 约束；现有 qualified 分支**没有要求目标必须在 profile.models 内**。不能把“全限定名被 profile 严格 allowlist”写成已有事实。
- 裸 id：profile 有声明时，仅在当前可用的有序候选中精确匹配 `/` 后完整 id；不模糊匹配，不接受昵称/子串；无 profile 声明才按全限定名排序从全局 available catalog 匹配，并返回既有 `MODEL_MATCH_USED_GLOBAL_CATALOG` 警告。
- `resolveModelCandidates():114` 在 profile 声明全不可用时抛错；过滤 blacklist；`assertDispatchModelApi():4` 拒绝缺 api 和 `pi-virtual`。显式选择不增加候选、不自动迭代其他候选。
- 显式 start 的前置过程还会先解析 profile 候选；因此即使传 qualified，profile 候选全不可用时也可能先被阻断。后续如直接只调用 selector，会绕过这一现有步骤，应复用完整准入过程。
- 上游另有 `modelScope`、capability/thinking ceilings；本地精确解析通过不替代 upstream scope。`U/runs/shared/model-resolution.js:285` 对违规 scope 报错，`async-execution.js:1695` 执行该约束。

Pi 1.4 两种 registry API 必须区分：[ModelRegistry.getAvailable():21](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:21) 是 extension 同步 facade，返回 runtime 已有 available snapshot；`ModelRuntime.getAvailable()` 是异步可用性检查（声明在 `P/model-runtime.d.ts:78`），不是同一接口。后续实现应消费当前 Host 注入的 snapshot；本次没有调用这两种实际 registry，也没有创建 ModelRuntime、执行 refresh/checkAuth 或请求 provider，所以**没有任何当前模型真实可用性结论**。

只查看了 `pi/agents/{delegate,executor,reviewer}.md` 的 name/models/thinking 非敏感元数据；它证明 profile 声明，不证明本机可用。当前 delegate 声明三个候选、thinking high；executor 两个、medium；reviewer 四个、xhigh。列表无需写入任何本机 models/settings，更不能为 resume 临时拓宽它。

建议 v1 与显式 start 保持同一 qualified/bare 规则，用户请求什么只解析什么；若产品希望 qualified 也强制 profile 成员，必须另行明确该语义，不能借 resume 修复悄悄收紧或放宽 start。只有 `model` 一个公开选择器，不新增 modelId/provider/fallbackModels/候选列表字段，不接受 `inherit` 或 `:thinking` 作为新隐式语法；模型 id 自身的斜杠/冒号须按当前 exact parser 处理。

### 5.2 thinking 的兼容策略

旧值来自 descriptor.thinking、target.thinking 或旧 model suffix（`U/shared/model-info.js:22` 的 resolveEffectiveThinking；`async-execution.js:1730` 重新附 suffix）。新模型的 SDK 初始化会 [sdk.js:121](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:121) 恢复 thinking，再在 :143 `clampThinkingLevel()`；无 reasoning 的模型可能降到 off。因此“只改 model，thinking 自然完全保留”也不成立。

建议新增覆盖第一版采取可审查的保守合同：**保留旧 effective thinking；新模型不支持或超出既有 ceiling，spawn 前返回明确不兼容错误。** 不默默 clamp、不自动改成该模型默认、不添加第二个 thinking 选择器。可复用 Pi AI 根公开 `getSupportedThinkingLevels()` / `clampThinkingLevel()`（`node_modules/@earendil-works/pi-ai/dist/index.d.ts:20`、`models.d.ts:271`），用“clamp 后是否相等”或支持列表验证，而不是复制 provider 能力表。原 thinking 材料无法确定时不猜当前 profile 默认，覆盖分支 blocked；未传 model 的旧行为仍保持。该策略是本报告建议的实现合同，尚未落地。

### 5.3 跨 provider 会话重放的可行性与限制

Pi 可以在同一 session 上切模型。源码并不要求整个对话只能来自一个 provider。`P/sdk.js:258` 直接载入旧 messages；[Pi AI transform-messages.js:65](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:65) 为不同 provider/api/model 清除旧 thinking blocks、text signatures、tool thoughtSignature，并按目标 API 规范化 toolCallId 及对应 toolResult。`:38` 对不支持图像的模型投影为 placeholder，`:176` 跳过 error/aborted assistant。它生成请求投影，不重写原 session 历史。

工具声明由 transcript system messages 保存（Pi `docs/session-format.md` / `docs/message-types.md`）；`pi-ai/dist/utils/transcript.js` 提供当前工具/system 折叠。恢复的当前工具权限仍由 descriptor、tool plan 和 capability ceiling 决定；不能为新 provider 添加工具、删除边界，或把历史 tool declaration 当作可执行授权。跨 provider 的 replay 转换来自已安装 Pi，不需要本功能新增兼容分支。

限制：这些是框架级代码证据，不能保证任意自定义 endpoint 接受任意旧对话、图像、上下文长度和工具 schema。更小 contextWindow 可能触发既有 compaction；不支持图像的模型会有原生请求投影损失，不能承诺逐字节发送相同上下文。`docs/models.md` 也明确历史图像不会因切模型重编码。合法跨 provider 目标应仍是当前 registry 已准入的物理 chat 模型，支持所需工具及输入；未知协议兼容性、缺少关键输入能力或不能核对的材料，应在覆盖准入时明确拒绝/blocked，不能靠本功能新增 provider compat/fallback。请求实际失败后保留事实，不自行选择另一 provider。

## 6. 原生缺口与最小可审查实现方案

### 6.1 不能只靠 enhanced 包内部完成

当前 compat 只从 upstream root、`pi-subagents/agents` 公开导出注册（[compat:11](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts:11)），没有现成可插入模型覆盖的 resume hook。修改 operation-tools/rpc-client/control 无法穿过 upstream 丢失与拒绝点；注册临时 provider/agent、修改旧 descriptor/status/session 文件、注入环境变量、把 message 写成“换模”，均不是合法实现。

首选：在 upstream **受控源码 checkout** 增加 resume model 能力，发布可固定版本，再由 enhanced 升级依赖。当前任务没有该 checkout 写授权，也没有发行授权；本报告不改上游、不改 node_modules、不安装。若只能受控 patch，需先明确源码归属、补丁基线/hash、可审查产物路径及发行方式；不能在运行时改 node_modules 或 monkeypatch 内部方法。

发行门禁也是真实缺口：[verify-package.ts:128](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/scripts/verify-package.ts:128) 将安装 upstream 与官方 npm 指定版本逐文件 hash 比较，任意本地 patch 都会失败；setup-runtime-deps.ts 还固定安装 0.80.0。不能只放一份 patch 文件而仍宣称 stock 0.80.0 完整通过控制检查，更不能直接关闭比较。受控补丁路线需要单独批准“如何构建并核对完整派生 payload”，与模型 schema 不是同一件事。

### 6.2 upstream 源码任务合同（须先取得实际源码写路径）

目标：保持一个现有 native runner/恢复执行器；为 standalone async native revive 提供 `model?: string`，未填执行原分支，显式填写在 spawn 前校验并真实进入新 step.model。

建议明确接口（以下是新增合同，不是当前存在的 API）：

```ts
// 原有 RPC resume params 增加唯一可选选择器；target/output 字段沿既有合同。
type ResumeModelInput = { model?: string };
// ping 新增显式版本能力；旧 resume:true 不足以承诺此行为。
type ResumeModelOverrideCapability = {
  version: 1;
  mode: "async-native-revive";
  preservesSessionFile: true;
};
```

最小 upstream-relative WritePaths 与职责：

| 路径/函数 | 必须完成的改动 |
| --- | --- |
| `src/extension/rpc.ts` / `resumeParams(params)` / `pingData()` | 校验 model 是非空字符串并保留；拒绝未知 modelId/provider 替代键；暴露上述新 capability；output 既有问题不混修 |
| `src/runs/foreground/subagent-executor.ts` / `resumeAsyncRun(input)` | 替换无条件 model 拒绝；先解析 canonical target 并拒绝不支持状态/runner；在 capacity、spawn、消息投递前核对覆盖准入；构造显式 modelOverride，优先于旧 descriptor/target；同步 `modelOrigin:"explicit"`、`modelOverrideFromParent:false`；不修改旧 descriptor |
| `src/runs/background/async-execution.ts` / `executeAsyncSingle()` | 核对显式模型精确命中、scope/thinking/工具兼容；重新生成新 launch digest、新 descriptor、新 step.model；禁止旧 inherited 标记跳过验证；尽可能复用现有流程，无需新增执行器 |
| `src/extension/schemas.ts` / `SubagentParamProperties` / `SubagentFlatParams` | 安装生成物 `schemas.js:247` 已有 model，无需为了“允许 model”重复加字段；仅收紧新增 resume 合同所需校验，RPC 与直连保持一致；如需参数类型同步，沿同源类型定义修改 |
| `docs/tool-reference.md`、RPC 文档、CHANGELOG | 改为“默认保留，显式覆盖仅受支持 revive 场景”；声明错误状态和能力版本 |

安装包当前只提供上述 `.js/.d.ts` 与 sourcemap；实际 upstream 源 checkout 应先定位 `.ts` 生成源，不直接把 node_modules JS 当可写生产源。若其真实结构不同，先更新精确 WritePaths，经主管确认后实施，不能猜文件名。当前 `async-resume` resolver 可以继续只返回旧事实；不必为了覆盖而修改 status/result。新增 model 应由 resume 调用携带，保持旧事实与新意图可区分。

不变量：old sessionFile/cwd、agent、tool/extension/capability ceilings、parent owner、原 dispatch scope/acceptance 都不放宽；new runId/PID/asyncDir/digest 独立建立；显式覆盖失败零 spawn、零 steer、零 workspace 分配/处置；不得重试其他模型。缺少新 capability 时增强层对显式 model 直接拒绝，未填 model 继续旧 resume。

### 6.3 enhanced 后续编码任务的精确候选 WritePaths

这组是可派发范围建议，**本轮没有修改这些文件**；先依赖上一节可消费的新 upstream 版本/受控产物，以及生命周期修复的验收结果。

- `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`：resume schema 增加现有 MODEL_FIELD、allowedKeys 加 model、description/guidelines 明确默认保留/显式覆盖/状态限制；raw 校验与 schema 同步。不扩 steer/start schema。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`：`executeControl()` 的 resume 分支先获得与实际恢复一致的 canonical source agent/child/owner，再只对 `Object.hasOwn(input,"model")` 执行显式 start 同等模型准入；复用/提取 `resolveSpawnModel()` 的显式路径，不能调用会选 profile 默认的无 model 路径。当前没有通用公共 resume-preflight 返回完整 canonical model/session/cwd 合同；若不足，需 upstream 同源准入或现有 Host authority 投影补齐，不能让用户提供 agent/session/cwd。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`：仅在需要提取共用显式准入时做最小改动；保持已有 exact qualified/bare/blacklist/virtual 规则，不新增候选或 fallback。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`：为 resume 参数明确可选 model 类型；能力协商识别新 capability。透传 canonical qualified model；不把 model 塞进 request options。
- `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts`：只封装确需新增的 upstream **公开** API/能力适配；如事件 RPC 已足够可不改；禁止从 enhanced 其他路径深层 import upstream。
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`：仅当需要给 control 注入同一 Host registry/authority/preflight 时接线，复用正在完成的 managedCodingResume，不创建第二 authority 或 runner。
- `packages/pi-subagents-enhanced/package.json`、`packages/pi-subagents-enhanced/package-lock.json`、根 `package-lock.json`、`packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts`、`packages/pi-subagents-enhanced/scripts/verify-package.ts`：只有确定 upstream 新版本/受控发行方案后更新 pin、安装和完整性门禁；不能安装猜测版本。
- `packages/pi-subagents-enhanced/README.md`、`packages/pi-subagents-enhanced/AGENTS.md`：同步支持矩阵与实际依赖版本；不通过改说明冒充实现。

候选内部签名：

```ts
type ExplicitResumeModelRequest = {
  id?: string; runId?: string; dir?: string; index?: number;
  message: string; model?: string; output?: string | false;
  outputMode?: "file-only";
};
// 在 executeControl 内部：target 只能来自 Host/原生 resolver，不接受模型传入。
// 复用当前 start 的 resolver 与当前 ctx.modelRegistry snapshot。
resolveExplicitResumeModel(
  request: ExplicitResumeModelRequest,
  source: { runId: string; agent: string; index: number },
  ctx: ExtensionContext,
): Promise<{ model: string; source: string; requestedModel: string }>;
```

只在 model 属性存在且合法时调用上述显式函数；undefined/null/空白等非法显式值不能静默当未填。解析结果需记录 requested/resolved/effectiveThinking 的公开元数据，来源与旧模型可区分；它只是诊断回执，不充当 actual proof。旧 descriptor 的 modelResponseAliases 保持其既有含义，不为新目标临时增加 alias。

## 7. 生命周期修复依赖与 Goal §4.2/T3 接入

已知生产缺陷详见 [managed coding resume 诊断](/Users/leshi.zhy/pi-config/docs/bugs/2026-10-27-managed-coding-resume-binding.md)。本轮没有重读该现场私有目录，没有重放请求；其旧/新 PID、零 ACK 和 extension identity timeout 是前次报告的证据，不伪装成本轮实测。

本轮直接源码确认：`child-session.js:442` 的 required extension factory 可以早于 SessionManager.open/模型初始化失败；[child-broker-binding.ts:7](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/child-broker-binding.ts:7) 依当前 processBirth 查 receipt/lease/grant；[root-broker-server.ts:384](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:384) 的 registerAuthorizedRun 才创建真实授权，`:676` observeStarted 未授权 run 只 registerFacadeRun。session revival lease 成功不等于 broker execution lease。

并行 delegate `2d23208e-0263-4eca-b1ff-399c5c09a132` 正在修此链。本轮看到 dirty 快照已出现 `createResumeBindingWaiter()` / `managedCodingResume.prepare/register/activate`，Host [subagent-runtime.ts:476](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:476) 会检查 workspace owner、精确 source agent、pending resume intent，随后按新绑定注册并 activate。**这只是进行中源码观察，未审阅或验收其完整正确性，不表示它已经收到或实现模型覆盖需求。** 本轮没有 steer 或控制该任务。

安装源码中的当前 DI 签名位于 `H/extension.ts:1947`（并行快照），模型任务应消费而不复制：

```ts
managedCodingResume?: {
  prepare(input: { sourceRunId: string; ownerState: string; owner: unknown }): Promise<any> | any;
  register(binding: { runId: string; asyncDir: string; sessionId: string;
    pid: number; agentProfile: string }): Promise<void> | void;
  activate(input: { plan: any; resumedRun: { runId: string; asyncDir: string;
    sessionId: string; pid: number; agentProfile: string } }): Promise<unknown> | unknown;
};
```

这里的 `any` 是现场现有签名，不是建议另建宽松模型 API；是否收紧这些类型属于生命周期任务评审。模型任务只在其前方加入准入，沿相同 binding 注入与等待路径执行。

后续先后顺序：

1. 收敛生命周期修复，证明真实新 PID/processBirth 授权及 legal workspace/queue rebind 在 child 使用 coordinator 前完成，回调 Promise 被 await；不能重用旧 runId/grant。
2. 完成 upstream 模型覆盖协议及新 config/digest 语义；其准入在 spawn 前完成，不能先启动再发现不支持。
3. enhanced 显式模型解析 → 原有 resume 调用 → 同一新 PID 授权与 workspace activation → 新引用返回。模型解析不获取 authority；生命周期接线不选择模型。
4. 最后另获真实验证授权，检查新 runner 的首次 provider 请求及 binding 证据。泛化到 coding/generic 必须逐类有事实，不能用 generic 单测证明 coding 绑定。

workspace [service.ts:250](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/service.ts:250) 的 `rebindRunForRecovery(input,{authorizeResumeIntent})` 和 `recovery-resume-contract.ts` 的 ResumedRunIdentity 已足够表达新 run/PID，模型字段不应塞进 owner token、grant 或新授权系统。新模型是执行选择，不是增加 workspace 处置权限。

Goal 当前 v1 [§4.2](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:264) / [T3](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:454) 计划尚未给 `PlanExecutionService.resume` 声明 model。建议未来在该任务合同中明确增加：

```ts
resume(input: {
  previous: PlanRunRef; dispatchKey: string; message: string;
  model?: string;
  ctx: import("@earendil-works/pi-coding-agent").ExtensionToolContext;
  onBound: (ref: PlanRunRef) => Promise<void>;
}): Promise<PlanRunRef>;
```

`model` 原样透明转交同一个 typed resume 闭包，不由 Goal 再解析/选默认、不在通知或重试策略里自动填。`onBound` 仍只在新进程授权及 workspace/queue 重绑完成后 await，返回新 PlanRunRef。`recovery:"typed-resume"` 只表示恢复路径闭合，不自动表示支持覆盖模型；实际 capability 缺失或 model 不兼容仍 blocked。

显式用户换模指令必须进入授权的工具输入/已批准合同；Goal 不根据过载、失败、自报或 profile 排序自主换模。原 dispatch IR [dispatch-ir.ts:101](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts:101) 会把原显式 model 纳入 contractHash；不能在恢复时篡改原 hash 或重写历史合同。模型覆盖作为明确授权的本次恢复执行选择另记 requested/resolved 事实；若原合同明确锁定模型/provider，先按现有合同变化规则取得授权，不能仅凭新增 optional 字段自动放宽。writePaths/acceptance/依赖/profile 始终遵守原任务边界。

计划 §4.3 的 `plan_retry` 当前也没有 model；T3 的透明转发不会凭空使用户可通过 plan_retry 传 model。后续若要从该工具公开换模，需要单独批准其 schema 与调用路径，不能在 T3 内猜字段。T3 当前“原 subagent_* schema 不变”的验收文字也不能与此次新需求混称同时满足，应由父层另派模型能力任务并明确接口版本；本轮不修改 Goal 计划。

## 8. 验证入口、副作用与缺口

本轮实际执行：

```sh
node --test test/subagent-model-selection.test.mjs test/subagent-model-candidates.test.mjs test/subagent-operation-tools.test.mjs test/subagent-dispatch-rpc.test.mjs
```

输出：**tests 44 / pass 44 / fail 0 / skipped 0**，duration 284.772875ms。运行前已读完整四份测试：纯 selector/TypeBox 校验、内存 callback spy 和自建假 event bus；没有 provider、真实 RPC Host、进程控制、workspace 或磁盘 fixture。没有新增/修改测试。通过的断言包含当前“resume 不提供 model”；它是当前合同证据，不是未来模型覆盖验收。

其他既有入口仅列出，未执行：

| 入口 | 价值与副作用 |
| --- | --- |
| `test/subagent-model-selection.integration.mjs` | enhanced 工具/准入 harness，部分使用仓库真实 profile 元数据，其余 RPC、registry、PID 是 mock；不能证明真实模型请求；运行前需继续审计整文件副作用 |
| `test/subagent-ordered-models.test.mjs` | 有序 profile 候选过滤与准入，适合回归未填/显式路径；不证明 resume 实际模型 |
| `test/managed-workspace-resume-intent.integration.mjs` | 临时 repo/worktree、Git mutation 与 queue intents，开头 :16 创建临时 root，:36 等有清理；超出本轮只写报告边界，未运行 |
| `test/subagent-auto-integration-resumed-child.integration.mjs` | 主要是 ended child manual handoff 合同；不能拿它命名推断已验证真实新 child resume |
| `test/subagent-rpc-bridge-observation.integration.mjs` | :95/:176 spawn Pi，写临时 agent config 并使用 deterministic/contact fixture provider；不能当真实 coding/provider 验收，本轮禁止启动 |
| `npm --prefix packages/pi-subagents-enhanced run typecheck` | 静态 `tsc --noEmit`，未来实现需跑；报告无代码修改，未执行也不声称当前并行 dirty 分支 typecheck 通过 |
| `npm --prefix packages/pi-subagents-enhanced run verify:package` | 会 npm pack 官方 upstream、写 npm cache/temp、打包检查；不是纯只读命令，且验证 stock upstream hash；本轮不安装/联网，不执行 |

后续建议的新增覆盖断言需要另获授权，本轮不创建：显式裸 id/qualified、未填保持原模型、非法/不可用/blocked/virtual 值无副作用、live/stopped/外部 runner spawn 前拒绝、thinking 不兼容、跨 provider replay、coding 新 PID 绑定、RPC 保留及 descriptor/step 真正生效。修改既有测试也应在明确编码合同内授权，不能靠把断言改成接受 schema 就宣布能力完成。

真实验收必须使用获授权的指定目标模型；本报告不选当前运行模型。验收至少同时核对：

- 原与新 runId/runnerProcessInstanceId/PID/processBirth、新 source/revivedFrom 关系；同 canonical sessionFile 和合法 cwd、无旧 writer；不能仅凭“新 run”声称新 session 文件。
- requested/resolved 模型、effectiveThinking、新 recovery descriptor 与 step.model、新 launchContractDigest/sourceLaunchContractDigest；这些是启动意图与绑定材料。
- 新 runner 内首次请求前选定的 `session.model.provider/id/api` 及实际 provider 请求模型；只记录非敏感模型身份/关联 ID，禁止保存 headers/auth 或完整请求正文。Pi `before_provider_request` 是 payload hook；provider_stream_event 带 provider/api/model（`sdk.js:238`），但需要响应才会出现。必要的既有 instrumentation 若不足，应先列缺口再申请最小观察点，不能绕到真实请求重放。
- 首个真实 assistant message 的 provider/api/model/responseModel 与请求对应、工具声明合法；自定义 provider 的响应元数据仍需与请求身份交叉核验。现有 `run-child-session.js:405` 只在无 tool call 的 assistant 上做 model 字符串校验，`formatSubagentModelVerificationError()` 不比较 observed provider，还允许既有 response aliases；因此它不是“首次请求 provider 精确一致”的充分证据。
- coding 的 required extension ACK、当前 broker receipt/execution lease 和 workspace/queue activation 完整；任务完成另需 terminal proof，不能以 spawn return 或 exit 0 代替。

本轮真实验证缺口保持明确：没有任一新 runner 的指定新模型首次请求证据；没有当前模型可用性查询；没有跨 provider endpoint 实测；没有并行生命周期修复的最终验收；没有受控 upstream 新版本/补丁发行决策。静态结论不替代这些证据。

## 9. 数据来源分类与停止条件

| 观察 | 分类与依据 | 允许得出的结论 |
| --- | --- | --- |
| 当前独立工具不接受 model；upstream 恢复拒绝/剥离并沿用旧模型 | production 能力缺失，由真实公共入口合同、安装源码参数组装链可直接证明；不是 fixture 异常 | 必须增加真实 upstream 恢复能力，不能仅改 schema |
| 2026-10-14 旧合并工具允许 model 后静默丢弃的历史报告 | 前次记录的 production 契约不一致；其旧工件/actual provider 未在本轮核验 | 只作历史背景，不把旧行号/实际 provider 推到当前独立工具 |
| 2026-10-27 managed coding 身份 timeout | 前次 production 现场报告 + 本轮源码路径；私有 authority 磁盘状态未读取 | 生命周期绑定是前置问题；不能推断 provider 故障或换模可修 |
| 本轮四组测试 | 合法的纯单元 fixture，测试有意构造 registry/event bus | 证明现有本地解析/参数合同；不能证明 production 新 runner/provider 可达 |
| 任意目标 endpoint、缺材料历史 run、并行修复最终效果 | 来源/行为未充分证实 | 保留 unknown/blocked；不得新增兼容、防御或自动 fallback |

需要秘密、真实请求重放、外部 upstream 变更或产品语义决策时，停止该环节。本轮已完成可证部分并提供精确接口建议；后续编码派发必须先填入真实 upstream 源码写路径/发行方案，并显式决定 qualified profile 规则与 thinking 不兼容拒绝策略。没有这些前提时，可以保留既有不带 model 的 resume，但不能公开承诺显式换模可用。

本报告没有修改 production、测试、配置、Goal 计划、footer 或 root 详情 controller；没有 stage/commit。并行工作区的既有 dirty 文件不属于本报告变更。
